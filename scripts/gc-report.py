#!/usr/bin/env python3
"""Safepoint / GC pause report for the live servers.

Answers one question: are stop-the-world pauses under the 200 ms line, and when
they are not, is the time going to the HOST (threads could not reach the
safepoint) or to the JVM (work done at the safepoint)?

    python scripts/gc-report.py
    python scripts/gc-report.py --root "C:/Users/you/Documents/MC Servers"

Two things here exist because getting them wrong produced a confident wrong
answer, and both failures are silent:

1.  TWO FIELD LAYOUTS.  JDK 21 logs "Reaching safepoint / Cleanup / At safepoint
    / Total".  JDK 25 replaced Cleanup with "Leaving safepoint" and appended
    "Threads".  A regex written against one layout matches ZERO lines on the
    other and the report still prints a clean table.  A file that parses to
    nothing looks exactly like a server that behaved.  So: parse fields by name,
    and print per-file coverage so "0 parsed from 84 candidate lines" is visible
    rather than absent.

2.  ONE gc.log FILE IS NOT ONE JVM.  Rotated files outlive the process that
    wrote them.  Reading a pre-restart gc.log.00 as current invented a 46,265
    ThreadDump regression that did not exist.  Default is the live file only.
    --all-rotations opts into history, and labels it.
"""
import argparse
import glob
import os
import re
import sys
from datetime import datetime

SAFEPOINT = re.compile(
    r'^\[(?P<ts>[^\]]+)\].*\[safepoint\s*\]\s*Safepoint "(?P<op>[^"]+)",\s*(?P<rest>.*)$')
FIELD = re.compile(r'([A-Za-z ]+):\s*(\d+)\s*ns')
DEFAULT_ROOT = os.path.expanduser(r"~\Documents\MC Servers")


def pctl(values, p):
    if not values:
        return 0.0
    k = (len(values) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def parse_file(path):
    """-> (rows, candidate_line_count). candidates are lines that LOOK like
    safepoints; a gap between the two numbers is a parser bug, not a quiet JVM."""
    rows, candidates = [], 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "[safepoint" not in line:
                continue
            candidates += 1
            m = SAFEPOINT.match(line)
            if not m:
                continue
            f = {k.strip(): int(v) / 1e6 for k, v in FIELD.findall(m.group("rest"))}
            if "Total" not in f:
                continue
            rows.append(dict(
                ts=m.group("ts")[:19],
                op=m.group("op"),
                total=f["Total"],
                # host-side: time spent waiting for threads to arrive
                reach=f.get("Reaching safepoint", 0.0),
                # jvm-side: the operation itself, under either layout
                at=f.get("At safepoint", 0.0) + f.get("Cleanup", 0.0) + f.get("Leaving safepoint", 0.0),
            ))
    return rows, candidates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("MCDASH_SERVERS_ROOT", DEFAULT_ROOT))
    ap.add_argument("--threshold", type=float, default=200.0,
                    help="pause budget in ms (default 200)")
    ap.add_argument("--all-rotations", action="store_true",
                    help="include rotated files; these may belong to earlier JVMs")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit(f"servers root not found: {args.root}")

    servers = sorted(
        d for d in os.listdir(args.root)
        if os.path.isfile(os.path.join(args.root, d, "logs", "gc.log")))
    if not servers:
        sys.exit(f"no server directory under {args.root} has logs/gc.log")

    if args.all_rotations:
        print("!! including rotated files -- these may belong to REPLACED processes\n")

    print("PARSE COVERAGE")
    print(f"{'server':<16} {'file':<14} {'candidates':>11} {'parsed':>7}  status")
    print("-" * 62)
    data, bad = {}, False
    for s in servers:
        pattern = "gc.log*" if args.all_rotations else "gc.log"
        rows = []
        for path in sorted(glob.glob(os.path.join(args.root, s, "logs", pattern))):
            got, cand = parse_file(path)
            status = "ok"
            if cand and not got:
                status = "PARSER BUG - 0 of %d parsed" % cand
                bad = True
            print(f"{s:<16} {os.path.basename(path):<14} {cand:>11} {len(got):>7}  {status}")
            rows += got
        data[s] = rows

    print("\n" + "=" * 104)
    print(f"{'server':<16} {'window':<28} {'n':>6} {'p50':>7} {'p95':>7} {'p99':>7} "
          f"{'max':>8} {'>%dms' % args.threshold:>7}")
    print("-" * 104)

    over_all, worst_all, big = 0, 0.0, []
    for s in servers:
        rows = data[s]
        if not rows:
            print(f"{s:<16} no safepoints logged")
            continue
        totals = sorted(r["total"] for r in rows)
        times = sorted(r["ts"] for r in rows)
        t0, t1 = datetime.fromisoformat(times[0]), datetime.fromisoformat(times[-1])
        hrs = (t1 - t0).total_seconds() / 3600
        over = sum(1 for v in totals if v > args.threshold)
        over_all += over
        worst_all = max(worst_all, totals[-1])
        big += [(r["total"], s, r) for r in rows if r["total"] > args.threshold]
        print(f"{s:<16} {t0:%m-%d %H:%M}->{t1:%H:%M} ({hrs:4.1f}h) {len(rows):>6} "
              f"{pctl(totals,50):>7.2f} {pctl(totals,95):>7.2f} {pctl(totals,99):>7.2f} "
              f"{totals[-1]:>8.2f} {over:>7}")

    print("-" * 104)
    print(f"FLEET worst {worst_all:.2f} ms | over {args.threshold:.0f} ms: {over_all}")

    if big:
        print(f"\nEvery pause over {args.threshold:.0f} ms, and where the stopped time went:")
        print(f"{'total':>9} {'server':<16} {'when':<20} {'operation':<24} "
              f"{'reaching':>10} {'at-sp':>10}  attribution")
        print("-" * 104)
        for tot, s, r in sorted(big, reverse=True):
            host = r["reach"] > r["at"]
            print(f"{tot:>8.2f}ms {s:<16} {r['ts']:<20} {r['op']:<24} "
                  f"{r['reach']:>9.3f}ms {r['at']:>9.2f}ms  "
                  f"{'HOST (could not reach safepoint)' if host else 'JVM (work at safepoint)'}")
        print("\nreaching >> at-safepoint means the OS was not running the threads:"
              "\npaging, CPU starvation, a stalled disk. That is a host fault."
              "\nat-safepoint >> reaching means the JVM did the work. That is GC tuning.")
    else:
        print(f"\nNothing over {args.threshold:.0f} ms.")

    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
