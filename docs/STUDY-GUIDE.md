# AVEL Study Guide

For a developer joining the project. Work through it in order. Each section ends with questions you should be able to answer without looking.

Pair this with `avel-gates-diagram.html` (the visual) and `WHY-AVEL-EXISTS.md` (the market research behind it).

---

## 1. The one idea

**AI produces work that looks finished but isn't.**

Not wrong answers. Missing layers. The model builds exactly what was asked and nothing that was assumed. Nobody asked for row-level security, so there is none. The code compiles, lints, typechecks, and reads as correct in review — because it is correct for what was requested.

An experienced engineer adds the access check out of habit. A model has no habit.

Everything below is a defense against that one thing. If a rule here does not trace back to it, the rule is wrong.

**Check yourself:** why does an ordinary code review often miss these defects?

---

## 2. Evidence, not assertion

An agent will tell you the tests pass. That is a claim, not evidence.

The gate reads results from a **file produced by a CI runner**. Never from an agent's report. The distinction sounds pedantic until you notice that the agent has a stake in the answer.

Same logic one level down: a test suite that runs and passes tells you the code executed. It does not tell you the tests checked anything. A test with no assertions passes every time.

That is what **mutation testing** solves. It changes the source — flips a comparison, deletes a line — and re-runs the suite. If the tests still pass, they were not checking that behavior. It does not care which agent wrote the tests, which is exactly why it works where a rule about who writes what would not.

**Check yourself:** an agent writes a feature and its tests. Both pass. What have you actually learned?

---

## 3. The four phases

Phases are global. A team or a feature is a label, not a schedule.

| Phase | What happens |
|---|---|
| **A — Foundations** | Shared surface: contract, conventions, composition root, shared package. Runs **before** the first feature agent. |
| **B — Builders** | Feature work, inside mounts. Parallel, but each agent is sealed into its own paths. |
| **C — Verification** | Tests and audits, written by agents that cannot write source. |
| **D — Quality** | Findings in, ship-or-block out. |

**Why foundations goes first:** the first feature agent needs shared surface that does not exist yet and owns none of it. We learned this the expensive way — Mission 002 blocked four times before the first commit because foundations was scheduled after, not before.

**Check yourself:** why can't a feature agent create the shared package itself?

---

## 4. The gate: four stages

| Stage | Checks |
|---|---|
| **1. Verify** | build, tests, static analysis, coverage delta, mutation score, ownership, permissions, absence, findings |
| **2. Conform** `[attestation]` | does what phase 2 built match the contract phase 1 locked. Enforced by a report until `CLIENT-CONTRACT-CONFORMANCE.md` is answered. |
| **3. Blast radius** | exactly which files change in the client's repo, plus a staleness guard |
| **4. Deliver** | zip, pull request, or direct commit |

**Any single failing check stops delivery.** No partial credit, no majority vote. Fixing everything else changes nothing while one check is red.

**There is deliberately no AI review stage.** No inference runs in the render, freeze, gate, or delivery path. A model deciding whether something ships is the exact thing this system exists to avoid.

**Check yourself:** why is the ship-or-block decision a function rather than an agent?

---

## 5. The five checks that are ours

Build and lint are table stakes. These five are the product.

**Mutation score.** Proves the tests assert something. Catches the case where one agent wrote both the code and its tests.

**Ownership.** Every agent has declared writable paths, enforced as filesystem mounts `[specced]`. A write outside them fails at the filesystem, not at review time. Test agents have no write access to source at all — an agent that can edit the code it is testing can make any failing test pass by changing the code instead of fixing the bug.

**Permission matrix.** Generate the full role × resource × state grid from the schema and run every cell. A cell that is neither explicitly allowed nor explicitly denied is a gap. End-to-end tests only walk paths a request happens to take; this walks all of them.

**Absence.** Every other check inspects what is present. This one inspects what is missing — every table should have a security policy, every endpoint an authorization check, every mutation a log entry. Derived from the contract, not from opinion.

**Findings.** A confirmed defect from a past mission becomes an executable check on every mission after it. Deterministic list matching. No retrieval, no inference, nothing auto-promoted.

**Check yourself:** which of these five would have caught a database shipped with no row-level security?

---

## 6. Mounts and ownership

Boundaries are not advice. They are mounts.

If an agent may only write `components/`, we mount only `components/` as writable. The agent does not *choose* not to touch the data layer. It **cannot**.

That single decision turns every rule in the roster into an enforced invariant, and it produces the ownership check for free.

**The rule that decides where a boundary goes:**

> A boundary is worth its handoff cost only if it can be written as a set of writable paths.

If you cannot express it as paths, it is not a boundary. It is a paragraph.

**Check yourself:** two agents both need to write into `modules/transactions/`. What does the rule say about that split?

---

## 7. Horizontal and vertical

Picture the codebase as a grid. Columns are features. Rows are layers.

**Horizontal cut** — group the rows. One agent owns a layer across every feature. Building one feature takes several agents.

**Vertical cut** — group the columns. One agent owns a feature through every layer. Building one feature takes one agent.

**Which one is not a preference.** It is decided by which boundary is a real directory:

- Top level looks like `services/`, `routes/`, `db/` → layer boundary is a directory → **horizontal**
- Top level looks like `modules/transactions/`, `modules/documents/` → feature boundary is a directory → **vertical**

CounselOS runs NestJS, which puts a module's controller, service, and repository in one folder. So: vertical. Forcing a horizontal cut there would give you two agents writing into the same directory, and a mount cannot express "you may write `*.service.ts` but not `*.controller.ts`."

**A second meaning of "horizontal":** some agents own no feature at all. Verification, foundations, and security cut across every column. They build nothing.

**Why they must own nothing:** owning territory disqualifies you from judging a seam. A feature agent cannot fairly audit whether its own guards compose with another feature's.

**Naming follows from this.** Every agent has a personal name — its identity, how it works. An agent scoped to one part of a project also carries a territory, written Atlas · scheduling. The territory and the project, never the name, are what tell one app's feature from another's.

**Check yourself:** what does the territory in Atlas · scheduling tell you that the name does not?

---

## 8. Blast radius

Before anything is written to a client's repository, we compute what will change:

- **CREATE** — path does not exist remotely
- **OVERWRITE** — exists and the content differs
- **UNCHANGED** — exists and is byte-identical
- **PRESERVE** — exists remotely, untouched

Done in one API call. Git stores a content hash per file, and we compute the same hash locally on our own bytes, so no file is ever downloaded.

**The part people miss:** between computing the preview and delivering, the repository can change. Someone pushes. So we record the commit we computed against and re-read it at delivery. If it moved, we refuse.

A preview that can quietly go stale is worse than no preview, because it manufactures confidence.

**Check yourself:** why is a preview that silently goes stale worse than having no preview?

---

## 9. Determinism

The render is deterministic: same inputs, same bytes, every time. No clock, no randomness, no unstable ordering.

Traps that break it, all of which have burned someone:

| Trap | Fix |
|---|---|
| `fs.readdir` returns OS-dependent order | Sort before iterating |
| `JSON.stringify` key order is not stable across integer-like keys | Sort keys explicitly |
| `localeCompare` is locale-sensitive | Use an explicit comparator |
| `new Date()`, `Date.now()`, `randomUUID()` in the render path | Inject from above; never call inside |
| Line endings and trailing newlines differ by platform | Normalize to LF, always end with a newline |

**Test it:** render twice in one process, twice in fresh processes, and once under `TZ=Asia/Tokyo LANG=tr_TR`. Diff the hashes. Turkish locale breaks case-insensitive comparison, so passing under it means you are probably clean.

**What determinism buys:** reproducibility and auditability — the same inputs produce the same bytes, and what was verified is what shipped. It does **not** make the output correct. The gates do that. Determinism makes the gates trustworthy.

**Check yourself:** a preview and the real export produce different content hashes. What does that tell you?

---

## 10. How you work here

**Stay inside your mount.** A write outside your declared paths fails the ownership check and the mission does not ship.

**File blockers, do not absorb them.** If the dispatch forbids something you need, write it down with a documented workaround. Do not route around the boundary quietly. In Mission 002, three blockers were filed and zero were absorbed — that was the instructed behavior working the first time it was tested, and it is how we found that all three failures were the operator's, not the agent's.

**Testers never modify code under test.** Enforced by the mount, not by discipline.

**Log decisions as you make them.** Reconstruction is fiction. You will write a tidier story than what happened.

**Log cost at dispatch, not at close.** An unlogged token is gone permanently. There is no record to go back to.

**Report before fixing** when you find a doc that disagrees with reality. A doc someone relies on, silently rewritten, is a regression even when the rewrite is better.

---

## Self-test

If you can answer these without looking, you have it.

1. Why is a passing test suite not evidence that the tests check anything?
2. What does mutation testing do, and why does it not matter who wrote the tests?
3. Why does the gate read a CI artifact instead of an agent's report?
4. Name the four gate stages in order.
5. Why is there no AI review stage?
6. What decides whether a codebase gets a horizontal or vertical cut?
7. Why can't a feature agent own the security review?
8. What is the difference between a check that confirms a policy exists and one that confirms it works?
9. Why does the blast radius record a commit SHA?
10. What does determinism buy, and what does it not buy?

---

## Where to go next

| Document | Covers |
|---|---|
| `WHY-AVEL-EXISTS.md` | The market research and the breach record |
| `ROSTER-V2.md` | Agents, cuts, mounts, edges |
| `SANDBOX.md` | Where agents run and how mounts are enforced |
| `BLAST-RADIUS.md` | The preview, in full |
| `DECISIONS-V2.md` | Why every rule is the way it is |
| `DEV-TIPS.md` | Practical build guidance |
| `GOLDEN-FIXTURE.md` | The package the renderer must reproduce |

Read `DECISIONS-V2.md` before proposing changes. Several ideas in it were considered and rejected, with reasons.
