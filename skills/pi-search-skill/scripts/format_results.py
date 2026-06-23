#!/usr/bin/env python3
"""Format search-daemon JSON into a human-readable list.

Reads JSON from stdin; the query is passed via the QUERY env var.
"""
import json
import os
import sys

q = os.environ.get("QUERY", "")
data = json.loads(sys.stdin.read())

print(f"results for: {q}")
src = data.get("source", "?")
took = data.get("took_ms", "?")
deg = data.get("degraded", False)
print(f"source: {src}  took_ms: {took}  degraded: {deg}")

if deg:
    errs = data.get("errors", [])
    if errs:
        print(f"warnings: {errs}")
print()

results = data.get("results", [])
for i, r in enumerate(results, 1):
    title = (r.get("title") or "").strip()
    url = (r.get("url") or "").strip()
    snippet = (r.get("snippet") or "").strip().replace("\n", " ")
    print(f"{i}. {title}")
    print(f"   {url}")
    if snippet:
        print(f"   {snippet[:200]}")
    print()

if not results:
    print("(no results)")
