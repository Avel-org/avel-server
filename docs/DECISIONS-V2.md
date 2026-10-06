# Decisions & Corrections

*What changed, why, and what was deliberately killed. **Read this before proposing anything** — several items below have already been considered and rejected, and a fresh session will otherwise re-propose them.*

*This document owns **rationale**. It contains no schema blocks and no stack tables — those live in `DATA-CONTRACTS-V2.md` and `TECH-STACK.md`. Where a decision has a shape, this doc explains why and links there.*

---

## The pattern behind most of these

An external review found that AVEL's mechanisms **stop one layer short of the thing they protect against**, and that it was a habit rather than a bug:

- Artifact-verified tests — written by the agent
- A gate — with a config-level bypass
- A deterministic core — fed nondeterministic input
- An audit protocol — enforced by good intentions

Most corrections below are that pattern being closed.

> **The test for any new mechanism: what layer does this stop short of?**
> Apply it to the correction itself, not just the original. Several corrections below initially failed their own test.

---

## Stack decisions

*Shapes and versions: `TECH-STACK.md`.*

### tRPC → ts-rest <!--allow-stale-->
**Finding:** tRPC produces no artifact. Type safety is compile-time only — nothing to diff, freeze, or verify against. Incompatible with machine-verified contract conformance, which is the top-priority fix. <!--allow-stale-->

**Decision:** ts-rest. It emits a real OpenAPI document, so `oasdiff` catches breaking changes in CI, the contract hash freezes into the export manifest, and the alignment gate stops being an attestation and becomes a diff — **for AVEL's own API.** The client-side half is a separate, unsolved problem; see `CLIENT-CONTRACT-CONFORMANCE.md`.

**Trade accepted:** smaller ecosystem than tRPC. Buying the artifact with it. <!--allow-stale-->

### Supabase → Neon <!--allow-stale-->
**Decision:** same Postgres, better fit. Database branching makes migration-heavy export-engine work cheap and resettable. Scale-to-zero suits a solo operator.

**Watch:** two connection strings — pooled for the app, direct/unpooled for `drizzle-kit`.

**Day one:** enable pgvector unused, so V2 retrieval needs no migration later.

### Added: Hono · pg-boss · Stryker · oasdiff · Pino · Sentry
- **pg-boss over BullMQ** — uses the Postgres you already have; no Redis to operate.
- **Stryker** — the highest-value addition. See "the test-authorship hole."

### TanStack Start — resolved

*Superseded in part by* Repo split *below. The three server needs in the table are now `avel-server` endpoints. Start is kept for `avel-web` on its own merits.*

**Decision: TanStack Start.**

The case against it was that a dense internal tool with no SEO requirement and no public surface may not need a meta-framework, and that Vite plus TanStack Router gives identical routing with less churn.

That case was about the wrong axis. The router is the same either way — Start *is* TanStack Router plus a server. What decides it is that the Command Center has three things a pure client app cannot do cleanly:

| Need | Why a server is required |
|---|---|
| The GitHub credential | It must resolve server-side. A client app either proxies through a separate backend or leaks it. |
| The zip download | Streams frozen bytes from a route, outside the contract envelope. Needs a server route. |
| The webhook receiver | Same. GitHub posts to it. |

Without Start, all three force a separate Node process, which is a second deployment target and a second place for the credential boundary to be wrong.

Start also gives server functions for the blast-radius call, so the Trees API request and the local blob-SHA computation happen server-side and the client never sees a token.

**Trade accepted:** younger framework, smaller community, and the API has moved between versions. Pin the version and read release notes before upgrading.

**What this does not change:** the route tree, the contract, or any component. `ROUTES.md` is identical under either choice.

---

## Schema corrections

*Shapes: `DATA-CONTRACTS-V2.md`.*

### Capability merged into Skill — *an entity deleted*
**Finding:** Capability was Skill with an identical shape, plus two extra join tables, its own export render path, and its own version stamping — and it enforced nothing. Full schema, migration, API, and export cost for a naming convention.

**Decision:** one entity, `Skill.type = 'knowledge' | 'capability'`. Four join tables → two. The knows/does distinction survives as data rather than duplicate infrastructure.

**Reintroduce Capability as its own entity <!--allow-stale--> only when a runtime exists that can actually restrict a tool.** At that point it earns the table.

*Revisited:* the sandbox rooms are that runtime, and capabilities now carry fields knowledge skills do not — `grants` and `io_shape`. The skills redesign kept them merged with those fields nullable. That contradicted this decision's own trigger. Resolved 2026-10-05: it stays merged, and a CHECK constraint enforces the capability-only fields. See *Decided 2026-10-05: module 0*.

**Downstream requirement — superseded.** This required every doc to say Capability declares and does not enforce, which was accurate while no runtime could restrict a tool. Capabilities are now enforced by the room; see *Skills are layered and attach to roles*. The principle underneath survives unchanged: **a description never claims more enforcement than the running system provides.**

### `skippable` removed from Playbook gates <!--allow-stale-->
**Finding:** gate strictness was per-mission config authored by the person the gate constrains. At 2am against a deadline that is a blessed bypass — and it undoes the quality lead's block authority in config.

**Decision:** gates are `mandatory | warn`. Bypassing is an **override**, not a policy: `Export.gate_override` carries a written justification and is displayed permanently on that mission.

### The hard block is playbook-relative
**Finding:** the single hard block was "empty phase1" — but Playbook declares `waves_applicable`. For a discovery playbook that excludes phase1, empty phase1 is the *expected* state. Either it blocked every discovery mission or was silently exempt.

**Decision:** *"at least one active agent in the earliest wave the playbook declares."* The rule survives; the hardcoded assumption doesn't.

### Frozen bytes → R2 from the start
**Decision:** R2 from day one. No egress fees, and export bytes accumulate — blobs in the primary database get painful faster than expected.

**Conflict resolved 2026-08-17:** <!--allow-stale--> `TECH-STACK.md` previously listed `bytea` now / R2 later under "deliberately deferred," contradicting this. **R2 wins** — the schema carries `snapshot_key` and has no `bytea` column, so the deferral was the stale text. `TECH-STACK.md` corrected.

*Note 2026-10-05: R2 is deferred. The text above is kept as the history of the 2026-08-17 decision. See* Decided 2026-10-05: module 0.

**Critical:** `version_manifest` stays in Postgres and queryable. You cannot correlate outcomes to loadouts if the manifest is sealed inside the blob.

**New field:** `contract_sha256` — AVEL's own contract artifact, frozen alongside the bytes.

### Connection scoped per engagement
**Finding:** a fine-grained PAT with authority to open PRs and direct-push into **client repositories** — other people's code — covered by one line. No scoping, rotation, or revocation at engagement close. This is the largest real risk in the system.

**Decision:** `Connection` gains scope, status, and lifecycle timestamps. **The token is never stored** — `credential_ref` names where it lives. An export resolves both a Connection (*what authorizes this?*) and a RepoPolicy (*what am I allowed to do?*).

V1 still reads one token from env; the model supports many, so the second client is a row, not a migration.

---

### `computeCoherence` lives in `src/contract/` — **resolved**

**Finding:** coherence warnings must appear live as the operator toggles skills on the loadout screen. Calling the server per toggle is a round trip per checkbox; reimplementing it in the frontend creates two versions of a rule that will drift.

**Decision:** `computeCoherence(mission, playbook)` ships as **shared code in `src/contract/`**, imported by both sides.

**Why it is safe:** the function is pure — no database, no network, no clock, no randomness. It is a rule, not a query. The same property that makes the render deterministic makes this shareable.

**Why it belongs there specifically:** `src/contract/` is defined as the place neither side can edit unilaterally without the other noticing. A rule that both sides must agree on has exactly that requirement. Same reasoning that put the error-code union there.

**How it fits:** the server stays authoritative — the gate calls the same function at export time, and a client that lies about coherence still cannot ship. The frontend copy is for feedback, not for permission. That distinction is what makes sharing it safe rather than a soft boundary.

### `preset` route group added to the contract — **resolved**

**Finding:** RosterPreset is a core entity and `Playbook.default_preset_id` FKs to it, but `src/contract/` had no `preset.ts`. The loadout screen cannot build the apply-preset flow, and per the standing rule it cannot invent the shape locally either.

**Decision:** add `src/contract/preset.ts` with `list`, `get`, `create`, `update`, `apply`.

**How it fits:** `apply` is the one with semantics — it **materializes** RosterEntries (copy-then-edit); the preset holds no mission state. That is already the entity rule; the procedure name should make it obvious that applying is a write, not a reference. `skillSource` procedures are the same class of gap and should be added in the same change.

## The test-authorship hole

**Finding:** the empirical gate reads build/tests/analysis from an artifact — honest about what the suite *said*, but nothing checked whether the suite said anything. The agents that write the code also write its tests. **A suite that asserts nothing passes green.**

**Decision — three parts, and only one of them is currently a mechanism:**

| # | Fix | Kind | Status |
|---|---|---|---|
| 1 | Coverage delta ≥ 0 and a mutation-score floor in the gate | **mechanical** | `[specced]` |
| 2 | A separate QA agent verifies the suite covers the acceptance criteria | *attestation* | `[hypothesis]` |
| 3 | Testers never modify code under test | *rule* | **mechanizable — see below** |

**Part 1 is the real fix.** Mutation testing alters the source and fails if the suite doesn't notice. It does not care who wrote the tests, which is why it works where a role rule doesn't.

**Parts 2 and 3 were shipped as rules in a markdown file with nothing detecting a violation** — which is the exact pattern this whole section exists to close. Part 3 is mechanizable and should be mechanized: **a file-ownership check on the mission diff.** Each agent's writable paths are declared in its roster entry; at render time, any file modified by an agent outside its declared ownership is a gate failure. Part 2 has no mechanical form yet and stays an attestation; it should be labeled as one wherever it appears rather than counted as a fix.

### Mutation threshold — **resolved: global + versioned**

**Finding:** `verification.mutation.threshold` was stored per export and set by the operator. That is a per-mission numeric gate bypass, reintroduced inside the mechanism that replaced the last one. Lowering a threshold from 70 to 55 leaves no scar; removing the old policy flag was meant to ensure a bypass always scars.

**Decision:** the threshold is **global, versioned, and lives in config under source control.** Changing it is a commit, reviewed like code, with history. It is not a column on Export and not a field on Playbook.

**Why this and not per-mission-with-override:** an override record makes a bypass *visible*, but it still makes lowering the bar a normal in-flow action available at the moment you are least able to judge it. A commit is the correct amount of friction — it cannot be done mid-mission without leaving the mission, and it applies to every future mission rather than one.

**How it fits:** `Export.verification.mutation` keeps `score_pct`, `killed`, `survived` as *measurements*, and drops `threshold` as *policy*. The frozen export records the config hash so "what bar did this ship against" stays answerable, which is the same move as `contract_sha256`. Shape change in `DATA-CONTRACTS-V2.md`.

### Mutation scope — **resolved: changed files per export, full project at ship**

**Finding:** Stryker on a real client codebase runs the suite many times over. Verification moves from minutes toward hours, per export, on the job queue. That is a product constraint, not an ops footnote.

**Decision:** **incremental mutation on changed files for a normal export; full-project mutation on the final ship of a sprint.** The gate reads the same field either way; only the mutation set differs.

**Why:** a per-export gate that takes an hour will get worked around, and a gate that gets worked around is worse than one that does not exist. Changed-files mutation catches the thing that actually matters — a suite that does not assert on the code this mission wrote — at a cost that keeps the gate usable.

**How it fits:** `verification.mutation` gains `scope: 'changed' | 'full'` so the artifact says which bar it cleared. pg-boss job design assumes minutes for `changed`, and the full run is its own job. Open sub-question: whether the sprint-final full run blocks or reports.

### `gate_override` — **resolved: renders into the delivered package and the PR body**

**Finding:** single user. `overridden_by` is always you, the justification is written by you, and the permanent display is on your own dashboard. That is a diary entry, not accountability.

**Decision:** the override text is rendered **into the exported package and into the PR body**, where the client sees it.

**Why:** a scar only works if someone other than the person who caused it can see it. Writing it into the delivery makes the override a thing you have to explain to a client rather than a note you have to ignore. It also converts the mechanism into a selling point — a package that carries its own exceptions is more trustworthy than one that is silent about them.

**How it fits:** one addition to the render template and one to the PR body builder. It is deterministic (the text is data on the Export), so it does not disturb the render invariant. Reinforces the same principle as `blast_radius`: the client sees what actually happened, not a summary of it.

### Rejected: making the frontend tester horizontal
**Considered and declined.** A single horizontal tester across every build agent and phase is a bottleneck on the critical path of every wave, and needs both frontend and backend depth. AVEL already has a horizontal layer — the QA wave. The problem was never a missing role; it was an unassigned duty. Roster unchanged.

---

## The gate is the commodity; the mission is the product

**Resolved 2026-08-21.** This governs how much of the export engine gets built and where effort goes after it.

**Finding:** `PRIOR-ART.md` establishes that AVEL's delivery gate already exists as shipped software at 5.2k stars, and that AVEL should map its design rather than depend on it — because an AI-driven pipeline puts inference in the delivery path and breaks the determinism rule. But the same finding cuts the other way too: **if a gate is something someone else already shipped, a gate is not what makes AVEL worth building.**

**Decision:** build the smallest gate that satisfies the thesis, and spend the remaining effort above it.

### The gate is four stages

`no-mistakes` runs seven. AVEL needs four.

| Stage | Reads | Notes |
|---|---|---|
| **1. Verify** | build · tests · analysis · coverage delta · mutation score · ownership | One artifact from one runner. This is the thesis; everything else is logistics. |
| **2. Conform** | phase1↔phase2 contract diff | `[attestation]` until `CLIENT-CONTRACT-CONFORMANCE.md` is answered. Marked as such everywhere. |
| **3. Blast radius** | create · overwrite · unchanged · violations, with the staleness guard | `BLAST-RADIUS.md`. This one is genuinely AVEL's. |
| **4. Deliver** | zip · PR · push | Pure logistics. Small on purpose. |

**Explicitly rejected: an AI review stage.** That is the U2 line. No inference in the gate, permanently.

**Considered and deferred: a docs stage.** `no-mistakes` gates on documentation and AVEL does not. A mission shipping undocumented interfaces is a real failure mode and the gate is cheap — but it is not the thesis, and it can be added after the four above work.

### Two nearly-free adoptions

**Runner fallback chain.** A verification runner that fails should degrade to the next in an ordered list, not fail the export. `no-mistakes` does this across agent CLIs; AVEL should do it across Capability-type runners. A gate that goes down because one tool is unavailable is a gate people route around.

**Programmatic tool calling for tool-heavy steps — added.**

A capability-type Skill that mostly reads and filters — schema reads, repo greps, permission-matrix checks — pushes every raw tool result back into context by default, whether the agent needs all of it or not. Published numbers on this pattern show reductions on the order of 170,000 tokens down to roughly a dozen for the same task, by having the agent write code that filters inside the execution environment and only the answer re-enters context.

**This is not a new harness dependency.** It is a routing rule inside the existing runner fallback chain: when a step is classified tool-result-heavy rather than reasoning-heavy, prefer a PTC-capable runner for that step. The chain stays harness-agnostic — the same principle behind multi-model, multi-harness sandboxing generally — this is one more ordered option, not a default lock-in.

**Log it.** Every PTC-eligible step records tokens-in-without-PTC versus tokens-in-with-PTC in `COST-LOG.md`. Token cost is the top financial risk with the least measurement behind it; this is the first concrete, cheap number available. Do not adopt the technique and skip the logging — an unmeasured optimization is a guess wearing a citation.

**Classifying a step as tool-heavy is mechanical, not a model's judgment.** A Skill's declared inputs/outputs already say whether it reads a large structure and returns a small answer. That classification lives on the Skill, not decided per-call.

**Headless by default.** Every gate must run with no TUI and no human present, or it cannot run in CI — which means it cannot run at all in the case that matters. Design the machine interface first; a human-facing view is a consumer of it, never the other way around.

### Where the effort goes instead

None of the following exists in `no-mistakes`, and none of it is a gate:

- **Mission composition** — which agents, equipped how, in what phases (`ROSTER-V2.md`)
- **The loadout screen** — the authoring surface, with live coherence (`ROUTES.md`)
- **Blast radius** against a *client* repository, with the TOCTOU guard (`BLAST-RADIUS.md`)
- **The agency layer** — `Connection` scoped per engagement, revocation at engagement close, `RepoPolicy` per repo
- **Playbooks** — process per mission type rather than per repository
- **Deterministic render** — content-addressed, reproducible, with the preview-vs-real hash comparison as a free determinism gate

**The test for any future scope proposal:** does this make the gate more complete, or the mission more expressible? The first is commodity work someone else has already done better. The second is the product.

---

## Repo split: two repos, permanently — resolved

**Decision: `avel-server` and `avel-web`. No third or fourth repo, ever.** Desktop and mobile are Tauri build targets inside `avel-web`, not separate codebases.

**Why two, not one.** Three clients — web, desktop, mobile — now share one backend. That was not the situation when TanStack Start was chosen; the original reasoning (one deployable, server functions handle credential resolution, the zip stream, and the webhook) assumed a single web client. Multi-client forces a real API boundary between frontend and backend regardless of framework.

**Why two, not three or four.** Desktop and mobile are Tauri build targets of the same frontend source, not new products. `src-tauri/` lives inside `avel-web` and produces a desktop binary; the same Tauri project's mobile configuration produces iOS and Android binaries. One set of routes, one set of components, three build outputs. A separate repo per platform would triple the maintenance surface for UI that is otherwise identical, and it would fragment the contract dependency three ways for no benefit.

**What moves into `avel-server` as real endpoints, not server functions:**
- Credential resolution (was a TanStack Start server function)
- The zip download stream
- The GitHub webhook receiver

These become HTTP endpoints in `avel-server`, called over the network by whichever client needs them, rather than in-process function calls.

**TanStack Start is kept for `avel-web` regardless.** The reason it was chosen no longer fully applies — there is now a second deployment target on purpose — but the routing conventions and DX are good on their own merits, and switching frameworks now costs more than the original reasoning saves. Re-litigating this is not authorized without a new finding.

**The contract lives in `avel-server`, consumed as a git dependency.** Not a third package, not a published npm module. `avel-web`'s `package.json` points at `avel-server` via a git reference, pinned to a commit or tag. This keeps the "neither side can edit it unilaterally without the other noticing" property — a contract change is a commit in a repo the frontend explicitly depends on — without the overhead of a publish step for a single operator.

**Platform detection is client-side; capability enforcement is server-side.** `avel-web` checks `window.__TAURI__` and its platform string to decide what to *render* — mobile builds do not render the delivery-initiation screens at all. `avel-server` independently rejects a `github_push` or similar irreversible action from a mobile-scoped session regardless of what the client attempted to show. A UI-only rule is not a rule; this is the same principle `BLAST-RADIUS.md` already states, applied to platform rather than to gate overrides.

**Standing rule:** if desktop or mobile ever seem to need their own repo, that is a signal the Tauri wrap has grown into a distinct product, and the decision to split needs to be made explicitly here — not drifted into by default.

---

## System One / calibrated-decision models — where they may and may not be used

**Resolved.** TypeSafe AI's Jev (and the "System One Model" class generally) is a structured-decision model: typed, probabilistic outputs from structured state, no string generation, fast and cheap relative to a chat model used the same way. Evaluate the specific vendor claims on their own merits — they are self-reported at the time of this decision — but the category is real regardless of whether this particular vendor's numbers hold up, and the boundary below applies to the category, not to Jev specifically.

**Never in the gate, regardless of speed, cost, or claimed calibration.** Verify, conform, blast radius, deliver — no inference enters this path. A calibrated model producing a probabilistic decision faster than an LLM is still a probabilistic decision, not a deterministic function of evidence. Using one here would repeat the exact error already corrected once, when the ship/block call moved from an agent's judgment to `decide(findings) -> pass | block`. Fast inference in the gate is still inference in the gate.

**Never for cut, convention, or boundary derivation.** Already decided: reading a repository's structure is pattern matching, and pattern matching is code, specifically so that a model cannot apply a rule to a decomposition someone already decided on and attach a confident-sounding justification. A faster model doing the same classification reintroduces the same failure at higher speed.

**Legitimate: advisory triage and scoring that sits beside the pipeline, never inside it.** Where a decision is classification or scoring over structured state, feeds a human's attention, and does not gate anything:

- Finding severity triage — sorting Brennan/Zane/Raze's findings by urgency for human review
- Blast-radius risk scoring in the pre-flight screen — drawing attention to which overwrites matter, while the pure-function guards remain the actual authority on what blocks
- Mission intake triage — routing incoming requests by urgency or complexity before Canon writes a brief
- Pre-dispatch cost or duration estimation — flagging a mission likely to overrun budget before it runs, feeding `COST-LOG.md` as an estimate, never as the recorded actual

**Labeling.** Any output from a calibrated-decision model is visibly advisory wherever it is shown — not a mechanical pass, not authoritative, the same visual and epistemic distinction already used for `[attestation]`. A confident-looking score next to a mechanical gate result must not be mistakable for one.

**Canon is unaffected.** Intake is reasoning and requires prose; a model that forgoes string generation cannot write a brief. If a sub-decision inside intake is later split out as pure classification, this section is the boundary that decision is checked against.

---

## Canon becomes a real agent — resolved

**Question:** Canon was specced as a structured form in V1, with a note that a real language-model case existed for V2. Can it be an agent?

**Yes.** The determinism rule forbids inference in the render, freeze, gate, and delivery path. Canon runs *before* a mission exists; its output is input to the mission, not part of the chain that decides whether work ships. That is the opposite of the block decision, which was the gate and therefore had to become a function.

**But not all of it.** Apply the test that shaped CounselOS — does this step require reasoning, or pattern matching?

| Intake step | Reasoning or mechanism | Owner |
|---|---|---|
| Turn call notes into a structured brief | Reasoning | **Canon** |
| Ask clarifying questions when the brief is underspecified | Reasoning | **Canon** |
| Surface contradictions in what the client said | Reasoning | **Canon** |
| Draft acceptance criteria | Reasoning | **Canon** |
| Derive the cut from repository structure | Mechanism | **Code** |
| Select the roster preset | Follows from the cut | **Code** |
| Set `RepoPolicy` defaults | Safe by absence | **Code** |
| Create Client and Engagement records | CRUD | **Code** |

**Canon must never derive the cut.** `cut_source: derived` exists specifically because the original roster defect came from applying a rule to a decomposition already decided on. A model proposing the cut reintroduces exactly that failure with a confident-sounding justification attached.

**Canon must never touch `RepoPolicy`.** Direct push to a default branch is opt-in by deliberate human confirmation. Nothing that performs inference gets to enable it.

### Canon proposes, the operator approves

Canon writes to an `Intake` row, never to `Mission`. Nothing it produces is executable until an operator approves it, at which point the Intake materializes a Mission and is retained as provenance for how the brief came to exist.

This is the approval-gated pattern: proposal, human review, then real. The same policy already decided for KnowledgeEntry write-back, applied at intake.

### Why this is the highest-leverage place for a model

`PRODUCT.md` names bad specification as one of the two dominant causes of multi-agent failure. A form cannot notice that a brief is underspecified. A model can, and `Intake.open_questions` is where it says so.

Canon catching an ambiguous requirement before dispatch is worth more than any downstream gate, because a gate can only reject work that was built against the wrong spec — it cannot recover the time.

---

### Canon is also the Command Center's chat agent — decided 2026-10-06

The same Canon, not a second agent: the operator's conversational agent on the Command Center's home surface (`avel-web` names that page "Canon"). The operator asks it about missions, plans the next one with it, and sees what needs them. This falls under Canon's existing `strategy` role, which runs between missions, so no role is added.

**Bounds, the same ones that let Canon be a model at all:**
- **It reads; it does not write.** It may read mission, engagement, export and activity data through the same API the operator uses.
- **Every suggestion becomes a `Proposal`** (module 14), which the operator approves or dismisses. Planning a mission produces an `Intake` draft or a proposal, never a Mission. It is the same pattern as its briefs.
- **It never acts directly**, and it never runs in the render, freeze, gate or delivery path. Nothing it says decides whether work ships.

A chat surface that could act would be an agent starting its own work: unbounded budget, no dispatch, no attribution. Module 14 exists to prevent that.

---

## Five gate additions — resolved

Each of these extends a mechanism that already exists rather than adding a new subsystem. Ordered by how directly the market evidence supports them; see `WHY-AVEL-EXISTS.md` for the underlying research.

### 1. The published verification receipt

`Export.verification` currently lives in Postgres and is invisible to the client. Render it into the delivered package at `.avel/evidence/receipt.md` and into the PR body: what was checked, what passed, against which contract hash and gate config hash, content-addressed.

**Why it matters:** no platform in this market ships proof. The closest competitor check confirms that a security policy *exists*, not that it *works*. Existence is not effectiveness, and the difference is the entire product.

**Cost:** a render template and a PR body builder. It is deterministic, so it does not disturb the render invariant.

**Connects to:** the `gate_override` decision, which already renders into the delivery for the same reason — a client who can see what happened does not have to trust a summary of it.

### 2. Permission matrix as a gate

Generate the full role × resource × state matrix from the schema and run every cell. Fail on any combination that is undefined rather than explicitly allowed or denied.

**Why it matters:** Mission 002's authorization defect — an expired grant removing a baseline permission — was found by an exhaustive grid in a unit spec, not by end-to-end tests. The agent's own explanation was correct: end-to-end tests only walk paths a request happens to take, and no endpoint produced that combination.

Every major documented breach in this space is an access-control failure. This is the check that finds them, and it has already found one.

**Cost:** matrix generation from the schema, plus a runner. The hard part is already proven.

### 3. The absence gate

Every existing gate checks what is present. Nothing checks what is missing.

That is the wrong shape for this failure class. AI-generated defects are not wrong answers, they are absent layers — the model built what was asked and nothing that was assumed. A database ships with no row-level security because nobody requested row-level security.

Derive obligations from the contract artifact and check each one:

| Obligation | Derived from |
|---|---|
| Every table has a row-level security policy | Schema |
| Every endpoint has an authorization check | Contract |
| Every mutation writes an ActivityLog action | The closed-vocabulary rule |
| Every component has a test identifier | Client conventions |
| Every foreign key is indexed | Schema |
| No secret appears in client-side output | Build output |

Each is mechanically checkable and each maps to a documented breach class.

**Connects to:** the coherence engine, which already computes warnings from declared-versus-actual. Same mechanism, pointed at the client's code instead of the roster.

### 4. Findings as a gate

Every finding is currently a one-off. A defect found in one mission travels to the next only because a human noticed and wrote it down.

Make the registry executable. Each confirmed finding carries a detection rule, provenance, and the mission that found it. Before an export, the work is checked against the accumulated set.

**How this differs from the deferred knowledge vault:** it is not retrieval, it involves no inference, and nothing auto-promotes. It is a deterministic check against a list of confirmed defects. That satisfies the standing rule — provenance and forgetting first, retrieval second, auto-promote never — while delivering the value without waiting for ten missions.

**Connects to:** `SURPRISES.md`, `findings/`, and the existing pattern registry. This turns documentation into a mechanism.

**Scoping caution:** findings promoted to the general registry must be rewritten to strip anything client-specific. Client-scoped findings stay scoped. Same one-way door as `KnowledgeEntry.client_id`.

### 5. Mission replay across models

The render is deterministic, the snapshot is frozen, and the contract and gate config hashes are in the manifest. That means the exact inputs to any past mission can be reconstructed.

So a past mission can be re-run against a different model with identical inputs, and the outcomes diffed: gate results, cost, defects found, defects missed.

**Why nobody else can do this:** answering "did the model upgrade help" requires frozen inputs, and nothing else in this space freezes them. AVEL does, as a side effect of the determinism rule — the same way the preview-versus-real hash comparison is a free determinism gate.

**Why it matters beyond curiosity:** it produces the measured trend across missions that every claim currently lacks, and it makes model upgrades a decision with evidence rather than a leap.

**Cost:** a replay harness over `Export` rows. Requires no new schema beyond a `replay_of` self-reference.

---

## Convention and boundary extraction — resolved

**One capability, three outputs.** The repository is already read at onboarding to derive the cut. The same read now also extracts the conventions in force and the natural boundaries in the tree.

```
read the client repository
    ├── cut            which boundary is a directory     [specced]
    ├── conventions    the rules actually in force       [specced]
    └── boundaries     the natural split                 [specced]
```

Shapes in `DATA-CONTRACTS-V2.md`. Onboarding flow in `ROUTES.md`.

### Why conventions

`conventions/layering.md` is required by the golden fixture and **no role owns writing it.** Foundations owns shared *code* surface. Verification owns tests. Feature agents own features. The layering rules, testing standards, and naming conventions of a client's codebase are authored by nobody and read by everyone.

CounselOS's were written by hand. That works for one client. At the third it is the same provisioning gap Mission 002 found, one level up — and the correction is the same: provision before dispatch, not after it blocks.

**Extracted, never invented.** Every entry carries the evidence that demonstrates it. A convention asserted without evidence is a guess, and a guess in `conventions/` is worse than a gap because agents follow it.

**Low confidence blocks approval.** A repository with three competing layering patterns has no convention to extract. Inventing one is the failure this system exists to prevent, performed by the system.

### Why boundaries

The cut is derived. The **roster is still asserted** — the operator decides how many feature agents, and nothing has ever checked whether that number is right.

Reading the tree turns "I picked seven agents" into "the codebase has six feature boundaries, here they are, and two of them share a file."

`Boundary.collides_with` is the field that earns this. A composition root, a shared package, or a barrel file that several boundaries write is exactly what needed the foundations role in Mission 002 and blocked four times before the first commit. Surfacing it at onboarding provisions the shared surface before dispatch.

**Still a proposal.** Derived boundaries inform the roster; they do not set it. The operator may merge, split, or override, and an override requires written rationale — same rule as the cut.

### Not a model

Canon does intake, which is reasoning about what a client said. Reading a directory tree is pattern matching, and pattern matching is code.

A model proposing the cut, the conventions, or the boundaries would reintroduce exactly what `cut_source: derived` exists to prevent — a rule applied to a decomposition already decided on, with a confident justification attached. Same test as CounselOS: does this require reasoning, or pattern matching?

### Rejected from the same list

Four adjacent ideas were considered and belong outside AVEL:

- **Repo-safe write API.** The strongest standalone idea, and that is why it should not live inside the platform. Extract `computeBlastRadius` and `gitBlobSha` as a package. Buried in AVEL, nobody can adopt them and AVEL gains nothing it does not already have.
- **Contract-first scaffolding.** Already done internally. As a product it is a different company with a different buyer, competing with funded incumbents.
- **Convention enforcement as a product.** The ownership check plus the absence gate already cover it. Selling it separately means maintaining two things that are one thing.
- **Reproducible package delivery.** That is the export engine. It does not get added; it gets extracted later, if ever.

---

## Roles are separate from agents — resolved

**Decision:** a role is a job with a fixed definition. An agent is an instance covering one or more roles for a set of paths. The role catalog lives in `ROLES.md`; `ROSTER-V2.md` defines only how roles are assigned.

**Why:** the original roster made each agent a role. Cutting an agent therefore deleted its duties — four were orphaned. The composition table could call for specialists with no definition. The horizontal roster looked like a fixed cast rather than one way of assigning work. And the writable-paths rule was asked to decide two different things and could only see one.

**Two rules:** roles split by artifact, agents group by path. Frontend tests and the accessibility audit are two roles because they produce different artifacts, and one agent because they share a mount.

**The runtime test:** reasoning is `model`, pattern matching and measurement are `code`, provisioning and approval are `human`. Only `model` roles are covered by agents. Eleven of 35 roles are code and cost no tokens.

**Improvement never lets an agent edit itself.** Findings become checks, roles are measured, and the operator changes one role definition at a time, versioned and re-run against the same template.

**Identity files are generated** from the roles an agent covers. They cannot drift from the catalog.

---

## Skills are layered and attach to roles — resolved

**Decision:** skills attach to roles, templates, missions, and packs — never to individual agents — in three layers. `role` skills are part of the identity file and hashed into `agent_version_sha256`. `stack` and `domain` skills arrive with each dispatch and are hashed into `CompletionReport.skills_sha256`. Full design in `SKILLS.md`.

**Why:** skills attached to agents were left behind whenever roles moved between agents — the orphaned-duties failure one level down. And stack skills inside an identity file would have made every project look like a new agent version, destroying the comparability the version hash exists for.

**Capabilities are now enforced.** The earlier caveat that a capability "declares a tool grant; it does not enforce one" was true when no runtime could restrict a tool. The sandbox rooms are that runtime: the runner provides granted tools and nothing else, and no capability can exceed its room.

**Trust:** agents never write or edit skills; only approved skills attach; imported skills are reviewed and pinned by hash like dependencies; and a lesson that can be a check becomes a check rather than a skill.

**Open:** Capability is merged into Skill today, as one entity with two types. It was merged because it duplicated the shape and enforced nothing. It now enforces something, and it stays merged. Decided 2026-10-05; see *Decided 2026-10-05: module 0*.

---

## Proactivity arrives as proposals — resolved

**Decision:** agents may propose anything and act only inside a dispatch and their mount. Four proposal sources — next module, calibration alerts, post-delivery checks, and intake questions — land in the operator's queue as `Proposal` records. Approving one starts its action through the normal path; approval skips nothing. A proposal whose premise stops being true expires. See `COMMAND-CENTER.md`, module 14.

**Why:** the operator was the only source of momentum and is, by measured evidence, the most error-prone agent. Autonomous action would remove that bottleneck by giving up budgets, attribution, and boundaries — the things the runner, mounts, and version hash exist to protect. Proposals remove the bottleneck and keep all three.

---

## Sequencing corrections

### Promoted: machine-verified contract conformance
Was Tier-2. **Now top of the queue.** Inter-agent interface misalignment is one of the largest documented categories of multi-agent failure, and it was the one thing left as an attestation.

**Correction to the correction:** the machinery built so far — ts-rest, OpenAPI, `oasdiff`, `contract_sha256` — governs **AVEL's own API, in AVEL's repo.** The gate that matters is phase 1 versus phase 2 **in the client's project**, in a stack AVEL does not control. Those are different artifacts in different repositories. `CLIENT-CONTRACT-CONFORMANCE.md` specifies the missing half; **until it exists, the promoted fix is a slogan.**

### Demoted: knowledge write-back
Was promoted into V1. **Now deferred past ~10 real missions.** There is nothing to retrieve yet (`STATE.md`), and memory systems have the field's worst documented failure modes — a poisoned entry is inherited by every agent after it.

When built: **provenance, status (candidate vs. promoted), and forgetting first. Retrieval second. Auto-promote never.**

### Also demoted: executable Playbook · pgvector retrieval · export diff · per-agent telemetry
All solving problems there is no evidence of yet. Telemetry specifically needs missions to measure.

### Raised: cost governance
Was listed last. **Wrong ordering — that reflected intellectual interest, not risk.** Multi-agent runs use far more tokens than a chat session, at frontier rates, with one person paying, no ceiling, and no attribution. Doc drift wastes an afternoon; an unbounded run wastes a month's runway.

**Interim, without building anything:** console budget alerts, a manual per-mission spend log, a hard pause rule above a threshold.

**Flagged:** all three of those are enforced by intention — the thing this architecture argues against. The mechanical version is a `spend_ceiling` on Mission and a refusal at the gate when attributed spend exceeds it. Small. Should not stay interim for long.

### Sequencing correction applied to this rebuild itself
The review's finding was *design judgment is ahead of evidence*. The response was a new API framework, a new database, six new tools, a schema redesign, and five documents — moving backwards on the axis identified as the problem. Each call is individually defensible; the aggregate repeated the original error one level up.

**Standing rule from here:** no further stack or schema change ships before one mission runs end to end and produces a measurement.

*Confirmed 2026-10-05:* the rule survives. Better Auth, the R2 deferral, and Pino-now-Sentry-later are recorded as decided before the first mission; the stack is then frozen.

---

## Standing decisions — do not re-litigate

- **The core is deterministic, permanently.** No LLM inference in the render, freeze, gate, or delivery path. AI feeds the core; it never executes inside it. *Scope: this buys reproducibility and auditability, not correctness. The gates buy correctness.*
- **Roles are separate from agents.** 35 roles in `ROLES.md`: 23 `model`, 11 `code`, 1 `human`. Only model roles are assigned to agents. Blair and Plye are permanently code. Della was removed; cost is a field on `CompletionReport`. Trace and Uno are unbuilt.
- **Legacy note — the 6 "Command Center agents" framing.** Two are permanently plain code; one is a form; the orchestrator is the human in V1. Counts in `STATE.md`.
- **Versioning is counter-only.** Reproducibility comes from the frozen snapshot. No version-history table — deliberately.
- **Soft delete** on anything an Export can reach; `live()` explicit in every query.
- **ActivityLog `action`/`entity_type` are closed vocabularies.** Adding a mutation adds its action in the same change. The action prefix is a domain, not the entity_type.
- **Auth is identity-only, single-user, no role seam.** Single-user does not mean open — the app can open PRs, so unauthenticated requests are rejected hard. *Amended 2026-10-06 by the operator:* still one human user with no roles. Agents become a second kind of caller, each limited by its roles to the actions it may take (*Decided 2026-10-06: agents call the API*). The seam is for agents only; `User.role` stays unread.
- **RepoPolicy defaults FALSE** — safe by absence.
- **The block decision is a function, not an agent.** A pass-or-block verdict computed by inference is inference in the gate path, which the determinism rule forbids. `decide(findings) -> pass | block` is arithmetic over typed findings. Joins Blair and Plye as permanently code. See ROSTER-V2.md.
- **The cut is derived, not chosen.** Read the repository's directory structure at mission setup. An override requires written rationale that renders into the delivery.
- **The gate is the commodity; the mission is the product.** Four gate stages, no AI review stage, headless by default. Effort goes above the gate, not into it.
- **Doc ownership is exclusive.** See `DOC-OWNERSHIP.md`. A fact restated in two documents will drift; this has happened three times.

## Decided 2026-10-05: module 0

- **Capability stays merged into Skill.** One table, `Skill.type = 'knowledge' | 'capability'`. A database CHECK constraint requires `grants` and `io_shape` when `type = 'capability'` and requires them to be null otherwise. The rooms made capabilities enforce something; the constraint makes the schema say so, by structure rather than by a nullable field and a convention. This closes the question in `SKILLS.md`.
- **One error code union.** Every code lives in `src/contract/shared/errors.ts`, as `DATA-CONTRACTS-V2.md` specifies. The previous build's four unions (`EXPORT-ENGINE.md` §9) are not carried over. The concern behind them, an unrelated 404 rendering through the export error map, is handled by mapping per code, not per union.
- **Operator sign-in lives in `avel-server`.** The server owns the session. It is the side that enforces permissions, and the web, desktop, and mobile clients all reach the same API.

The operator answered the module 0 question list on 2026-10-05. Shapes are in `DATA-CONTRACTS-V2.md`; this records why.

### Schema

- **Finding is evidence, so it is never deleted.** No `deleted_at`. Removing a finding is `status = 'dismissed'` with a required `dismissed_reason`, so a dismissal always says why. `caught_by` names the check or role that found it, which is what lets a finding be attributed and a check be measured.
- **A preset's token estimate is a default.** Every mission re-estimates, because the same squad costs different amounts on different work.
- **ActivityLog names the agent.** `actor_roster_entry_id` says which agent acted, not just that an agent did. Append-only is enforced by a database trigger: a convention is the `[attestation]` failure mode, and a log anyone can edit is not a log.
- **`*_by` fields are foreign keys to User.**
- **`AgentTemplate.engagement_id` is nullable; engagement scoping lives on Mission.** This follows the naming decision: Atlas is one shared identity, territory lives on RosterEntry, and the project is the mission's engagement.
- **`Connection.engagement_id` exists and is nullable.** AVEL's own internal work uses connections that belong to no client engagement.
- **`Mission.engagement_id` is nullable, and follows `origin`.** The same reasoning as Connection: AVEL's own internal missions, such as template builds, belong to no client engagement. A CHECK requires it when `origin = 'client'` and requires null when `origin = 'internal'`, so a client mission can never lose its engagement and an internal one can never borrow one.
- **`ActivityLog.request_id` is NOT NULL.** Every row traces to the thing that caused it. A system job has no HTTP request, so it passes its run or job id.
- **ActivityLog also refuses `TRUNCATE`.** A row trigger does not fire on `TRUNCATE`, so append-only needs a statement trigger too.
- **Two actor CHECKs on ActivityLog.** An `operator` row names its user and an `agent` row names its RosterEntry. Without them, `actor_roster_entry_id` would be a field an agent row could leave empty.
- **Closing an engagement logs each revoked Connection.** The close revokes the engagement's Connections in the same transaction and writes one `connection.revoked` row per Connection, so each revocation is attributable on its own.
- **Mission gains `halted`.** `SANDBOX.md` has the runner halt the whole mission at its spend ceiling, and that state needs a name.
- **Waves are `A | B | C | D | E`.** E is Operate, after the ship decision.
- **`RosterEntry.monitor_priority` is dropped.**
- **Template, pack and client skills are copied into `mission_skills` at mission creation,** with a `source` column (`template | pack | client | manual`) so each skill's origin stays attributable. No new join tables. This closes the question in `SKILLS.md`.
- **`Skill.content_sha256` covers everything that changes behavior:** description, content, `avel_enhancement_md`, grants, `io_shape`, `type`, and `layer`. The rule is the point: anything that changes what an agent does is in the hash, or two runs with the same hash could have run different skills.
- **Identity versions: the hash only, on CompletionReport, for now.** Storage is decided in module 5, under one constraint: every recorded hash must resolve to its exact identity text, or A/B comparisons cannot be reproduced. This answers the question in `COMMAND-CENTER.md`.
- **Export takes `BLAST-RADIUS.md`'s fields and statuses** (`dry_run`, `preview_export_id`, `base_commit_sha`, `base_ref`, `blast_radius`; `previewing`, `previewed`, `delivering`) into the canonical shape.
- **`pr-open` moves on, through the webhook.** Merged goes to `done`; closed without merging goes to `closed`. Without `closed`, an abandoned PR would sit in `pr-open` forever.
- **`GITHUB_REJECTED` joins the error union.** `EXPORT-ENGINE.md` §9 records it as decided in the first build; it never reached the current vocabulary. It separates a refusal (do not retry) from `EXTERNAL_GITHUB` (safe to retry).
- **Status value lists live in the contract** (`MISSION_STATUSES`, `EXPORT_STATUSES`), and the database enums are built from them, so the frontend and the database cannot disagree.

### Routes and sign-in

- **camelCase in the contract, snake_case in the database.**
- **The six missing route groups are added with their modules.** Client and engagement in module 0, the rest as their modules land. No route without a module behind it.
- **`Finding` is the entity; `GateFinding` is what `decide()` reads.**
- **Better Auth with the GitHub provider, not a hand-rolled cookie.** It handles OAuth state, CSRF, and cookie signing, which are the parts most likely to go wrong when written by hand, and it matches the booking template, which already uses it. The allowlist stays: GitHub ids in an environment variable, checked in Better Auth's sign-in hook. Its user table, extended with `github_id` and `github_login`, is the User entity, and Better Auth owns sessions. Whether to use a GitHub OAuth App is answered separately.
- **The success envelope is in the contract's response schemas,** not only in the handler, so `avel-web` picks it up through its pinned dependency. The error envelope carries the closed error-code union.
- **A count lives in the doc that owns the list it counts.** `check-docs.sh` already verifies the `ROLES.md` totals. "Status only in `STATE.md`" was about build status, not counts.
- **`DATA-CONTRACTS-V2.md` is the canonical data model.** No copy is maintained outside this repository. `STATE.md`'s statement that one was is removed.

### Stack

- **The standing rule "no further stack or schema change before one mission runs" survives.** The changes below are recorded as decided before the first mission. After them the stack is frozen. This closes the open question about whether the repo split retired the rule. *Two exceptions, decided by the operator on 2026-10-06:* Dispatch, the firm roster, and their three foreign keys are built before the first mission (*Decided 2026-10-06: agents call the API*), and so are `Mission.template_ref` and `template_version` (*Decided 2026-10-06: build sync*), with `Finding.reported_by_dispatch_id` as a fourth foreign key before module 9. Nothing else is unfrozen.
- **Auth.js → Better Auth** (above). <!--allow-stale-->
- **R2 is deferred.** The history in *Frozen bytes → R2 from the start* stands as written; a dated note there points here. When R2 returns, and where frozen bytes live until then, is open.
- **Pino now, Sentry later.**

### Later modules (recorded now, built when the module comes)

- **Playbook gate names versus the four gate stages:** module 9.
- **An ownership violation can never be overridden.** A gate result can be overridden with written reasons; a violation cannot (`COMMAND-CENTER.md` module 9). This closes the question in `BLAST-RADIUS.md`.
- **Preview versus export compares the package hash,** under a versioned hash definition, and Export carries the version (`EXPORT-ENGINE.md` §13).
- **A zip export does not require a preview** (`EXPORT-ENGINE.md` §7).
- **Module 11:** path normalization's violation code, whether `EMPTY_REPOSITORY` is a code, and the HTTP statuses for `CONNECTION_REVOKED` and `BRANCH_NOT_FOUND`.
- **Skill render paths are unchanged** (`SKILLS.md`, *Unchanged*).
- **Deferred:** where the phase-1 contract lives in the client repo (open in `CLIENT-CONTRACT-CONFORMANCE.md`), and whether `.avel/evidence/` is in the package (module 10).
- **The guard count is five,** not four. `EXPORT-ENGINE.md` is corrected.
- **The golden fixture is rebuilt in module 10** from an internal `template-booking` mission, not client CounselOS data, written by Fenn without seeing the render. The operator-path and Nemi/transactions overlap questions go away with the rebuild.
- **Template order:** `template-booking` first (`TEMPLATE-BOOKING.md`); the rest per `TEMPLATES.md`.
- **Fuzzer:** fast-check for TypeScript. Other stacks choose when they arrive.
- **Accessibility is a code role (axe),** not Nemi (`ROLES.md`).
- **F14's severity:** deferred.
- **Vertical-cut minimum:** four model agents (author, tester, judge, fixture) plus the operator.
- **Platform roles' Owns and Checked-by:** module 4.
- **The verification receipt is held.** Not built until the operator decides.
- **No mobile doc is needed now.** Offline capture is deferred. `MOBILE-PWA.md` is not written.

## Decided 2026-10-06: agents call the API

The operator decided on 2026-10-06 how agents take part in the Command Center. Shapes are in `DATA-CONTRACTS-V2.md` (*RosterEntry*, *Dispatch*, *Proposal*). The token boundary is in `SANDBOX.md`. This records why.

### A chain of command where authority is the operator or code

Orders flow down through code; reports and requests flow up as artifacts and proposals. No agent commands another.

- **An agent that starts another agent has no ceiling the runner controls.** The budget rule in `SANDBOX.md` assumes every run was started by code.
- **Attribution breaks.** If one agent's work was ordered by another, a bad result has two possible causes and no way to separate them.
- **Who runs next would become a model's judgment,** which is inference in the control path. This is the same reason the ship decision is a function.
- **It has failed here once.** The lead roles were cut for coordinating without producing an artifact (`ROSTER-V2.md`). The Atlas name was later reused for a builder.

Canon is the closest thing to a commander. Under `strategy` it may recommend a whole plan: which modules, which order, which roster. It never dispatches anything.

### An agent is another caller of the same contract

Agents use the API the operator's surfaces use, with no back door and no screen scraping. The server enforces what each caller may do, as it does for the device classes (`COMMAND-CENTER.md`, module 13). Each module offers three verbs: **read** its state, **propose** a change, and **act** inside the agent's own artifacts. Approving, dispatching, delivering, and overriding a gate are never on an agent's list.

### Dispatch becomes an entity

A RosterEntry is "on the team", and a CompletionReport is "finished". The run between them had no record, and that left four gaps:

- **The estimate rule could not be enforced.** "Required before dispatch" was `[attestation]` because no row existed to carry a NOT NULL.
- **The runner had nowhere to count tokens** against the ceilings.
- **One agent's several runs** on a mission shared one RosterEntry and could not be told apart.
- **An access token had nothing to belong to.**

One run is one Dispatch: one estimate, one count, one report, one token.

### The agent token is opaque, scoped to its dispatch, and held by the runner

- **Opaque, not self-describing.** The server looks up every request, so closing or halting a dispatch cuts access on the next request. A signed token that carried its own permissions would work until it expired.
- **Permissions come from roles,** the same way rooms do, so they cannot drift from `ROLES.md`.
- **The runner holds it, not the room.** Decided by the operator; reasons in `SANDBOX.md`.
- **Fails closed.** The routes that exist today require an operator. A route opens to agents only when it declares a verb the agent's roles allow.

### A firm roster for agents that work outside missions

Canon, Trace and Uno work for the agency rather than inside one mission. The activity log can name an agent only through a RosterEntry, and RosterEntries belonged to missions. So Canon's chat suggestions would have been unattributable. A firm-scoped RosterEntry fixes that without changing the log.

**A Canon chat session is a dispatch.** Decided by the operator. It gets a budget, a hard ceiling, an audit trail, and a token that dies when the session ends. Its proposals name the session through `Proposal.proposed_by_dispatch_id`. This extends the 2026-10-06 Canon chat decision above; it changes none of its bounds.

### What agents may do is set per family, not per role

The table is in `ROLES.md`, *What each family may do through the API*. A grid of every model role against every module and verb would have over a thousand cells, almost all of them "no", and nobody could keep it correct. It is also mostly unnecessary: a mission agent's work is files, and its room's mount already decides which files it may write. The API covers only what lies outside the repository. Each family already states what it owns, so the family is the unit. The operator agreed three choices on 2026-10-06:

- **Builders and testers cannot propose.** Their only channel is `blockers` on their CompletionReport. Code already turns repeated provisioning-gap blockers into calibration proposals. Letting every agent propose would fill the queue with opinions and bury the judgments.
- **`client-ops` proposes messages and never sends them.** Anything that reaches a client is outward-facing and goes through the operator. "Engagement records" in the Firm family means Intake drafts and research notes; no agent edits a Client or an Engagement.
- **Judges record defects as `open` Findings, not proposals.** Finding already moves from `open` to `confirmed` or `dismissed` by operator decision. A proposal kind on top would be a second queue for the same thing.

**"Its own" comes from the token.** The server fills in which dispatch, mission, and check a record belongs to. An agent that could name its own `caught_by` could claim another check's finding; one that could name a dispatch could close someone else's.

### Built before the first mission

An exception to the 2026-10-05 freeze (*Stack*), decided by the operator. The first mission exists to produce a number, and without Dispatch its numbers would not hold:
- **The estimates would be `[attestation]`,** because nothing could require them.
- **The runner would have no row to enforce the ceilings on.**
- **Anything Canon proposed could not be attributed to an agent.**

Running the first mission's dispatches by hand would measure a process the platform will never run.

### Not yet decided

- **Proposal kinds for agents,** such as a follow-up or a scope request. Each is added with the code that writes it, like the chat kind in `STATE.md`.

## Decided 2026-10-06: build sync

The operator decided nine questions that the backend and frontend sessions raised while agreeing a build order. Shapes are in `DATA-CONTRACTS-V2.md`; the read scope is in `ROLES.md`.

### Closing the gaps in Dispatch

- **The runner files the report for a halted or failed run.** The agent's token stops working when the run stops, so the agent cannot. The agent still files it for `complete` and `blocked`.
- **The token works only while the dispatch is `running`.** One rule covers every other status, with no list of exceptions to keep correct.
- **The runner is the `system` actor, with its own credential.** It writes token counts and halts, which no agent may write. Giving it the operator's session would make every halt look like an operator action.
- **`token_sha256` is unique,** because it is looked up on every request.
- **At most one live firm entry per agent template.** Two Canons would split one agent's chat history and budget across two records.

### Canon reads clients, read-only

Canon drafts intake and suggests next missions, and both need to know who the client is. It never reads connections, repo policies or credentials. Those control what reaches a client's repository, and a firm agent has no reason to see them.

### Missions record their template

`Mission.template_ref` and `template_version` go in before the first mission. They are the second exception to the freeze. The evaluation loop in `TEMPLATES.md` compares rebuilds of the same template. Without these fields the comparison cannot be queried, and the first mission could not be part of it later.

### Idempotency for creates an agent can reach

Agents retry on timeouts. A duplicate CompletionReport or Proposal corrupts attribution.
- **A replay returns the original record.** A `409` would leave a timed-out agent without the id of what it created. A key reused with a different body is still `409 IDEMPOTENCY_REPLAY`.
- **Keys are scoped per dispatch,** so one dispatch's replay can never return another's record.
- **The key goes in a header.** Clients and engagements are left out for now, and a header can be added to them later without a breaking change. Export's spec moves its key to the header too.

### Order

- **The finding routes move to module 9.** Judges write `open` Findings during the gate, and confirming them is part of gating. Leaving the routes in module 12 would have put them after the first mission.
- **Proposals (module 14) come after the first mission.** That mission runs with each next module dispatched by hand. The Canon chat shows as not built until then.
- **An activity read route is added now,** read-only, as the missions read route was. The Activity page exists, and the dev seed already writes rows for it.

### Three more, the same day

- **avel-web pins the contract to an avel-server commit,** instead of linking a sibling checkout. CI checks out one repository, so a link it cannot resolve fails there. A pin also makes every contract change a deliberate step on the frontend: it arrives when the frontend moves the pin, and not before.
- **A judge's Finding names its dispatch** through `Finding.reported_by_dispatch_id`, before module 9. Without it, the per-dispatch idempotency key had nothing to scope Findings by, and a judge's finding could not be traced to the run that wrote it. It is the fourth new foreign key under the freeze exceptions.
- **An Export replay returns the original,** like the agent creates. A second rule for one operator route was a difference with no reason behind it.

### Starting the build, the same day

- **The brief shape is minimal:** a summary, numbered requirements, and acceptance criteria that cite them (`DATA-CONTRACTS-V2.md`, *Intake*). The intake check cannot exist without a shape, and a smaller shape is easier to extend than to cut back.
- **Approval refuses until the cut is derived.** Letting the operator supply a cut would make "overridden" the normal path until module 2. That reverses the settled rule that the cut is derived, not chosen.
- **Activity values that arrive with their mutation are routine,** not freeze exceptions. Every write logs, so each module's mutations add their actions, as migrations `0010` and `0011` did. The freeze covers new tables and columns.
- **A roster changes only while its mission is a draft.** A team changed mid-mission muddies attribution, and the first mission exists to produce a clean number.

---

## Open questions

| Question | Blocking? |
|---|---|
| Mutation scope: does the sprint-final full run block or report? | Before first ship |
| Client-side conformance artifact format (D1/D2) | **Yes — blocks the top-priority fix** |
| The verification receipt handed to clients. *Five gate additions* marks it resolved; this table held it. Which one stands | **Held** (confirmed 2026-10-05). Not built until the operator decides. |
| When R2 returns, and where frozen export bytes live until then | Before module 10 freezes a snapshot |

**Resolved 2026-08-21:** mutation threshold (global + versioned) · mutation scope (changed per export, full at ship) · `gate_override` renders into the package and PR body · `computeCoherence` in `src/contract/` · `preset` route group added · `no-mistakes`: map its design, do not adopt it (`PRIOR-ART.md`).

**Resolved 2026-10-05:** no mobile doc is needed now; offline capture is deferred · the stack rule survives, with the current changes recorded as decided before the first mission. See *Decided 2026-10-05: module 0*.

**Resolved 2026-10-06:** Dispatch, the firm roster, and their three foreign keys are built before the first mission, the first exception to the schema freeze. See *Decided 2026-10-06: agents call the API*. `Mission.template_ref` and `template_version` are the second. See *Decided 2026-10-06: build sync*.

**Resolved by the repo split:** TanStack Start for `avel-web` · the contract lives in `avel-server/src/contract/`, consumed as a git dependency.

## The honest status this all sits on

Zero missions run. See `STATE.md`.

**Every decision above is a well-reasoned hypothesis until one mission runs end to end and gets measured.** The design judgment is ahead of the evidence. That is the more fixable direction — but it is the problem, and this rebuild widened it.
