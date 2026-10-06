#!/usr/bin/env bash
# check-docs.sh — mechanical doc-consistency gate for AVEL.
#
# Replaces the manual reconciliation protocol. Catches stale terminology,
# wrong counts, and build status leaking outside STATE.md.
#
# Usage:  ./scripts/check-docs.sh [docs_dir]     (default: docs)
# CI:     exit 1 on any finding.
#
# It cannot catch semantic drift — two docs describing one mechanism
# differently in fresh words. That still needs reading.

set -uo pipefail

DOCS="${1:-docs}"
FAIL=0
SELF="$(basename "${BASH_SOURCE[0]}")"

# Files exempt from the denylist: they legitimately name stale terms.
EXEMPT_RE='(DOC-OWNERSHIP\.md|CHANGELOG\.md)$'

# Lines exempt anywhere. Two forms:
#   - a "Stale markers:" declaration line
#   - an explicit inline escape: <!--allow-stale-->
# The escape is deliberate and greppable. A doc that legitimately names a dead
# term (a decision record explaining what was replaced, a negation like
# 'never "25 AI agents"') marks the line; everything else fails.
LINE_EXEMPT_RE='(<!--allow-stale-->|[Ss]tale markers?:)'

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$1"; }

fail() { red "  ✗ $1"; FAIL=1; }
pass() { grn "  ✓ $1"; }

if [[ ! -d "$DOCS" ]]; then
  red "docs directory not found: $DOCS"; exit 2
fi

# Collect target files once.
mapfile -t FILES < <(find "$DOCS" -name '*.md' -type f | grep -Ev "$EXEMPT_RE" | sort)
if [[ ${#FILES[@]} -eq 0 ]]; then
  red "no markdown files found in $DOCS"; exit 2
fi

# ---------------------------------------------------------------------------
# 1. Stale-term denylist
# ---------------------------------------------------------------------------
echo
echo "1. Stale terminology"

# term :: human-readable replacement
# NOTE: delimiter is '::' not '|' — '|' collides with regex alternation and
# silently truncated the count patterns when this was first written.
DENY=(
  'tRPC::ts-rest'
  'Supabase::Neon'
  'bytea::R2 / snapshot_key'
  'skippable::gates are mandatory|warn; bypass is gate_override'
  '25 AI agents::see STATE.md'
  '\bADR-01[0-9]\b::decisions live in DECISIONS-V2.md, not numbered ADRs'
  '(thirteen|13) (core )?(V1 )?entities::see STATE.md'
  '(nineteen|19) build agents::see STATE.md'
  '(ten|eleven|10|11) (core )?entities::see STATE.md'
  # Restored 2026-10-05: Capability stays in Skill (DECISIONS-V2.md).
  'Capability(-as-an-entity| as its own entity)::Skill.type = .capability.'
)

for entry in "${DENY[@]}"; do
  term="${entry%%::*}"
  repl="${entry##*::}"
  hits=$(grep -rniE "$term" "${FILES[@]}" 2>/dev/null | grep -vE "$LINE_EXEMPT_RE" || true)
  if [[ -n "$hits" ]]; then
    fail "stale term /$term/ → should be: $repl"
    echo "$hits" | sed 's/^/      /'
  fi
done
[[ $FAIL -eq 0 ]] && pass "no stale terms"

# ---------------------------------------------------------------------------
# 2. Capability framing
#    Capabilities are enforced by the room they run in (SKILLS.md). This
#    section previously enforced the OPPOSITE rule — that every doc must say a
#    capability declares and does not enforce. That was accurate while no
#    runtime could restrict a tool, and it kept passing after the decision
#    reversed only because the new wording happened to avoid its phrases.
#    It now fails stale "declares, does not enforce" language outside a
#    historical note. The principle underneath is unchanged: a description
#    never claims more enforcement than the running system provides.
# ---------------------------------------------------------------------------
echo
echo "2. Capability framing"

HISTORY_RE='Correction|previously|superseded|Superseded|earlier caveat|said so plainly|Revisited'
stale_cap=$(grep -niE 'capabilit(y|ies)[^.]{0,80}(declares? (a tool grant|rather than enforc)|does not enforce|is (currently )?declarative)|declares a tool grant' "${FILES[@]}" 2>/dev/null \
  | grep -vE "$HISTORY_RE" | grep -v 'DOC-CHANGELOG.md' || true)
if [[ -n "$stale_cap" ]]; then
  fail "a doc still describes capabilities as declarative-only; they are enforced by the room (SKILLS.md):"
  echo "$stale_cap" | sed 's/^/      /'
else
  pass "capabilities described as enforced by the room"
fi

# ---------------------------------------------------------------------------
# 3. Build status must live only in STATE.md
# ---------------------------------------------------------------------------
echo
echo "3. Status containment"

STATUS_RE='(zero missions|no mission has run|export engine (is )?(un|not )started|[0-9]+ of (19|nineteen) agent|not started —|171 tests)'
status_leaks=$(grep -rniE "$STATUS_RE" "${FILES[@]}" 2>/dev/null \
  | grep -v 'STATE\.md' \
  | grep -vE 'STATE\.md|see .STATE|link' || true)

if [[ -n "$status_leaks" ]]; then
  ylw "  ! build status appears outside STATE.md:"
  echo "$status_leaks" | sed 's/^/      /'
  ylw "    (link to STATE.md instead)"
  # Warn-only unless it is in a shapes/stack doc, where it is always wrong.
  hard=$(echo "$status_leaks" | grep -E 'DATA-CONTRACTS|TECH-STACK' || true)
  [[ -n "$hard" ]] && fail "status in a shapes/stack doc — must link to STATE.md instead"
else
  pass "status contained"
fi

# ---------------------------------------------------------------------------
# 4. Required documents exist
# ---------------------------------------------------------------------------
echo
echo "4. Required documents"

REQUIRED=(PRODUCT.md STATE.md DECISIONS-V2.md DATA-CONTRACTS-V2.md TECH-STACK.md DOC-OWNERSHIP.md)
for r in "${REQUIRED[@]}"; do
  [[ -f "$DOCS/$r" ]] || fail "missing required doc: $r"
done

# Referenced-but-absent docs
refs=$(grep -rhoE '`[A-Z][A-Z0-9-]+\.md`' "${FILES[@]}" 2>/dev/null | tr -d '`' | sort -u)
for r in $refs; do
  if [[ ! -f "$DOCS/$r" ]]; then
    ylw "  ! referenced but absent: $r"
  fi
done
pass "required docs present"

# ---------------------------------------------------------------------------
# 5. Epistemic markers present
# ---------------------------------------------------------------------------
echo
echo "5. Epistemic markers"

for f in "$DOCS/PRODUCT.md"; do
  [[ -f "$f" ]] || continue
  if ! grep -qE '\[(built|specced|hypothesis|attestation|unspecified)\]' "$f"; then
    fail "$(basename "$f") carries no epistemic markers"
  else
    pass "$(basename "$f") marked"
  fi
done

# ---------------------------------------------------------------------------
# 6. Uncited statistics in PRODUCT.md
# ---------------------------------------------------------------------------
echo
echo "6. Uncited figures"

if [[ -f "$DOCS/PRODUCT.md" ]]; then
  # Numbers with % or 'x' outside the Sources section, without a nearby marker
  body=$(sed '/^## Sources/,$d' "$DOCS/PRODUCT.md")
  nums=$(echo "$body" | grep -nE '[0-9]+ ?%|[0-9]+×|[0-9]+ times' | grep -viE '\[hypothesis\]|pending citation' || true)
  if [[ -n "$nums" ]]; then
    fail "uncited figures in PRODUCT.md body:"
    echo "$nums" | sed 's/^/      /'
  else
    pass "no uncited figures"
  fi
fi

# ---------------------------------------------------------------------------
# 7. Roster integrity — every model role has a real agent, counts match
#    Added after an audit found three roles unassigned and one fact stated
#    as 12, 13, and 14 in different places. The first audit script also
#    missed one: it counted a role as assigned if its name appeared anywhere
#    in the table, so a row whose agent was "—" passed. This checks the row.
# ---------------------------------------------------------------------------
echo
echo "7. Roster integrity"

if [[ -f "$DOCS/ROLES.md" && -f "$DOCS/ROSTER-V2.md" ]]; then
  roster_out=$(python3 - "$DOCS" <<'PYEOF'
import re, sys
d = sys.argv[1]
roles = open(f"{d}/ROLES.md", encoding="utf-8").read()
roster = open(f"{d}/ROSTER-V2.md", encoding="utf-8").read()
problems = []

model = [m.group(1) for m in re.finditer(r'^\| `([a-z-]+)` \| model \|', roles, re.M)]
FIRM = {"intake", "strategy", "research", "client-ops"}   # between missions, not in a cut
mission_model = [r for r in model if r not in FIRM]

def section(text, start, end):
    i = text.find(start); j = text.find(end, i + 1)
    return text[i:j] if i >= 0 and j > i else ""

def assigned(table_text, agent_col):
    covered = set()
    for line in table_text.split('\n'):
        if not line.startswith('|') or '---' in line:
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) <= agent_col:
            continue
        agent = cells[agent_col]
        if agent in ('', '—', '-', 'Agent'):
            continue                       # "—" means nobody; a mention is not an owner
        covered |= set(re.findall(r'`([a-z-]+)`', line))
    return covered

horiz = section(roster, "## The horizontal instantiation", "### Mount table")
vert  = section(roster, "### Role assignment", "### Why the names")

for name, text, col in (("horizontal", horiz, 1), ("vertical", vert, 0)):
    if not text:
        problems.append(f"{name} assignment table not found")
        continue
    missing = sorted(set(mission_model) - assigned(text, col))
    if missing:
        problems.append(f"{name} cut: model roles with no real agent: {', '.join(missing)}")

# Firm roles must be covered in the Command Center section
cc = section(roster, "## Command Center", "## What this means")
firm_missing = sorted(r for r in FIRM if f"`{r}`" not in cc)
if firm_missing:
    problems.append(f"firm roles absent from Command Center: {', '.join(firm_missing)}")

# Stated count of always-present model agents vs the table
WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
always = 0
for line in horiz.split('\n'):
    cells = [c.strip() for c in line.strip('|').split('|')]
    if len(cells) >= 4 and cells[3] == 'always' and cells[1] not in ('operator', '—'):
        always += 1
m = re.search(r'\*\*([A-Za-z]+) model agents in every mission', horiz)
if not m:
    problems.append("horizontal cut: no stated count of always-present model agents")
elif WORDS.get(m.group(1).lower()) != always:
    problems.append(f"horizontal cut: text says {m.group(1).lower()} model agents, table has {always}")

# Role totals in ROLES.md must match the counted rows
rows = re.findall(r'^\| `[a-z-]+` \| (model|code|human) \|', roles, re.M)
tot = re.search(r'\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|', roles)
if tot:
    want = tuple(int(x) for x in tot.groups())
    got = (len(rows), rows.count('model'), rows.count('code'), rows.count('human'))
    if want != got:
        problems.append(f"ROLES.md totals say {want}, rows count {got}")

print("\n".join(problems))
PYEOF
)
  if [[ -n "$roster_out" ]]; then
    while IFS= read -r line; do fail "$line"; done <<< "$roster_out"
  else
    pass "every model role has a real agent; counts match the tables"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Merge rule — roles merge within a side, never across one
#    Sides are derived from the families in ROLES.md, not from a hand-kept
#    list: Foundation and Build are authors, Verify is testers, Review and
#    Operate's model roles are judges, fixture stands alone. Any assignment
#    row whose roles span two sides fails. Any roster that has an author must
#    also have a tester, a judge, and the fixture.
# ---------------------------------------------------------------------------
echo
echo "8. Merge rule"

if [[ -f "$DOCS/ROLES.md" && -f "$DOCS/ROSTER-V2.md" ]]; then
  merge_out=$(python3 - "$DOCS" <<'PYEOF'
import re, sys, os
d = sys.argv[1]
roles = open(f"{d}/ROLES.md", encoding="utf-8").read()
FAMILY_SIDE = {"Foundation": "author", "Build": "author", "Verify": "tester",
               "Review": "judge", "Operate": "judge"}
side, family = {}, None
for line in roles.split('\n'):
    h = re.match(r'^### (\w+) — ', line)
    if h:
        family = h.group(1)
    m = re.match(r'^\| `([a-z-]+)` \| model \|', line)
    if m and family in FAMILY_SIDE:
        side[m.group(1)] = FAMILY_SIDE[family]
side["fixture"] = "fixture"          # never merges, whatever its family
problems = []

def section(text, start, end):
    i = text.find(start); j = text.find(end, i + 1)
    return text[i:j] if i >= 0 and j > i else ""

def rows(text):
    for line in text.split('\n'):
        if line.startswith('|') and '---' not in line:
            yield line

def check_rows(label, text):
    for line in rows(text):
        found = [r for r in re.findall(r'`([a-z-]+)`', line) if r in side]
        sides = {side[r] for r in found}
        if len(sides) > 1:
            agent = line.strip('|').split('|')[0].strip()
            problems.append(f"{label}: a row spans {sorted(sides)} — {', '.join(found)}")

roster = open(f"{d}/ROSTER-V2.md", encoding="utf-8").read()
check_rows("horizontal cut", section(roster, "## The horizontal instantiation", "### Mount table"))
check_rows("vertical cut",   section(roster, "### Role assignment", "### Why the names"))

if os.path.exists(f"{d}/TEMPLATES.md"):
    t = open(f"{d}/TEMPLATES.md", encoding="utf-8").read()
    block = section(t, "### Recommended rosters", "### What the three cover")
    for name in ("template-fullstack", "template-audit", "template-integration"):
        start = block.find(f"**`{name}`")
        if start < 0:
            problems.append(f"{name}: roster not found in TEMPLATES.md")
            continue
        nxt = block.find("\n**`template-", start + 1)
        sub = block[start:nxt] if nxt > 0 else block[start:]   # the last template runs to the end of the block
        check_rows(name, sub)
        present = set()
        for line in rows(sub):
            present |= {side[r] for r in re.findall(r'`([a-z-]+)`', line) if r in side}
            if re.search(r'\|\s*(?:[A-E]\s*\|\s*)?Atlas\b', line):
                present.add("author")
        if "author" in present:
            missing = {"tester", "judge", "fixture"} - present
            if missing:
                problems.append(f"{name}: writes source but has no {', '.join(sorted(missing))}")

print("\n".join(problems))
PYEOF
)
  if [[ -n "$merge_out" ]]; then
    while IFS= read -r line; do fail "$line"; done <<< "$merge_out"
  else
    pass "no agent spans two sides; every roster that writes source has a tester, a judge, and the fixture"
  fi
fi

# ---------------------------------------------------------------------------
echo
if [[ $FAIL -eq 0 ]]; then
  grn "docs OK"
else
  red "docs check FAILED"
fi
exit $FAIL
