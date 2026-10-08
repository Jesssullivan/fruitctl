#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: build_host_launcher.sh --output-dir /new/owned/directory \
  --python /verified/existing/python3 --clang /verified/Apple/clang \
  --sdk /verified/MacOSX.sdk

Darwin ARM64 developer tool only. Compiles one helper and runs its pure
--offline-self-test. It never launches FruitctlHost. Select installed tools
explicitly; the macOS /usr/bin/python3 installer stub is refused.
USAGE
}

if [[ ${1:-} == --help && $# == 1 ]]; then usage; exit 0; fi
task_python=""
task_clang=""
task_sdk=""
task_output=""
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { usage >&2; exit 64; }
  case "$1" in
    --python) [[ -z "$task_python" ]] || exit 64; task_python=$2 ;;
    --clang) [[ -z "$task_clang" ]] || exit 64; task_clang=$2 ;;
    --sdk) [[ -z "$task_sdk" ]] || exit 64; task_sdk=$2 ;;
    --output-dir) [[ -z "$task_output" ]] || exit 64; task_output=$2 ;;
    *) usage >&2; exit 64 ;;
  esac
  shift 2
done
[[ "$task_python" == /* && "$task_python" != /usr/bin/python3 && -x "$task_python" &&
   "$task_clang" == /* && "$task_sdk" == /* && "$task_output" == /* ]] || { usage >&2; exit 64; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$task_python" -I -S -B - "$script_dir/launch_host_once.m" "$task_clang" "$task_sdk" "$task_output" <<'PY'
import hashlib, json, os, platform, stat, subprocess, sys, time
from pathlib import Path

started = time.monotonic()
deadline, hard_end = started + 37, started + 40
source, clang, sdk, output = map(Path, sys.argv[1:])
uid = os.getuid()
proofs, signals = [], []
current = None
created = False
env = {key: os.environ[key] for key in ('HOME', 'USER', 'LOGNAME') if key in os.environ}
env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL='C', TZ='UTC')

def need(value, label):
    if not value:
        raise RuntimeError(label)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def data(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()

def new(name, raw):
    fd = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())

def file_bytes(path, maximum, protected=False):
    physical = path.resolve(strict=True)
    fd = os.open(physical, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'bounded_regular_input')
        if protected:
            need(before.st_uid in (0, uid) and before.st_mode & 0o022 == 0, 'protected_tool_input')
        chunks = []
        remaining = before.st_size
        while remaining:
            part = os.read(fd, min(1048576, remaining))
            need(part, 'complete_input_read')
            chunks.append(part); remaining -= len(part)
        raw = b''.join(chunks)
        stable = lambda s: (s.st_dev, s.st_ino, s.st_uid, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        need(stable(before) == stable(os.fstat(fd)) == stable(physical.stat()) and path.resolve() == physical,
             'stable_input')
        return raw, {'path': str(path), 'canonicalPath': str(physical), 'sha256': digest(raw),
                     'bytes': len(raw), 'uid': before.st_uid, 'mode': stat.S_IMODE(before.st_mode)}
    finally:
        os.close(fd)

def row(pid):
    need(time.monotonic() < hard_end, 'metadata_budget')
    r = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'pid=,uid=,ppid=,pgid=,lstart=,comm='],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env=env, timeout=min(2, hard_end-time.monotonic()))
    need(r.returncode in (0, 1) and len(r.stdout) <= 8192 and len(r.stderr) <= 4096, 'own_child_metadata')
    if not r.stdout.strip():
        return None
    fields = r.stdout.decode('utf-8', 'strict').strip().split(None, 9)
    need(len(fields) == 10, 'own_child_metadata_shape')
    return {'pid': int(fields[0]), 'uid': int(fields[1]), 'parentPid': int(fields[2]),
            'pgid': int(fields[3]), 'sid': os.getsid(pid), 'birth': ' '.join(fields[4:9]), 'comm': fields[9]}

def group_rows(group):
    need(time.monotonic() < hard_end, 'group_metadata_budget')
    r = subprocess.run(['/bin/ps', '-axo', 'pid=,uid=,ppid=,pgid=,comm='], stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                       timeout=min(2, hard_end-time.monotonic()))
    need(r.returncode == 0 and len(r.stderr) <= 4096, 'group_metadata')
    found = []
    for line in r.stdout.decode('utf-8', 'strict').splitlines():
        f = line.split(None, 4)
        if len(f) == 5 and int(f[3]) == group:
            found.append({'pid': int(f[0]), 'uid': int(f[1]), 'parentPid': int(f[2]),
                          'pgid': int(f[3]), 'comm': f[4]})
    return found

def run(kind, argv, seconds, maximum=131072):
    global current
    need(time.monotonic() < deadline, 'productive_budget')
    begin = time.monotonic()
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=env, close_fds=True, start_new_session=True)
    current = p
    proof = {'kind': kind, 'argv': argv, 'pid': p.pid, 'parentPid': os.getpid(),
             'dedicatedGroup': p.pid, 'reaped': False, 'requestedTimeoutSeconds': seconds}
    proofs.append(proof)
    basis = row(p.pid)
    proof['basis'] = basis
    if basis:
        need(basis['uid'] == uid and basis['parentPid'] == os.getpid() and
             basis['pgid'] == basis['sid'] == p.pid, 'own_created_child')
    new(kind+'-spawn.json', data(proof))
    try:
        out, err = p.communicate(timeout=min(seconds, max(.01, deadline-time.monotonic())))
    except BaseException:
        # The still-unreaped direct child cannot have had its PID reused. Do not
        # signal another process/group or infer descendant closure from its exit.
        limit = min(hard_end, time.monotonic()+3)
        live = row(p.pid)
        if live is None:
            p.wait(timeout=max(.01, limit-time.monotonic()))
        else:
            need(basis is not None and live == basis, 'own_live_child_before_timeout_signal')
            p.kill(); signals.append({'pid': p.pid, 'signal': 'SIGKILL', 'basis': live})
            p.wait(timeout=max(.01, limit-time.monotonic()))
        raise
    finally:
        proof.update(reaped=p.returncode is not None, returnCode=p.returncode, seconds=time.monotonic()-begin)
        if p.returncode is not None:
            current = None
    # Controlled compiler output is checked after capture, not a hard RAM cap.
    need(len(out) <= maximum and len(err) <= maximum, 'post_capture_output_bounds')
    new(kind+'.stdout', out); new(kind+'.stderr', err)
    proof.update(stdoutSha256=digest(out), stderrSha256=digest(err), stdoutBytes=len(out),
                 stderrBytes=len(err), freshPidAbsent=row(p.pid) is None, remainingGroup=group_rows(p.pid))
    new(kind+'-proof.json', data(proof))
    need(p.returncode == 0 and proof['freshPidAbsent'] and not proof['remainingGroup'], 'phase_and_owned_closure')
    return out

result = {'passed': False, 'HostLaunches': 0, 'proofs': proofs, 'signals': signals}
try:
    need(sys.platform == 'darwin' and platform.machine() == 'arm64' and uid == os.geteuid() and uid != 0,
         'Darwin_ARM64_user_build_only')
    need(sys.version_info >= (3, 9), 'existing_Python39_or_newer')
    need(source.is_absolute() and clang.is_absolute() and sdk.is_absolute() and output.is_absolute(), 'absolute_inputs')
    need(output.parent.resolve() == output.parent and output.parent.is_dir() and
         output.parent.stat().st_uid == uid and output.parent.stat().st_mode & 0o022 == 0 and
         not os.path.lexists(output), 'owned_existing_parent_and_exclusive_output')
    need(sdk.resolve() == sdk and sdk.is_dir(), 'canonical_installed_SDK')
    raw, source_info = file_bytes(source, 131072)
    _, clang_info = file_bytes(clang, 384*1024*1024, True)
    _, settings_info = file_bytes(sdk/'SDKSettings.json', 1048576, True)
    os.mkdir(output, 0o700); created = True
    new('launch_host_once.m', raw)
    new('build-inputs.json', data({'source': source_info, 'clang': clang_info, 'SDKSettings': settings_info,
                                  'wholeBudgetSeconds': 40, 'productiveSeconds': 37, 'cleanupSeconds': 3}))
    common = [str(clang), '-isysroot', str(sdk), '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
              '-mmacosx-version-min=15.0']
    run('compiler-version', [str(clang), '--version'], 2)
    run('syntax', common+['-fsyntax-only', str(output/'launch_host_once.m')], 10)
    binary = output/'fruitctl-host-launch-once'
    run('link', common+['-O2', str(output/'launch_host_once.m'), '-framework', 'AppKit',
                       '-framework', 'Foundation', '-framework', 'CoreFoundation', '-o', str(binary)], 20)
    os.chmod(binary, 0o700)
    pure = json.loads(run('offline-self-test', [str(binary), '--offline-self-test'], 2, 4096))
    need(pure.get('passed') is True and pure.get('HostLaunches') == 0 and
         isinstance(pure.get('nativePureAssertions'), int) and not isinstance(pure['nativePureAssertions'], bool) and
         pure['nativePureAssertions'] >= 50, 'actual_native_predicates')
    need(file_bytes(source, 131072)[0] == raw, 'source_unchanged_during_build')
    binary_raw, binary_info = file_bytes(binary, 1048576)
    need(binary_info['uid'] == uid and binary_info['mode'] == 0o700, 'owned_new_binary')
    result.update(passed=True, source=source_info, clang=clang_info, SDKSettings=settings_info,
                  binary=binary_info, pureSelfTest=pure)
except BaseException as error:
    result.update(failureClass=type(error).__name__,
                  fixedGateLabel=str(error) if isinstance(error, RuntimeError) else None,
                  pendingDirectPID=current.pid if current is not None else None,
                  closureUnknown=current is not None or any(not p.get('freshPidAbsent') or p.get('remainingGroup') for p in proofs))
result['seconds'] = time.monotonic()-started
result['outputBounds'] = 'post-capture checks; not hard allocation bounds'
if created:
    new('build-result.json', data(result))
print(json.dumps(result, sort_keys=True))
sys.exit(0 if result['passed'] else 1)
PY
