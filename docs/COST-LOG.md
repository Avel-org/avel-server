# Cost Log

*Per-mission, per-agent token and spend capture. Append-only.*

**Why now.** Cost governance is ranked as AVEL's top financial risk with no mechanism behind it, and `Mission.spend_ceiling_usd` is specced but not yet enforced. Build status is in `STATE.md`. This file is the data that turns the ceiling into a real number. It cannot be reconstructed later — an unlogged token is gone.

**Rule:** one line per session, appended at session close. Never edited.

---

## Format

```
date · mission · slice · agent · model · in_tokens · out_tokens · usd · note
```

---

## Log

2026-10-14 · step-9e-smoke · 9e · kel · claude-sonnet-5-5 · 4091 · 115 · 0.0175 · halted by the 3000-token hard ceiling, as designed; system report
2026-10-14 · step-9e-smoke · 9e · kel · claude-sonnet-5-5 · 13144 · 399 · 0.0159 · complete; agent report, 2 files read, 2 written
2026-10-21 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 0 · 0 · 0 · failed twice before any call: the SDK could not start in a canon-config folder that did not exist (fixed the same day)
2026-10-21 · first-mission-live · item-6 · canon+atlas · claude-sonnet-5-5 · ? · ? · ? · passed; numbers lost, vitest hid the output of a passing test. Expected near the run below; the Console's usage page holds the real figure
2026-10-21 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1230 · 2120 · 0.039871 · replied; 0 citations came back, so citations surviving the SDK is still unshown
2026-10-21 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 283 · 0.015916 · complete in 12 s; agent report, 1 file written; cache read 11375, cache write 2984; gate pass
2026-10-21 · citation-probes · canon · probe · claude-sonnet-5-5 · ? · ? · 0.02 · 4 probes: API direct, SDK x2, SDK with a tool; the SDK carries citations both ways
2026-10-21 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1234 · 3205 · 0.069867 · replied; instructions v3; 3/3 citations resolve to the notes; 6/6 brief items sourced inside the notes
2026-10-21 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 283 · 0.023667 · complete in 8 s; agent report, 1 file written; gate pass
2026-10-23 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1234 · 3317 · 0.071452 · replied; 3/3 citations resolve to the notes; Docker check runner on
2026-10-23 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 316 · 0.026705 · complete in 11 s; agent report, 1 file written; gate verified, CK2 passed on Docker; no trace steps written (the test bound no step sink)
2026-10-23 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1234 · 3119 · 0.055575 · replied; 3/3 citations resolve to the notes
2026-10-23 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 314 · 0.018200 · complete; gate verified; trace still empty, confirmed as the test's missing step sink
2026-10-23 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1234 · 3232 · 0.057169 · replied; 3/3 citations resolve to the notes
2026-10-23 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 316 · 0.018179 · complete in 9 s; tools room_read, room_write, run_checks, report; run_checks 1 of 1 pass; gate verified, CK2 passed on Docker
2026-10-24 · first-mission-live · item-6 · canon · claude-sonnet-5-5 · 1232 · 3487 · 0.072109 · replied; 3/3 citations resolve to the notes
2026-10-24 · first-mission-live · item-6 · atlas · claude-sonnet-5-5 · 6 · 315 · 0.026842 · complete in 161 s; AVEL_LIVE_SLOW_CHECK_S=150, run_checks held open through the 150 s check, 1 of 1 pass; gate verified
2026-10-24 · agent-room-spike · sandbox · probe · claude-sonnet-5-5 · ? · ? · 0.002653 · Claude Code in a container, key behind a proxy; one in-process tool call, nonce returned in 4.5 s
2026-10-24 · first-mission-live · sandbox · canon · claude-sonnet-5-5 · ? · ? · ? · replied; then dispatch create answered 500: the spike worktree ran main's code on a test database already at drizzle/0053
2026-10-24 · first-mission-live · sandbox · canon+atlas · claude-sonnet-5-5 · ? · ? · ? · passed with the agent in a container; numbers lost, vitest hid the output of a passing test
2026-10-24 · first-mission-live · sandbox · canon · claude-sonnet-5-5 · ? · ? · ? · replied; 3/3 citations resolve to the notes; the smoke prints no Canon spend
2026-10-24 · first-mission-live · sandbox · atlas · claude-sonnet-5-5 · 6 · 314 · 0.017773 · complete in 12 s with the agent's process in a container, no key in its environment, API through the key proxy only; tools room_read, room_write, run_checks, report; run_checks 1 of 1 pass; gate verified

---

## Rollup

Update at each slice close.

| Mission | Slice | Total in | Total out | USD | Wall clock | Shipped? |
|---|---|---|---|---|---|---|
| counselos | S0 | | | | | |

**Cost per shipped slice:** ← this is the number that matters
**Most expensive agent:**
**Cheapest agent that produced surviving work:**

---

## Capture

Claude Code writes usage to `~/.claude/projects/`. Pull it per session rather than estimating:

```bash
#!/usr/bin/env bash
# scripts/log-cost.sh — append this session's usage to COST-LOG.md
# usage: ./scripts/log-cost.sh <mission> <slice> <agent> "<note>"

set -euo pipefail
MISSION="${1:?mission}"; SLICE="${2:?slice}"; AGENT="${3:?agent}"; NOTE="${4:-}"
PROJ_DIR="$HOME/.claude/projects"

# newest transcript across all projects; pass the project dir if more than one is active
LATEST=$(find "$PROJ_DIR" -name '*.jsonl' -newermt '-1 day' 2>/dev/null \
         | xargs ls -t 2>/dev/null | head -1)

if [[ -z "${LATEST:-}" ]]; then
  echo "no recent transcript found under $PROJ_DIR" >&2; exit 1
fi

# adjust rates to your plan; USD per million tokens.
# Cache reads and cache writes are priced separately from plain input.
export RATE_IN=3.00 RATE_CACHE_READ=0.30 RATE_CACHE_WRITE=3.75 RATE_OUT=15.00

read -r IN OUT MODEL USD < <(python3 - "$LATEST" <<'PY'
import json, os, sys
plain = cache_read = cache_write = out = 0; model = "unknown"
for line in open(sys.argv[1], encoding="utf-8"):
    try: rec = json.loads(line)
    except Exception: continue
    u = (rec.get("message") or {}).get("usage") or rec.get("usage") or {}
    plain += u.get("input_tokens", 0)
    cache_read += u.get("cache_read_input_tokens", 0)
    cache_write += u.get("cache_creation_input_tokens", 0)
    out += u.get("output_tokens", 0)
    m = (rec.get("message") or {}).get("model")
    if m: model = m
rate = lambda k: float(os.environ[k])
usd = (plain * rate("RATE_IN") + cache_read * rate("RATE_CACHE_READ")
       + cache_write * rate("RATE_CACHE_WRITE") + out * rate("RATE_OUT")) / 1e6
print(plain + cache_read + cache_write, out, model, f"{usd:.2f}")
PY
)

printf '%s · %s · %s · %s · %s · %s · %s · %s · %s\n' \
  "$(date +%F)" "$MISSION" "$SLICE" "$AGENT" "$MODEL" "$IN" "$OUT" "$USD" "$NOTE" \
  >> "$(dirname "$0")/../docs/COST-LOG.md"

echo "logged: $AGENT  in=$IN out=$OUT  \$$USD"
```

**Verify the JSONL shape before trusting it** — Claude Code's transcript format changes between versions. Run it once, eyeball the numbers against the `/cost` command, then rely on it.

**If this is too much friction, log by hand.** Four numbers at session close beats a perfect script you don't run. The failure mode here is not inaccuracy, it's an empty file.
