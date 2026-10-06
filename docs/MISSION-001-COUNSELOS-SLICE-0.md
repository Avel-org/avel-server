# Mission 001 — CounselOS Slice 0

*AVEL's first measured mission. Fill this in **as Slice 0 runs**, not after.*

**Why this document is the most valuable artifact in AVEL right now.** Every claim in `DECISIONS-V2.md` is explicitly a hypothesis until one mission runs end to end and gets measured. This is that mission. It either validates the roster design or kills parts of it, and both outcomes are worth more than another architecture decision.

---

## Mission record

| | |
|---|---|
| **Mission** | CounselOS Slice 0 — foundation |
| **Client** | [firm name / internal] |
| **Repo** | `Javaris500/CounselOS` |
| **Type** | full-build |
| **Started** | |
| **Shipped** | |
| **Gate** | `pnpm --filter web test:e2e` green |

**Definition of done for this slice:** [copy verbatim from `docs/00-developer-guide.md` — do not paraphrase it here, and do not change it mid-mission. If it changes, log the change and why.]

---

## Roster

Which agents were active, in which wave. Copy from `.team-5/`.

| Wave | Agent | Role this slice | Writable paths | Active? |
|---|---|---|---|---|
| 1 | | | | |
| 1 | | | | |
| 2 | | | | |
| 2 | | | | |
| 3 | | | | |

**Agents deliberately left off, and why:**

**Preset used (if any):**

---

## Wave log

One entry per wave. Written when the wave closes, not at the end of the mission.

### Wave 1 — [name]

- **Started / closed:**
- **Agents:**
- **Output:** [what artifacts exist that didn't before]
- **Gate:** [which gate, passed or failed, on what evidence]
- **Rework:** [anything redone, and why]
- **Time:** [wall clock, and rough hands-on vs. waiting]

### Wave 2 — [name]

### Wave 3 — [name]

---

## The four questions this mission has to answer

These are the hypotheses under test. Answer each with evidence, not impression.

### 1. Did the file boundaries prevent divergence, or just slow things down?

The claim is that scoped `writable_paths` per agent stop parallel work from producing incompatible answers.

- **Violations attempted:** [an agent writing outside its scope — how many, which agents]
- **Divergence that happened anyway:** [two agents producing incompatible work despite the boundaries]
- **Cost:** [times a boundary blocked work that should have proceeded]
- **Verdict:** held / partially held / theater

### 2. Did the shared pattern registry hold?

The claim is that a shared registry keeps parallel agents architecturally consistent.

- **Drift found:** [same problem solved two different ways in one slice]
- **Registry hits:** [times an agent actually used the registry instead of inventing]
- **Verdict:**

### 3. Which gates actually ran, and which got skipped?

Not which gates are *defined* — which ones you consulted while working.

| Gate | Ran? | Blocked anything? | Skipped, and why |
|---|---|---|---|
| controller→service→repository layering | | | |
| modules import services not repositories | | | |
| `data-testid` in same commit as component | | | |
| API E2E (module gate) | | | |
| Playwright (slice gate) | | | |
| lint + typecheck | | | |

**The important column is the last one.** A gate you skipped under pressure is more informative than one that passed.

### 4. Did anything ship that looked finished and wasn't?

This is AVEL's entire thesis. If the answer is no, say so and note what caught it. If yes, that's the most valuable entry in this document.

- **What:**
- **Caught by:** [gate / manual review / not caught until later]
- **Would a mutation-score floor have caught it?** [this directly tests the empirical-gate correction in DECISIONS-V2]

---

## Cost

Capture as you go. It cannot be reconstructed.

| Agent | Model | Input tokens | Output tokens | Est. cost |
|---|---|---|---|---|
| | | | | |
| | | | | |
| **Total** | | | | |

- **Wall-clock time:**
- **Hands-on time (yours):**
- **Cost per shipped slice:**

**Why this matters more than it looks:** `DECISIONS-V2.md` raised cost governance to a top risk with no mechanism behind it. This table is the data that makes `Mission.spend_ceiling_usd` a real number instead of a guess.

---

## What the docs got wrong

Every place `CLAUDE.md`, `docs/`, or the `.team-5/` roster said something that turned out to be wrong, missing, or ambiguous during the run.

| Doc | What it said | What was true | Fixed? |
|---|---|---|---|
| | | | |

**Do not fix these during the mission.** Log them, finish the slice, then fix. A doc changing under an agent mid-run is its own failure mode.

---

## Verdict

Written after the slice gate goes green. Three paragraphs, no more.

**What held.**

**What didn't.**

**What changes in AVEL as a result.** — Be specific. "Improve the roster" is not a finding. "Cut Wave 2 to two agents because the other three produced nothing that survived review" is.

---

## Feeds back into

- [ ] `SURPRISES.md` — patterns section updated
- [ ] `DECISIONS-V2.md` — any hypothesis promoted to `[built]` or killed
- [ ] `STATE.md` — mission count no longer zero
- [ ] `DEV-TIPS.md` — anything learned that generalizes
- [ ] The roster itself — agents added, cut, or re-scoped
