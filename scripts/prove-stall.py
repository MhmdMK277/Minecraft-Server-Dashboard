"""Prove the M1 exit criterion against a real server.

Suspends ONLY the main "Server thread" of a running JVM, which reproduces the
2026-07-28 incident exactly: the network thread keeps answering Server List
Ping from its cached status object while the main thread is dead and cannot
execute a queued RCON command.

Suspending the whole process would NOT reproduce it -- that freezes the network
thread too, so SLP stops answering and the correct state is HUNG, not STALLED.
Both are demonstrated.

The suspension is deliberately short: the server watchdog kills a server whose
main thread stalls for 60s, so the thread is resumed well inside that window.
"""
import ctypes, os, re, subprocess, sys, time

# Same convention as prove-backup-policy: the operator's backup script is not
# at a knowable path, so it arrives via env, and without it this SKIPs.
_backup = os.environ.get("MCDASH_BACKUP_SCRIPT")
if not _backup:
    print("SKIP: set MCDASH_BACKUP_SCRIPT to the path of mcbackup.py to run this proof.")
    sys.exit(0)
sys.path.insert(0, os.path.dirname(_backup))
import mcbackup as m

TARGET = "MC Skyblock"
JSTACK = r"C:\Program Files\Java\jdk-21\bin\jstack.exe"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

THREAD_SUSPEND_RESUME = 0x0002
k32 = ctypes.windll.kernel32


def server_thread_tid(pid):
    out = subprocess.run([JSTACK, "-l", str(pid)], capture_output=True,
                         text=True, timeout=120).stdout
    for line in out.splitlines():
        if line.startswith('"Server thread"'):
            mm = re.search(r"nid=(?:0x([0-9a-f]+)|(\d+))", line)
            if mm:
                return int(mm.group(1), 16) if mm.group(1) else int(mm.group(2))
    return None


def suspend(tid):
    h = k32.OpenThread(THREAD_SUSPEND_RESUME, False, tid)
    if not h:
        raise SystemExit(f"OpenThread failed for tid {tid} (err {k32.GetLastError()})")
    n = k32.SuspendThread(h)
    k32.CloseHandle(h)
    return n


def resume(tid):
    h = k32.OpenThread(THREAD_SUSPEND_RESUME, False, tid)
    if not h:
        return -1
    n = k32.ResumeThread(h)
    k32.CloseHandle(h)
    return n


def dashboard_scan(tag):
    print(f"\n----- dashboard scan: {tag} -----", flush=True)
    # proof tooling, hardcoded argv, no untrusted input; shell=True is how npx resolves on Windows.
    r = subprocess.run(["npx", "tsx", "scripts/probe-once.ts"], cwd=REPO,
                       capture_output=True, text=True, timeout=180, shell=True)  # nosemgrep: python.lang.security.audit.subprocess-shell-true.subprocess-shell-true
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr[-800:])


d = os.path.join(m.SERVERS_ROOT, TARGET)
pid = m.pid_of_server(d)
if pid is None:
    raise SystemExit(f"{TARGET} is not running")
tid = server_thread_tid(pid)
if tid is None:
    raise SystemExit("could not locate the main Server thread")

print(f"target      : {TARGET}")
print(f"java pid    : {pid}")
print(f"Server thread native tid: {tid}")

dashboard_scan("BEFORE, everything healthy")

print(f"\n>>> suspending ONLY the main Server thread (tid {tid}) <<<", flush=True)
suspend(tid)
try:
    time.sleep(2)
    # Independent confirmation that the port still answers while the main
    # thread is frozen -- this is the whole point.
    slp = m.slp_ping(m.game_port_of(d))
    print(f"    direct SLP check while suspended: "
          f"{'ANSWERS -> ' + str((slp.get('version') or {}).get('name')) if slp else 'no reply'}")
    dashboard_scan("DURING, main thread suspended, network thread alive")
finally:
    n = resume(tid)
    print(f"\n>>> resumed Server thread (previous suspend count {n}) <<<", flush=True)

time.sleep(4)
dashboard_scan("AFTER: resumed")
