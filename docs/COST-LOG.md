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

<!-- example, delete on first real entry
2026-08-19 · counselos · S0 · atlas · sonnet-4.6 · 184300 · 22100 · 0.88 · schema scaffold
2026-08-19 · counselos · S0 · iyo   · sonnet-4.6 ·  96400 · 14800 · 0.51 · integration tests
-->

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
