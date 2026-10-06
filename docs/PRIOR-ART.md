# Prior Art

**Status: build-or-wrap resolved 2026-08-21 (map, don't adopt). Sandbox questions H1 to H3 answered in `SANDBOX.md`.**

*Owns: what already exists in this space, what AVEL should adopt rather than rebuild, and what remains genuinely AVEL's. Read before building the export engine.*

---

## The finding

**AVEL's delivery gate already exists, shipped, MIT-licensed, at 5.2k stars.**

`kunchenguid/no-mistakes` puts a local git proxy in front of the real remote. You push to the gate instead of `origin`; it spins up a disposable worktree, runs a validation pipeline — review → test → docs → lint — and forwards the branch to the push target and opens a PR **only after every check passes**. 392 commits, Go, 78 releases.

Read that against `PRODUCT.md`'s core mechanism. It is the same sentence.

This is not a reason to stop. It is a reason to stop building the part that exists and build the part that doesn't.

---

## no-mistakes

5,200 stars. 392 commits. Go. MIT licensed.

### What it is

A gate between committed work and the remote. Three entry points — `git push no-mistakes`, a TUI, and a `/no-mistakes` agent skill — all running one pipeline.

### The overlap with AVEL, stated plainly

| AVEL concept | `no-mistakes` equivalent | Verdict |
|---|---|---|
| Export won't deliver unless checks pass | The entire product | **Built. Better tested than AVEL will be.** |
| `verifying` status between render and delivery | The pipeline stage | Built |
| `Export.verification` structured artifact | `.no-mistakes/evidence/` — evidence committed to the repo | Built, and the on-disk evidence directory is a better idea than a JSONB column |
| `GitHubPrTarget` opening a clean PR | Automatic, with a generated body | Built |
| Disposable, non-disruptive verification environment | Disposable worktree | Built |
| Agent-agnostic runner | claude, codex, rovodev, opencode, pi, copilot, `acp:*`, with ordered fallbacks | Built, and broader than AVEL planned |

### Three ideas worth stealing regardless of what you decide

**1. Evidence as committed files, not a database column.** `.no-mistakes/evidence/` lives in the repo. That means the proof travels with the code, survives the platform, and is reviewable in the PR diff. AVEL's `Export.verification` JSONB is queryable but invisible to the client. **Do both** — render the evidence into `.avel/evidence/` in the package *and* keep the structured column for correlation. That is the same split as `version_manifest` in Postgres versus bytes in R2, and for the same reason.

**2. The findings model: `auto-fix` versus `ask-user`.** Safe, mechanical fixes get applied automatically; anything touching intent gets escalated to a human. AVEL has one binary — pass or fail — and a `gate_override` for the exceptions. A three-way split is better: *mechanically fixable* (fix it), *needs judgment* (escalate), *hard violation* (refuse, no override). AVEL's `BLAST_RADIUS_VIOLATION` is already the third category; it just lacks the first two as named concepts.

**3. They test their own workflows.** `workflow_ci_test.go`, `workflow_release_test.go`, `install_script_test.go`, `makefile_test.go`, `workflow_guard_generated_files_test.go`. Their CI configuration, install script, and Makefile all have tests. That is the "mechanism, not intention" discipline applied to their own infrastructure — the same move as `scripts/check-docs.sh`, and further along.

### Decision: map, don't adopt (resolved 2026-08-21)

**AVEL builds its own gate and borrows the design.** `no-mistakes` is prior art to learn from, not a dependency.

**The deciding reason is U2.** Its pipeline is AI-driven, which puts inference in the delivery path. AVEL's standing rule is that no inference enters render, freeze, gate, or delivery — that is the principle every other guarantee rests on, and wrapping a tool that violates it would hollow out the claim while appearing to strengthen it.

**Two supporting reasons:**

- **Different unit of work.** Its gate intercepts a *branch push*. AVEL's gate sits on a *rendered mission package* delivered into a client repository — content-addressed, reproducible, with a blast radius computed against the client's tree. Those are different artifacts at different boundaries.
- **U4.** Its evidence directory lands inside the client's repo under a third party's name. AVEL's delivery is made on the client's behalf and should not carry someone else's branding or format.

**What this costs, stated plainly:** the export engine stays on the critical path as AVEL's own module. That is the price of the determinism rule, and it is worth paying — but it means **building the smallest gate that satisfies the thesis, not the most complete one.** Their pipeline has seven stages. AVEL needs four.

### The mapping

| `no-mistakes` mechanism | AVEL equivalent | Verdict |
|---|---|---|
| **Push proxy** — the gate sits where work leaves for the remote | `export.create` — the gate sits where the package leaves for the client repo | **Confirms the placement.** Two independent arrivals at "gate the egress point, not the commit." |
| **Disposable worktree** per run | `SANDBOX.md` Tier 0 — worktree + container per agent | Already specced. Confirms the approach. |
| **`.no-mistakes/evidence/`** — evidence as committed files | `.avel/evidence/` rendered into the package, alongside `Export.verification` | **Adopt.** Proof travels with the code, reviewable in the PR diff. Same split as manifest-in-Postgres / bytes-in-R2. |
| **Findings: auto-fix vs. ask-user** | Three-way: mechanically-fixable, needs-judgment, hard violation | **Adopt and extend.** AVEL's `BLAST_RADIUS_VIOLATION` is already the third class; the first two are unnamed. |
| **Pipeline stage: review** (AI) | — | **Reject.** Inference in the delivery path. This is the U2 line. |
| **Pipeline stage: test** | `verification.tests` + `coverage` + `mutation` | Have it, and AVEL's is stronger — mutation scoring is the piece that catches a suite asserting nothing. |
| **Pipeline stage: lint** | `verification.analysis` | Have it. |
| **Pipeline stage: docs** | — | **Consider.** AVEL has no docs gate. A mission that ships undocumented interfaces is a real failure mode and this is cheap to add. |
| **Pipeline stage: PR + CI** | `GitHubPrTarget` + branch adoption on retry | Specced. |
| **`.no-mistakes.yaml`** — per-repo pipeline config | `Playbook` + `RepoPolicy` | Have both, and AVEL's is richer — process per mission *type*, not per repo. |
| **Agent-agnostic runner with ordered fallbacks** | The Capability-type Skill that produces the verification artifact | **Adopt the fallback chain.** A runner that fails should degrade to the next, not fail the export. |
| **`axi`** — non-interactive machine interface | AVEL's headless export path | **Adopt the principle.** Every gate must run with no TUI and no human present, or it cannot run in CI. |
| **Tests for their own CI, Makefile, install script** | `scripts/check-docs.sh`, extended to workflows | **Adopt.** Same discipline, further along. |

### What AVEL has that they do not

This is the honest scope of what remains worth building, and it is the reason mapping rather than adopting is the right call:

- **Mission composition** — which agents, equipped how, in what phases
- **The loadout screen and coherence** — the authoring surface entirely
- **Playbooks** — process per mission type, not per repository
- **Deterministic render** of a mission package, content-addressed and reproducible
- **Blast radius** against a *client* repository, with the TOCTOU guard
- **The multi-client agency layer** — `Connection` scoped per engagement, revocation at engagement close, `RepoPolicy` per repo
- **Client-side phase1↔phase2 conformance**

None of that exists in `no-mistakes`, and none of it is a gate. **The gate is the commodity; the mission is the product.** Build the gate small, and spend the effort above it.

---

## treehouse

1,000 stars. Go. MIT licensed.

A pool of reusable git worktrees so each agent session gets an isolated environment instantly, with dependencies and build cache intact. Detached HEAD to avoid branch-name conflicts, no daemon, durable leases with per-acquisition identity, in-use detection, atomic state with recovery.

### Direct relevance

AVEL runs multiple agents in waves. `SANDBOX.md` Tier 0 now specifies where they run: one worktree per agent. `treehouse` is a built implementation of that design.

### The design worth studying closely

**`treehouse destroy` is `BLAST-RADIUS.md`, arrived at independently.**

- Dry run by default; `--yes` to execute
- A risk-revealing preview with per-target status labels — `[disposable]`, `[leased]`, `[in-use:<pid>]`, `[unmerged]`, `[dirty]`, `[unverified]`, and combinations
- **Each risky class is its own opt-in flag** — `--include-unlanded`, `--include-in-use`, `--include-leased` — so removing risky targets can never be a reflexive `--yes`
- The old blanket `--force` was **removed**, explicitly because it overrode every protection at once
- Never prints "all destroyed"; the summary states exactly what was destroyed and what was skipped
- A single named target skipped for lack of a flag exits non-zero, so scripts notice

That is the same conviction as AVEL's preview — and the per-risk-class opt-in is *better* than AVEL's current design. **Adopt it.** `BLAST-RADIUS.md` currently treats all violations as one blocking class. Splitting them by risk type, each requiring its own explicit acknowledgment, is strictly stronger than one `BLAST_RADIUS_VIOLATION` code.

**Also worth adopting:** the ABA-protection pattern on leases — `--if-lease-id` and `--if-lease-holder` compared while holding the state lock, so a retry cannot release a later acquisition of the same path. That is precisely the TOCTOU problem `BLAST-RADIUS.md` solves with `base_commit_sha`, solved the same way in a different domain. Two independent arrivals at the same answer is good evidence the answer is right.

---

## personal-agent-template

Vercel Labs. 31 stars. TypeScript and Vue. MIT licensed.

Different domain — a durable personal agent with web chat, Slack, Linear, and long-term memory. Relevant to AVEL for exactly one thing.

### Memory writes require explicit approval

The agent proposes facts via a `save_memory` tool; **nothing is stored until the user approves it in chat.** Memory is five fixed categories, one prose block each. Import from an existing assistant, then edit or delete on a profile page.

`DECISIONS-V2.md` already says: provenance, candidate-versus-promoted status, and forgetting first; retrieval second; **auto-promote never.** This is that policy, shipped, in a product that has actual users.

**What to take from it:**

- **Approval is an in-flow interaction, not an admin screen.** The proposal surfaces where the work is happening. AVEL's KnowledgeEntry write-back should propose at retro time, in the same surface, not queue into a review backlog nobody opens.
- **Fixed categories beat freeform.** Five slots, one prose block each. AVEL's KnowledgeEntry has six types already; the lesson is to resist growing them and to resist arbitrary-length entries.
- **A bounded memory stays legible.** Small enough that a human can read the whole thing is a feature, not a limitation — and it is the practical defense against the poisoned-entry failure mode.

**What it does not solve:** cross-client scoping. This is a single-user personal agent. AVEL's `KnowledgeEntry.client_id` closes this: null means genuinely general, and nothing auto-promotes. See `DATA-CONTRACTS-V2.md`.

---

## hackerai

588 stars. 795 commits. TypeScript and Rust. Apache 2.0 with commercial restrictions.

An AI pentesting assistant. The product is irrelevant to AVEL; the **execution architecture is directly relevant**, because it answers two questions AVEL has left open.

### It answers the sandbox question

The agent runs untrusted code in **E2B** — a hosted sandbox service — rather than in a local container. AVEL's verification runner executes client dependencies and client tests, which is arbitrary third-party code, on a machine that must never hold the GitHub credential. `SANDBOX.md` answers where that runs: Tier 0 local container, Tier 1 remote VM.

E2B is one answer. Others: gVisor, Firecracker, a disposable cloud VM, or GitHub Actions runners if delivery moves to `no-mistakes`. AVEL's answer is in `SANDBOX.md`. hackerai shows what one such answer looks like in practice.

### It answers the durable-runtime question differently than AVEL did

The agent loop runs as a **Trigger.dev task** — an external durable runtime — with its own environment variables living on the worker rather than on the web host. AVEL chose pg-boss for the same reason (verification outlives a request and must survive a redeploy).

The environment split is the part worth noting regardless of which queue wins: **the worker's secrets are not the web app's secrets.** That is the same boundary as "the runner never sees the credential," enforced by deployment topology rather than by code.

### Two smaller things

**`skills-lock.json`.** A lockfile pinning agent skills, sitting next to `.agents/skills/`. AVEL versions `Skill` with a counter and relies on the frozen export snapshot for reproducibility. A lockfile is a different answer to the same problem — the *set* of skills at a point in time, resolvable and diffable, rather than reconstructed from a snapshot. Worth understanding before AVEL's skill library exists, because it is cheap now and awkward later.

**Moderation as a separate provider.** Content moderation runs through a different vendor than inference. Not currently relevant to AVEL, but the pattern — a check that does not share a provider with the thing being checked — is the same shape as reading verification from an artifact rather than from the agent.

---

## Agentic Design Patterns

2,800 stars. Reference material, not a tool.

**Not a tool.** A 424-page book by Antonio Gulli plus chapter notebooks — 21 chapters, 7 appendices. 7 commits.

**License warning, and it is the important part:** the repository states book content is © Antonio Gulli, all rights reserved; only the code examples are MIT. This is a third-party redistribution, not the author's own repo. **Do not vendor any of it into AVEL, do not paste chapters into agent context, and do not copy passages into AVEL's docs.** Read it, cite it, buy it. Treat anything derived from it as reference, not as an asset.

### The chapters that map onto AVEL's open problems

| Chapter | AVEL question it speaks to |
|---|---|
| 12 — Exception Handling and Recovery | What happens when a wave fails mid-mission; nothing in AVEL specifies recovery |
| 13 — Human-in-the-Loop | `gate_override`, the ask-user findings class, approval-gated memory writes |
| 16 — Resource-Aware Optimization | Cost governance, model tiering, the raised-but-unmechanized top financial risk |
| 18 — Guardrails / Safety | The runner/credential boundary, `writable_paths`, blast-radius violations |
| 19 — Evaluation and Monitoring | The measurement AVEL has none of |
| 8 — Memory Management | KnowledgeEntry, deferred until ~10 missions |
| 15 — Inter-Agent Communication | The phase1↔phase2 contract problem |
| Appendix G — Coding Agents | The whole domain |

**How to use it:** as a source of *names and known failure modes* for problems AVEL has already hit independently, not as a design to implement. The value is in discovering that a problem you solved by instinct has a name and a literature — which is how you find out whether your solution is the good one or the obvious one.

---

## Summary of changes to AVEL

**Adopt:**

| From | What | Into |
|---|---|---|
| `no-mistakes` | Evidence rendered as committed files, alongside the structured column | `BLAST-RADIUS.md`, render spec |
| `no-mistakes` | Three-way findings: auto-fix, ask-user, hard violation | `DECISIONS-V2.md`, gate model |
| `no-mistakes` | Test your own CI, install, and build config | `DEV-TIPS.md` |
| `treehouse` | Per-risk-class opt-in flags instead of one violation class | `BLAST-RADIUS.md` |
| `treehouse` | Worktree pool as the agent execution environment | Answered in `SANDBOX.md`: Tier 0, one worktree per agent |
| `personal-agent-template` | Approval in-flow, fixed categories, bounded size | KnowledgeEntry, when it is built |
| `hackerai` | A named sandbox for the verification runner | Answered in `SANDBOX.md`: Tier 0 local container, Tier 1 remote VM |
| `hackerai` | Worker secrets separate from web secrets, by deployment topology | `TECH-STACK.md`, operational notes |
| `hackerai` | Skill lockfile as an alternative to counter-versioning | `DATA-CONTRACTS-V2.md`, before the skill library exists |
| `Agentic-Design-Patterns` | Vocabulary and known failure modes — **reference only, license-restricted** | Reading, not code |

**Resolved 2026-08-21:** the export engine is built, not wrapped. See *Decision: map, don't adopt*.

**Unchanged and still AVEL's alone:**

- Mission composition and the roster
- The loadout screen and live coherence
- Playbooks as process per mission type
- Deterministic render of a mission package
- The multi-client agency layer: `RepoPolicy`, `Connection` scoped per engagement, revocation at engagement close
- Blast radius against a client repository rather than a local worktree
- Client-side phase 1 to phase 2 contract conformance

That last list is the honest scope of the project, and it is smaller and sharper than what the docs currently describe. **Smaller is the correct direction.** The standing problem has been design ahead of evidence; deleting work that someone else has already shipped better is the fastest available way to close that gap.

---

## Questions to answer before implementing any of this

**Why this section exists.** Adopting a dependency has the same failure mode as building one — enthusiasm ahead of evidence. Every row in the table above is currently a *good impression from a README*. None of it has been tested against AVEL's actual constraints. These are the questions that turn an impression into a decision.

**The rule:** nothing above gets implemented until its blocking questions are answered in writing, here, with a date. An unanswered blocking question means the item stays on this page and out of the codebase.

---

### Universal — ask these of every candidate

**U1. What does it cost to leave?**
If this dependency is abandoned, acquired, or relicensed in a year, what has to be rewritten? A tool that shapes AVEL's data model is a much bigger commitment than one that shapes a build step.

**U2. Does it fit AVEL's determinism rule, or bend it?**
The core is deterministic by design — no inference in render, freeze, gate, or delivery. `no-mistakes` runs an **AI-driven** pipeline. That is inference in the delivery path. Does composing it violate the standing rule, or does the rule apply only to AVEL's own render? **This needs an explicit answer, not an assumption**, because it is the one principle everything else in the architecture rests on.

**U3. What does the license actually permit for a commercial agency?**
MIT is fine. `hackerai` is Apache 2.0 **with commercial restrictions** — read them before any code moves. `Agentic-Design-Patterns` is all-rights-reserved book content.

**U4. Does adopting this make the client's package depend on it?**
A tool AVEL uses internally is reversible. A tool whose artifacts end up inside a client's repository is a commitment made on the client's behalf, and it outlives the engagement.

**U5. What is the smallest test that would falsify the enthusiasm?**
For each item: what is the one-afternoon experiment that shows this does *not* work for AVEL? Run that before the integration, not after.

---

### `no-mistakes` — the build-or-wrap decision

| # | Question | Blocking? |
|---|---|---|
| N1 | Can a **custom gate criterion** be added as a pipeline stage — specifically a mutation-score floor and a coverage delta? Read `.no-mistakes.yaml` and the pipeline docs. | **Yes — decides Option A vs. B entirely** |
| N2 | Does the pipeline read results from **artifacts**, or from an agent's report? If the latter, it is an attestation and does not satisfy `PRODUCT.md`'s core mechanism. | **Yes — this is the whole thesis** |
| N3 | Can it push to an **arbitrary client repository** with a scoped credential, or does it assume the operator's own remote? | **Yes — AVEL's entire use case is other people's repos** |
| N4 | What exactly lands in `.no-mistakes/evidence/`, and is it acceptable for that to appear in a client's repo under AVEL's name? | **Yes — see U4** |
| N5 | Does its AI-driven pipeline stage make delivery nondeterministic in a way that breaks preview-vs-real hash comparison? | **Yes — that comparison is AVEL's free determinism gate** |
| N6 | Can it run headlessly in CI with no TUI and no human present? | Yes |
| N7 | How does it behave on a **retry** — adopt the existing branch, or open a second PR? | Before first client use |
| N8 | Where does its worktree run, and does that environment ever hold AVEL's credential? | Before first client use |

**Superseded by the mapping decision above.** N1–N8 no longer gate a build-or-wrap choice. They remain useful as *design questions* — read the answers to learn how `no-mistakes` solved each problem before AVEL solves it again. N2 in particular (artifact vs. attestation) and N7 (retry adopts the branch rather than opening a second PR) are worth reading before writing the equivalent code.

---

### `treehouse` — execution environment

| # | Question | Blocking? |
|---|---|---|
| T1 | Are AVEL's waves actually **parallel**, or sequential with parallel authoring? If sequential, a worktree pool solves a problem AVEL does not have. | **Yes — determines whether this is needed at all** |
| T2 | Does the pool model survive agents needing **different dependency states** in the same repo at the same time? | Yes |
| T3 | Is the per-risk-class opt-in pattern being **adopted as a design**, or is the dependency being taken? These are different decisions with different costs. | **Yes — the design is free; the dependency is not** |
| T4 | Does the lease identity model (`--if-lease-id`, compared under the state lock) map cleanly onto `base_commit_sha`, or are they solving different races? | Before rewriting `BLAST-RADIUS.md` |

**Note:** T3 is the important one. The dry-run-by-default, per-risk-flag, never-blanket-`--force` design can be adopted into `BLAST-RADIUS.md` at zero cost and zero dependency. Take the design first; decide on the tool separately.

---

### `hackerai` — sandbox and durable runtime

| # | Question | Blocking? |
|---|---|---|
| H1 | Where does AVEL's verification runner execute? Local container, E2B, Firecracker/gVisor, disposable VM, GitHub Actions. **Answered in `SANDBOX.md`.** | **Yes — blocks the export engine and any client work** |
| H2 | Is **network egress denied by default** in the runner, with an allowlist for the package registry? | **Yes — this is the cheap defense against the supply-chain case** |
| H3 | Is it architecturally guaranteed — not merely conventional — that the runner process never has access to the GitHub credential? | **Yes — one-way door; free now, expensive later** |
| H4 | What does sandboxed verification cost per export at realistic client-repo size, with the changed-files mutation scope already decided? | **Yes — this is the unmodeled compute cost** |
| H5 | Does pg-boss still win over an external durable runtime once verification is minutes-to-hours and running in a sandbox elsewhere? | Before the export engine |
| H6 | Lockfile or counter-versioning for skills? Decide **before the skill library exists** — the skill library is empty, which makes this free today. | Before the skill library is populated |
| H7 | What are the commercial restrictions on its Apache 2.0 variant? | Before any code is referenced |

---

### `Agentic-Design-Patterns` — reference only

| # | Question | Blocking? |
|---|---|---|
| A1 | Confirmed that no content is vendored into AVEL, pasted into agent context, or copied into docs? | **Yes — license** |
| A2 | For each chapter that names a problem AVEL solved by instinct: is AVEL's solution the good one, or merely the obvious one? | No — but this is the actual value |

---

### Order to answer

1. ~~**H1, H2, H3**~~ — the sandbox boundary. **Answered in `SANDBOX.md`.**
2. ~~**N1, N2** — the build-or-wrap decision.~~ **Resolved: map, do not adopt.** N2 and N7 remain worth reading as design references.
3. ~~**U2**~~ — **answered: yes, an AI-driven delivery pipeline violates the determinism rule.** This is what decided the mapping.
4. **T1** — whether parallel execution is real, which decides whether `treehouse` is relevant.
5. **H6** — skill versioning, while it is still free.
6. Everything else, as it becomes relevant.

---

### Decision record

Fill in as answered. An empty row means the item is not implemented.

| # | Answered | Answer | Decision |
|---|---|---|---|
| H1 | `SANDBOX.md` | Tier 0 local container with no credential and no egress; Tier 1 remote VM | Specced |
| H2 | `SANDBOX.md` | Yes, from Tier 0, with a package-registry allowlist | Specced |
| H3 | `SANDBOX.md` | Yes, by deployment topology | Specced |
| N1 | 2026-08-21 | Superseded by the mapping decision | Map, don't adopt |
| N2 | 2026-08-21 | Superseded by the mapping decision | Map, don't adopt |
| U2 | 2026-08-21 | Yes, an AI-driven delivery pipeline violates the determinism rule | Map, don't adopt |
| T1 | | | |
| H6 | | | |
