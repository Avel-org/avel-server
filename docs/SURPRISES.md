# Surprises

*One line every time an agent does something you didn't predict. Good or bad.*

**Why this file exists.** AVEL's roster, wave sequencing, and file boundaries are hypotheses. This is the only place they get tested against reality. It also becomes the anti-pattern library and, eventually, the seed data for KnowledgeEntry — which is why it must be written *during* the mission, not reconstructed after.

**Rules**
- Write it the moment it happens. Reconstruction is fiction.
- One line. If it needs a paragraph, it's a finding — put it in the mission log instead.
- Record good surprises too. "Kel caught a schema mismatch nobody asked it to look for" is as informative as a failure.
- Never delete an entry. Strike through if superseded.

**Format:** `YYYY-MM-DD · slice · agent · what happened`

---

## AVEL frontend — day one

2026-08-29 · CC-D1 · session 1 · A CSS comment describing a bug contained the two characters that close a comment. It closed early, the rest of the file became noise the browser silently ignored, the entire token patch was disabled, and every build passed with no warning. Found by reading one computed value out of the finished stylesheet — a corner radius read 0.125rem where the design said 4px.

2026-08-29 · CC-D1 · session 1 · Tailwind v4 tree-shakes unused `@theme` variables. Brand tokens are consumed through plain CSS custom properties, which it cannot see, so it stripped every gate, diff, radius and motion token from the dark theme while leaving `.light` intact — light-mode values are written differently. Would have shipped an app correct in light and quietly wrong in dark, with a green build. Fix: `@theme static`.

2026-08-29 · CC-D1 · session 3 · The golden fixture fails the hard block it is meant to demonstrate. The playbook declares waves A→B→C→D and requires an active agent in the earliest declared wave; the roster staffs B and C only. Found before writing a byte, by reading two documents and comparing. Resolved by giving the operator a real RosterEntry rather than adding an exception to the rule.

2026-08-29 · CC-D1 · session 2 · `gitBlobSha` matched `git hash-object` on the first attempt across 24 fixtures — and volunteered that the formula had been verified against `git hash-object` during the read turn, so it matched first because the checking preceded the writing. Then mutated its own implementation three ways to prove the suite kills bugs, and cross-checked every fixture against `git ls-files -s`.

2026-08-29 · CC-D1 · session 1 · `git add -A` staged 22 files belonging to two other sessions, both mid-write. Later a directory-wide `git checkout --` discarded another session's uncommitted work. **Neither was a boundary violation** — every individual write stayed inside its mount. A mount constrains where a process writes, not what a command reaches. Cause: three sessions in one working directory. See SANDBOX.md.

2026-08-29 · CC-D1 · session 1 · Nearly filed a file as missing. An earlier `cd` had persisted and the path was relative to the wrong directory. An error from a tool means the tool failed; it does not mean the answer is no.

2026-08-29 · CC-D1 · session 2 · Filed three blockers rather than widening its own permissions: tsconfig `types` was `["vite/client"]` only so crypto would not typecheck, no glob matcher was installed though `declaredWritablePaths` needs one, and fixtures fell inside biome's format set — a formatter run would have silently invalidated four expected SHAs. All three were real and all three were the operator's.

## Slice 0 — foundation

---

## Slice 1

---

## Slice 2

---

## Patterns (fill in after ~3 slices)

*Once entries accumulate, group them. Recurring shapes are the finding; individual entries are just data.*

| Pattern | Times seen | Agents involved | Mechanical fix? |
|---|---|---|---|
| | | | |

**The question this table answers:** which failures need a *mechanism* rather than a better instruction? Anything appearing three times is not an instruction problem.
