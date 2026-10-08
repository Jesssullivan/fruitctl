// SPDX-License-Identifier: MIT
// Explicit developer qualification utility. This is not a broker bootstrapper.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static NSString * const BundleID = @"com.xoxd.fruitctl.host";
static NSString * const Schema = @"fruitctl.launchservices-native-request.v2";
static int RunFD = -1;
static NSString *RunPath;
static struct stat RunIdentity;

static BOOL exactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
    return [value isKindOfClass:NSDictionary.class] && value.count == keys.count &&
        [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}

static BOOL number(id value) {
    return [value isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        isfinite([value doubleValue]);
}

static BOOL pidNumber(id value) {
    if (!number(value)) return NO;
    double pid = [value doubleValue];
    return pid > 1 && pid <= INT_MAX && floor(pid) == pid;
}

static BOOL boolean(id value, BOOL expected) {
    return [value isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() &&
        [value boolValue] == expected;
}

static BOOL hex64(id value) {
    if (![value isKindOfClass:NSString.class] || [value length] != 64) return NO;
    for (NSUInteger i = 0; i < 64; ++i) {
        unichar c = [value characterAtIndex:i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return NO;
    }
    return YES;
}

// Lexical only: the offline branch never resolves paths or touches files.
static BOOL absolutePath(id value) {
    if (![value isKindOfClass:NSString.class] || ![value hasPrefix:@"/"] ||
        [value length] < 2 || [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= PATH_MAX)
        return NO;
    for (NSUInteger i = 0; i < [value length]; ++i) {
        unichar c = [value characterAtIndex:i];
        if (c < 0x20 || c == 0x7f) return NO;
    }
    NSArray *parts = [value componentsSeparatedByString:@"/"];
    for (NSUInteger i = 1; i < parts.count; ++i) {
        if ([parts[i] length] == 0 || [parts[i] isEqual:@"."] || [parts[i] isEqual:@".."]) return NO;
    }
    return YES;
}

static BOOL exactRequest(NSDictionary *r, double now) {
    NSArray *keys = @[@"schema", @"appPath", @"executablePath", @"bundleIdentifier",
        @"arguments", @"oldPid", @"nonce", @"sourceBindingSha256", @"authoritySha256",
        @"issuedAtUnix", @"expiresAtUnix"];
    if (!exactKeys(r, keys) || ![r[@"schema"] isEqual:Schema] || !isfinite(now) ||
        !absolutePath(r[@"appPath"]) || ![r[@"appPath"] hasSuffix:@".app"] ||
        !absolutePath(r[@"executablePath"]) ||
        ![r[@"executablePath"] isEqual:[r[@"appPath"] stringByAppendingPathComponent:@"Contents/MacOS/FruitctlHost"]] ||
        ![r[@"bundleIdentifier"] isEqual:BundleID] ||
        ![r[@"arguments"] isKindOfClass:NSArray.class] || [r[@"arguments"] count] != 0 ||
        !(r[@"oldPid"] == NSNull.null || pidNumber(r[@"oldPid"])) ||
        !hex64(r[@"nonce"]) || !hex64(r[@"sourceBindingSha256"]) || !hex64(r[@"authoritySha256"]) ||
        !number(r[@"issuedAtUnix"]) || !number(r[@"expiresAtUnix"])) return NO;
    double issued = [r[@"issuedAtUnix"] doubleValue], expires = [r[@"expiresAtUnix"] doubleValue];
    return issued > 0 && issued <= now && now < expires && expires > issued && expires - issued <= 10.0;
}

static BOOL exactCompletion(NSDictionary *c, NSDictionary *r, double before, double after) {
    if (!exactKeys(c, @[@"processIdentifier", @"bundleIdentifier", @"bundlePath",
            @"executablePath", @"terminated", @"launchDateUnix"]) ||
        !isfinite(before) || !isfinite(after) || after < before ||
        !pidNumber(c[@"processIdentifier"]) ||
        (r[@"oldPid"] != NSNull.null && [c[@"processIdentifier"] isEqual:r[@"oldPid"]]) ||
        ![c[@"bundleIdentifier"] isEqual:BundleID] || ![c[@"bundlePath"] isEqual:r[@"appPath"]] ||
        ![c[@"executablePath"] isEqual:r[@"executablePath"]] || !boolean(c[@"terminated"], NO) ||
        !number(c[@"launchDateUnix"])) return NO;
    double date = [c[@"launchDateUnix"] doubleValue];
    return date >= before - 1.0 && date <= after + 1.0;
}

static BOOL sameStat(struct stat a, struct stat b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid &&
        a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}

static BOOL canonical(NSString *path) {
    if (!absolutePath(path)) return NO;
    char resolved[PATH_MAX];
    return realpath(path.fileSystemRepresentation, resolved) &&
        [path isEqual:[NSString stringWithUTF8String:resolved]];
}

static BOOL sameRun(void) {
    struct stat current, named;
    return fstat(RunFD, &current) == 0 && lstat(RunPath.fileSystemRepresentation, &named) == 0 &&
        S_ISDIR(current.st_mode) && current.st_dev == RunIdentity.st_dev && current.st_ino == RunIdentity.st_ino &&
        current.st_uid == getuid() && (current.st_mode & 0777) == 0700 &&
        named.st_dev == current.st_dev && named.st_ino == current.st_ino && canonical(RunPath);
}

static NSData *readPrivate(NSString *name) {
    int fd = openat(RunFD, name.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return nil;
    struct stat before, after, named;
    if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_uid != getuid() ||
        (before.st_mode & 0777) != 0600 || before.st_nlink != 1 || before.st_size < 2 || before.st_size > 32768) {
        close(fd); return nil;
    }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t n = read(fd, (char *)data.mutableBytes + offset, data.length - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        offset += (NSUInteger)n;
    }
    BOOL pass = offset == data.length && fstat(fd, &after) == 0 &&
        fstatat(RunFD, name.fileSystemRepresentation, &named, AT_SYMLINK_NOFOLLOW) == 0 &&
        sameStat(before, after) && sameStat(before, named) && sameRun();
    close(fd);
    return pass ? data : nil;
}

static BOOL writeExclusive(NSString *name, NSData *data) {
    if (!data || !sameRun()) return NO;
    int fd = openat(RunFD, name.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return NO;
    NSUInteger offset = 0;
    while (offset < data.length) {
        ssize_t n = write(fd, (const char *)data.bytes + offset, data.length - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        offset += (NSUInteger)n;
    }
    BOOL pass = offset == data.length && fsync(fd) == 0 && sameRun();
    close(fd);
    return pass;
}

static void finish(NSDictionary *result, int status) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
    if (!writeExclusive(@"native-launch-result.json", data)) _exit(74);
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
    _exit(status);
}

static double monotonic(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(74);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

static NSDictionary *changed(NSDictionary *value, NSString *key, id item) {
    NSMutableDictionary *copy = [value mutableCopy]; copy[key] = item; return copy;
}

static int offlineSelfTest(void) {
    // Only Foundation value predicates: no file/PID/console/workspace access.
    NSDictionary *r = @{@"schema":Schema, @"appPath":@"/Volumes/Test Host/Product Name.app",
        @"executablePath":@"/Volumes/Test Host/Product Name.app/Contents/MacOS/FruitctlHost",
        @"bundleIdentifier":BundleID, @"arguments":@[], @"oldPid":@123,
        @"nonce":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
        @"sourceBindingSha256":[@"b" stringByPaddingToLength:64 withString:@"b" startingAtIndex:0],
        @"authoritySha256":[@"c" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0],
        @"issuedAtUnix":@100, @"expiresAtUnix":@108};
    NSDictionary *c = @{@"processIdentifier":@456, @"bundleIdentifier":BundleID,
        @"bundlePath":r[@"appPath"], @"executablePath":r[@"executablePath"],
        @"terminated":@NO, @"launchDateUnix":@105};
    NSUInteger count = 0, failed = 0;
#define EXPECT(label, expression) do { ++count; if (!(expression)) { ++failed; fprintf(stderr, "%s\n", label); } } while (0)
    EXPECT("valid request with spaces", exactRequest(r, 101));
    EXPECT("valid completion", exactCompletion(c, r, 104, 106));
    NSDictionary *other = changed(changed(changed(r, @"appPath", @"/opt/Other Product.app"),
        @"executablePath", @"/opt/Other Product.app/Contents/MacOS/FruitctlHost"), @"oldPid", @789);
    EXPECT("different path and oldPID without retarget", exactRequest(other, 101));
    EXPECT("fresh start", exactRequest(changed(r, @"oldPid", NSNull.null), 101));
    EXPECT("fresh start completion", exactCompletion(c, changed(r, @"oldPid", NSNull.null), 104, 106));
    EXPECT("args refused", !exactRequest(changed(r, @"arguments", @[@"--enable-capture"]), 101));
    EXPECT("argument object refused", !exactRequest(changed(r, @"arguments", @{}), 101));
    EXPECT("unknown request field", !exactRequest(changed(r, @"environment", @{}), 101));
    EXPECT("wrong schema", !exactRequest(changed(r, @"schema", @"future"), 101));
    EXPECT("wrong bundle", !exactRequest(changed(r, @"bundleIdentifier", @"other"), 101));
    EXPECT("relative path", !exactRequest(changed(r, @"appPath", @"Product.app"), 101));
    EXPECT("dot component", !absolutePath(@"/a/./b"));
    EXPECT("parent component", !absolutePath(@"/a/../b"));
    EXPECT("empty component", !absolutePath(@"/a//b"));
    EXPECT("control in path", !absolutePath(@"/a\nb"));
    EXPECT("trailing slash", !absolutePath(@"/a/"));
    EXPECT("nonpath", !absolutePath(@12));
    EXPECT("different executable", !exactRequest(changed(r, @"executablePath", @"/opt/FruitctlHost"), 101));
    EXPECT("non-app", !exactRequest(changed(r, @"appPath", @"/opt/Product"), 101));
    EXPECT("oldPID boolean", !exactRequest(changed(r, @"oldPid", @YES), 101));
    EXPECT("oldPID text", !exactRequest(changed(r, @"oldPid", @"123"), 101));
    EXPECT("oldPID fraction", !exactRequest(changed(r, @"oldPid", @123.5), 101));
    EXPECT("oldPID overflow", !exactRequest(changed(r, @"oldPid", @((double)INT_MAX + 1)), 101));
    EXPECT("oldPID one", !exactRequest(changed(r, @"oldPid", @1), 101));
    EXPECT("bad nonce", !exactRequest(changed(r, @"nonce", [@"z" stringByPaddingToLength:64 withString:@"z" startingAtIndex:0]), 101));
    EXPECT("short hash", !exactRequest(changed(r, @"sourceBindingSha256", @"ab"), 101));
    EXPECT("authority wrong type", !exactRequest(changed(r, @"authoritySha256", @1), 101));
    EXPECT("future issued", !exactRequest(r, 99));
    EXPECT("expired", !exactRequest(r, 108));
    EXPECT("oversized interval", !exactRequest(changed(r, @"expiresAtUnix", @111), 101));
    EXPECT("negative interval", !exactRequest(changed(r, @"expiresAtUnix", @99), 101));
    EXPECT("boolean time", !exactRequest(changed(r, @"issuedAtUnix", @YES), 101));
    EXPECT("text time", !exactRequest(changed(r, @"expiresAtUnix", @"108"), 101));
    EXPECT("nan time", !exactRequest(changed(r, @"issuedAtUnix", @(NAN)), 101));
    EXPECT("infinite now", !exactRequest(r, INFINITY));
    EXPECT("unknown completion field", !exactCompletion(changed(c, @"unexpected", @1), r, 104, 106));
    EXPECT("same numeric oldPID including possible reuse is unknown", !exactCompletion(changed(c, @"processIdentifier", @123), r, 104, 106));
    EXPECT("boolean completion PID", !exactCompletion(changed(c, @"processIdentifier", @YES), r, 104, 106));
    EXPECT("text completion PID", !exactCompletion(changed(c, @"processIdentifier", @"456"), r, 104, 106));
    EXPECT("fraction completion PID", !exactCompletion(changed(c, @"processIdentifier", @456.5), r, 104, 106));
    EXPECT("overflow completion PID", !exactCompletion(changed(c, @"processIdentifier", @((double)INT_MAX + 1)), r, 104, 106));
    EXPECT("completion bundle", !exactCompletion(changed(c, @"bundleIdentifier", @"other"), r, 104, 106));
    EXPECT("completion path", !exactCompletion(changed(c, @"bundlePath", @"/opt/Other.app"), r, 104, 106));
    EXPECT("completion executable", !exactCompletion(changed(c, @"executablePath", @"/opt/Other"), r, 104, 106));
    EXPECT("terminated", !exactCompletion(changed(c, @"terminated", @YES), r, 104, 106));
    EXPECT("numeric not boolean terminated", !exactCompletion(changed(c, @"terminated", @0), r, 104, 106));
    EXPECT("missing date", !exactCompletion(changed(c, @"launchDateUnix", NSNull.null), r, 104, 106));
    EXPECT("boolean date", !exactCompletion(changed(c, @"launchDateUnix", @YES), r, 104, 106));
    EXPECT("preexisting date", !exactCompletion(changed(c, @"launchDateUnix", @102), r, 104, 106));
    EXPECT("future date", !exactCompletion(changed(c, @"launchDateUnix", @108), r, 104, 106));
    EXPECT("time reversed", !exactCompletion(c, r, 106, 104));
    NSMutableDictionary *missing = [r mutableCopy]; [missing removeObjectForKey:@"oldPid"];
    EXPECT("missing request field", !exactRequest(missing, 101));
#undef EXPECT
    printf("{\"nativePureAssertions\":%lu,\"passed\":%s,\"HostLaunches\":0}\n",
        (unsigned long)count, failed == 0 ? "true" : "false");
    return failed == 0 ? 0 : 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // This branch precedes every UID/file/process/AppKit-workspace access.
        if (argc == 2 && strcmp(argv[1], "--offline-self-test") == 0) return offlineSelfTest();
        if (argc != 3 || strcmp(argv[1], "--request") != 0 || getuid() == 0 || getuid() != geteuid()) return 64;
        NSString *requestPath = [NSString stringWithUTF8String:argv[2]];
        if (!canonical(requestPath) || ![requestPath.lastPathComponent isEqual:@"launch-request.json"]) return 65;
        RunPath = requestPath.stringByDeletingLastPathComponent;
        RunFD = open(RunPath.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        struct stat seat;
        if (RunFD < 0 || fstat(RunFD, &RunIdentity) || !sameRun() ||
            stat("/dev/console", &seat) || seat.st_uid != getuid()) return 65;
        NSData *raw = readPrivate(@"launch-request.json");
        id request = raw ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:NULL] : nil;
        if (!exactRequest(request, NSDate.date.timeIntervalSince1970)) return 66;
        NSString *appPath = request[@"appPath"], *exePath = request[@"executablePath"];
        struct stat app, exe;
        if (!canonical(appPath) || !canonical(exePath) || lstat(appPath.fileSystemRepresentation, &app) ||
            lstat(exePath.fileSystemRepresentation, &exe) || !S_ISDIR(app.st_mode) || !S_ISREG(exe.st_mode) ||
            (app.st_uid != getuid() && app.st_uid != 0) || (exe.st_uid != getuid() && exe.st_uid != 0) ||
            (app.st_mode & 0022) || (exe.st_mode & 0022) || !(exe.st_mode & 0100)) return 67;
        NSBundle *bundle = [NSBundle bundleWithPath:appPath];
        if (![bundle.bundleIdentifier isEqual:BundleID] || ![bundle.executablePath isEqual:exePath]) return 67;
        if ([NSRunningApplication runningApplicationsWithBundleIdentifier:BundleID].count != 0) return 68;
        if (!exactRequest(request, NSDate.date.timeIntervalSince1970) ||
            !writeExclusive(@"native-launch-consumed.json", raw)) return 69;
        NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
        config.arguments = @[];
        config.environment = @{@"LC_ALL":@"C", @"TZ":@"UTC", @"PATH":@"/usr/bin:/bin:/usr/sbin:/sbin"};
        config.activates = NO; config.hides = NO; config.hidesOthers = NO;
        config.addsToRecentItems = NO; config.allowsRunningApplicationSubstitution = NO;
        config.createsNewApplicationInstance = YES; config.promptsUserIfNeeded = NO;
        double before = NSDate.date.timeIntervalSince1970;
        double remaining = MIN([request[@"expiresAtUnix"] doubleValue] - before, 8.0);
        if (remaining <= 0) finish(@{@"status":@"expired_before_api", @"nonce":request[@"nonce"],
            @"HostLaunchesMaximum":@0, @"retryAllowed":@NO}, 69);
        double start = monotonic();
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        if (!timer) finish(@{@"status":@"timer_unavailable_before_api", @"nonce":request[@"nonce"],
            @"HostLaunchesMaximum":@0, @"retryAllowed":@NO}, 74);
        dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(remaining * NSEC_PER_SEC)), DISPATCH_TIME_FOREVER, 0);
        dispatch_source_set_event_handler(timer, ^{
            finish(@{@"status":@"launch_completion_timeout_unknown", @"nonce":request[@"nonce"],
                @"beforeApiUnix":@(before), @"afterCompletionUnix":@(NSDate.date.timeIntervalSince1970),
                @"HostLaunchesMaximum":@1, @"retryAllowed":@NO}, 70);
        });
        dispatch_resume(timer);
        [[NSWorkspace sharedWorkspace] openApplicationAtURL:[NSURL fileURLWithPath:appPath isDirectory:YES]
            configuration:config completionHandler:^(NSRunningApplication *application, NSError *error) {
            // Apple invokes completion on a concurrent queue. Serialize its
            // snapshot and the deadline handler on the same main queue.
            dispatch_async(dispatch_get_main_queue(), ^{
                double after = NSDate.date.timeIntervalSince1970;
                NSDictionary *snapshot = application ? @{
                    @"processIdentifier":@(application.processIdentifier),
                    @"bundleIdentifier":application.bundleIdentifier ?: (id)NSNull.null,
                    @"bundlePath":application.bundleURL.path ?: (id)NSNull.null,
                    @"executablePath":application.executableURL.path ?: (id)NSNull.null,
                    @"launchDateUnix":application.launchDate ? @(application.launchDate.timeIntervalSince1970) : (id)NSNull.null,
                    @"terminated":@(application.terminated)} : @{};
                BOOL pass = !error && monotonic() - start <= remaining && after < [request[@"expiresAtUnix"] doubleValue] &&
                    exactCompletion(snapshot, request, before, after);
                dispatch_source_cancel(timer);
                finish(@{@"status":pass ? @"exact_launchservices_completion" : @"launch_completion_rejected_unknown",
                    @"nonce":request[@"nonce"], @"beforeApiUnix":@(before), @"afterCompletionUnix":@(after),
                    @"application":snapshot, @"errorPresent":@(error != nil),
                    @"HostLaunchesMaximum":@1, @"retryAllowed":@NO}, pass ? 0 : 71);
            });
        }];
        dispatch_main();
    }
}
