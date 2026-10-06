import Foundation
import Darwin

enum HostIPCError: Error {
    case unavailable, unsafeSocketPath, ioFailure, requestTimeout
}

enum HostIPC {
    static var socketPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Fruitctl/run/host.sock").path
    }

    static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        let bytes = Array(path.utf8) + [UInt8(0)]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            throw HostIPCError.unsafeSocketPath
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        return address
    }

    static func configure(_ fd: Int32) {
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled,
                       socklen_t(MemoryLayout<Int32>.size))
    }

    static func write(_ data: Data, to fd: Int32, timeoutMilliseconds: Int32 = 2_000) throws {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(Int64(timeoutMilliseconds)))
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard ContinuousClock.now < deadline else { throw HostIPCError.requestTimeout }
                var item = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                let result = poll(&item, 1, 100)
                if result < 0 && errno == EINTR { continue }
                guard result >= 0 else { throw HostIPCError.ioFailure }
                if result == 0 { continue }
                guard item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else {
                    throw HostIPCError.ioFailure
                }
                // Nonblocking writes keep the deadline meaningful even when a
                // peer stops reading a large capture response.
                let count = send(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset,
                                 MSG_DONTWAIT)
                if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
                guard count > 0 else { throw HostIPCError.ioFailure }
                offset += count
            }
        }
    }

    static func attachStdio(path: String = socketPath) throws {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_uid == getuid(),
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              info.st_mode & 0o077 == 0 else { throw HostIPCError.unavailable }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HostIPCError.ioFailure }
        configure(fd)
        defer { close(fd) }
        var address = try address(path)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw HostIPCError.unavailable }
        var peerUID: uid_t = 0, peerGID: gid_t = 0
        guard getpeereid(fd, &peerUID, &peerGID) == 0, peerUID == getuid() else {
            throw HostIPCError.unavailable
        }
        let outputFlags = fcntl(STDOUT_FILENO, F_GETFL)
        guard outputFlags >= 0, fcntl(STDOUT_FILENO, F_SETFL, outputFlags | O_NONBLOCK) == 0 else {
            throw HostIPCError.ioFailure
        }
        defer { _ = fcntl(STDOUT_FILENO, F_SETFL, outputFlags) }
        var framer = HostLineFramer()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        var inputEndedAt: ContinuousClock.Instant?
        while true {
            if let ended = inputEndedAt,
               ContinuousClock.now >= ended.advanced(by: .seconds(3)) {
                throw HostIPCError.requestTimeout
            }
            var items = [pollfd(fd: inputEndedAt == nil ? STDIN_FILENO : -1,
                                events: Int16(POLLIN), revents: 0),
                         pollfd(fd: fd, events: Int16(POLLIN), revents: 0)]
            let result = poll(&items, 2, 100)
            if result < 0 && errno == EINTR { continue }
            guard result >= 0 else { throw HostIPCError.ioFailure }
            if items[0].revents & Int16(POLLIN | POLLHUP) != 0 {
                let count = Darwin.read(STDIN_FILENO, &buffer, 8_192)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw HostIPCError.ioFailure }
                if count == 0 {
                    guard !framer.hasIncompleteLine else { throw HostLeaseError.invalidParameters }
                    inputEndedAt = ContinuousClock.now
                    _ = shutdown(fd, SHUT_WR)
                } else {
                    for var line in try framer.append(Data(buffer.prefix(count))) {
                        _ = try JSONDecoder().decode(HostRequest.self, from: line)
                        line.append(10)
                        try write(line, to: fd)
                    }
                }
            }
            if items[1].revents & Int16(POLLIN | POLLHUP) != 0 {
                let count = recv(fd, &buffer, buffer.count, 0)
                if count < 0 && errno == EINTR { continue }
                guard count >= 0 else { throw HostIPCError.ioFailure }
                if count == 0 { return }
                try writeOutput(Data(buffer.prefix(count)))
            }
            if items.contains(where: { $0.revents & Int16(POLLERR | POLLNVAL) != 0 }) {
                throw HostIPCError.ioFailure
            }
        }
    }

    private static func writeOutput(_ data: Data) throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard ContinuousClock.now < deadline else { throw HostIPCError.requestTimeout }
                var item = pollfd(fd: STDOUT_FILENO, events: Int16(POLLOUT), revents: 0)
                let result = poll(&item, 1, 100)
                if result < 0 && errno == EINTR { continue }
                guard result >= 0, item.revents & Int16(POLLERR | POLLHUP | POLLNVAL) == 0 else {
                    throw HostIPCError.ioFailure
                }
                if result == 0 { continue }
                let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset),
                                         bytes.count - offset)
                if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
                guard count > 0 else { throw HostIPCError.ioFailure }
                offset += count
            }
        }
    }
}

private final class HostReplyWaiter {
    let completed = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var response: HostResponse?
    func finish(_ response: HostResponse) {
        lock.lock(); self.response = response; lock.unlock()
        completed.signal()
    }
    func value() -> HostResponse? { lock.lock(); defer { lock.unlock() }; return response }
}

final class HostSocketServer {
    typealias Handler = (HostRequest, UUID, @escaping (HostResponse) -> Void) -> Void
    private let path: String
    private let handler: Handler
    private let disconnected: (UUID) -> Void
    private var listener: Int32 = -1
    private var socketIdentity: (device: dev_t, inode: ino_t)?
    private let lock = NSLock()
    private var clients: Set<Int32> = []

    init(path: String = HostIPC.socketPath, handler: @escaping Handler,
         disconnected: @escaping (UUID) -> Void) {
        self.path = path; self.handler = handler; self.disconnected = disconnected
    }

    func start() throws {
        let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        var directoryInfo = stat()
        guard lstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(),
              directoryInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              directoryInfo.st_mode & 0o077 == 0 else { throw HostIPCError.unsafeSocketPath }
        var existing = stat()
        if lstat(path, &existing) == 0 {
            try removeStaleSocket(existing)
        } else if errno != ENOENT { throw HostIPCError.unsafeSocketPath }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HostIPCError.ioFailure }
        HostIPC.configure(fd)
        var address = try HostIPC.address(path)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { close(fd); throw HostIPCError.unavailable }
        guard lstat(path, &existing) == 0 else { close(fd); throw HostIPCError.unsafeSocketPath }
        socketIdentity = (existing.st_dev, existing.st_ino)
        guard chmod(path, 0o600) == 0 else {
            removeOwnedSocket()
            close(fd); throw HostIPCError.unsafeSocketPath
        }
        guard listen(fd, 8) == 0 else { close(fd); removeOwnedSocket(); throw HostIPCError.ioFailure }
        listener = fd
        DispatchQueue.global(qos: .utility).async { [weak self] in self?.acceptClients(fd) }
    }

    func stop() {
        lock.lock()
        let fd = listener; listener = -1
        let connected = clients
        lock.unlock()
        if fd >= 0 { _ = shutdown(fd, SHUT_RDWR); close(fd) }
        for peer in connected { _ = shutdown(peer, SHUT_RDWR) }
        removeOwnedSocket()
    }

    private func removeOwnedSocket() {
        guard let identity = socketIdentity else { return }
        var current = stat()
        if lstat(path, &current) == 0, current.st_uid == getuid(),
           current.st_dev == identity.device, current.st_ino == identity.inode,
           current.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK) { _ = unlink(path) }
        socketIdentity = nil
    }

    private func removeStaleSocket(_ existing: stat) throws {
        guard existing.st_uid == getuid(), existing.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              existing.st_mode & 0o077 == 0 else { throw HostIPCError.unsafeSocketPath }
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        guard probe >= 0 else { throw HostIPCError.ioFailure }
        defer { close(probe) }
        guard fcntl(probe, F_SETFL, O_NONBLOCK) == 0 else { throw HostIPCError.ioFailure }
        var address = try HostIPC.address(path)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        // A refused local connection proves only this owned socket is stale;
        // never kill a process or take over a listener that accepted the probe.
        guard result != 0, errno == ECONNREFUSED else { throw HostIPCError.unavailable }
        var current = stat()
        guard lstat(path, &current) == 0, current.st_uid == existing.st_uid,
              current.st_dev == existing.st_dev, current.st_ino == existing.st_ino,
              current.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
              unlink(path) == 0 else { throw HostIPCError.unsafeSocketPath }
    }

    private func acceptClients(_ fd: Int32) {
        while true {
            let peer = accept(fd, nil, nil)
            if peer < 0 && errno == EINTR { continue }
            guard peer >= 0 else { return }
            HostIPC.configure(peer)
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(peer, &uid, &gid) == 0, uid == getuid() else { close(peer); continue }
            lock.lock()
            guard clients.count < 8, listener == fd else { lock.unlock(); close(peer); continue }
            clients.insert(peer)
            lock.unlock()
            DispatchQueue.global(qos: .utility).async { [weak self] in self?.serve(peer) }
        }
    }

    private func serve(_ fd: Int32) {
        let connectionID = UUID()
        defer {
            disconnected(connectionID)
            lock.lock(); clients.remove(fd); lock.unlock()
            close(fd)
        }
        var framer = HostLineFramer()
        var buffer = [UInt8](repeating: 0, count: 8_192)
        do {
            while true {
                let count = recv(fd, &buffer, buffer.count, 0)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { return }
                for line in try framer.append(Data(buffer.prefix(count))) {
                    let request: HostRequest
                    do { request = try JSONDecoder().decode(HostRequest.self, from: line) }
                    catch {
                        try HostIPC.write(try HostResponse.failure(id: nil, code: -32600,
                                                                  message: "invalid_request").line(), to: fd)
                        continue
                    }
                    let waiter = HostReplyWaiter()
                    handler(request, connectionID, waiter.finish)
                    guard waiter.completed.wait(timeout: .now() + 2.5) == .success,
                          let response = waiter.value() else { throw HostIPCError.requestTimeout }
                    try HostIPC.write(try response.line(), to: fd)
                }
            }
        } catch {
            // EOF/error revokes this connection's lease through disconnected.
            // Neither raw request contents nor local exception details are logged.
        }
    }

    deinit { stop() }
}
