#!/usr/bin/env python3
"""Merge benchmark JSON lines into Markdown tables.

Usage: compare.py [--impls a,b,c] file.jsonl...
The first implementation is the baseline; others get a speedup column.
"""
import json
import sys

args = sys.argv[1:]
impls = None
if args and args[0] == "--impls":
    impls = args[1].split(",")
    args = args[2:]

rows, seen = {}, []
for path in args:
    for line in open(path):
        r = json.loads(line)
        if r["impl"] not in seen:
            seen.append(r["impl"])
        rows.setdefault((r["dataset"], r["read"]), {})[r["impl"]] = r
impls = impls or seen
base = impls[0]

fmt = lambda v: "" if v is None else (f"{v:.2f}" if v < 10 else f"{v:.0f}")
head = ["dataset", "read"] + [f"{i} (ms)" for i in impls] + [f"{i} speedup" for i in impls[1:]] + ["checksums"]
print("| " + " | ".join(head) + " |")
print("|" + "|".join(["---", "---"] + ["---:"] * (len(impls) * 2 - 1) + ["---"]) + "|")
for (ds, read), by in rows.items():
    if not any(i in by for i in impls):
        continue
    ms = [by.get(i, {}).get("ms") for i in impls]
    speed = [
        "" if ms[0] is None or m is None or m == 0 else f"{ms[0] / m:.1f}x" for m in ms[1:]
    ]
    sums = {by[i]["checksum"] for i in impls if i in by and "checksum" in by[i]}
    ok = "n/a" if not sums else ("match" if len(sums) == 1 else "MISMATCH")
    print("| " + " | ".join([ds, read] + [fmt(m) for m in ms] + speed + [ok]) + " |")
