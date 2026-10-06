# The Command Center

The platform that runs AVEL: it turns a client request into verified, delivered software by running AI agents under rules enforced by code. This is the rebuild specification — fifteen modules, in the order work flows through them.

**Build status lives in `STATE.md` and nowhere else.** This document describes what each module does and why, never whether it exists.

Related: `ROLES.md` for the role catalog, `ROSTER-V2.md` for assignment and names, `DATA-CONTRACTS-V2.md` for entity shapes, `SANDBOX.md` for rooms, `EXPORT-ENGINE.md` for delivery in depth.

---

## The principle

**Models do the creative work. Nothing a model *says* is trusted.** Every claim that something is done is checked by code, and wherever a rule exists it is enforced by structure — a mount, a function signature, a database constraint — rather than by asking a model to behave.

## The pipeline

```
PLAN          intake → repo read → mission planner
ASSEMBLE      roles and roster → identity generator
EXECUTE       dispatch and runner → sandbox rooms → completion records
VERIFY+SHIP   the gate → render → delivery
LEARN         knowledge and metrics
ACROSS ALL    proposals · surfaces · foundation
```

---

## 0. Foundation

The shared contract between `avel-server` and `avel-web`, the database, operator sign-in, the error vocabulary, and the activity log.

**Decision:** the contract lives in the server and the web app consumes it as a dependency, so all three client surfaces share one source of truth.

**From the first commit:**
- CI runs the doc check, determinism check, type check, lint, and tests on every push — and `pnpm test` exists
- The docs live in `avel-server/docs` and nowhere else; each README links to `STATE.md` and states no status
- The schema is built from `DATA-CONTRACTS-V2.md`, not carried from the previous build
- Database tests connect lazily, and CI runs them against a real database

## Plan — what to build

### 1. Intake

Raw client notes in; an approved brief out, which becomes a Mission. Canon drafts the brief. A mechanical check then confirms every requirement maps to an acceptance criterion and every open question is answered or explicitly acknowledged. Only then does the operator approve.

**Decision:** the highest-leverage output in the system gets a code check before it reaches a human.

### 2. Repo read

Reads the client repository and derives how the work splits: the cut, the conventions actually in use, and the natural boundaries — each with the evidence that decided it.

**Decision:** this is code, not a model. The split is derived, never invented. A convention that cannot be established with confidence blocks approval rather than being guessed.

### 3. Mission planner

Turns an approved brief, plus a template or pack where one applies, into modules, numbered requirements, and acceptance criteria.

**Decision:** requirement IDs are permanent. Every acceptance criterion, test, finding, and golden scenario traces back to one.

## Assemble — who builds it

### 4. Roles and roster

Assigns roles from the catalog in `ROLES.md` to named agents, written Name · territory where an agent is scoped to part of a project.

**Decision:** a role is a job and an agent is an assignment of jobs. Roles merge only within a side — author, tester, judge, or fixture — so nothing ever grades its own work.

### 5. Identity generator

Produces one identity file per agent from its roles, the role skills attached to those roles, its mount, edges, and rules. Each version is stored and hashed as `agent_version_sha256`.

**Decision:** generated, never hand-written, so it cannot drift from the catalog. An identity file says *who the agent is*; what a mission asks of it is a separate dispatch brief. Only the identity is hashed, so two runs with the same hash ran the same agent, whatever they were asked to do.

## Execute — build it safely

### 6. Dispatch and runner

Combines an agent's identity with one module's brief — including the mission's stack and domain skills recommended for its roles, hashed as `skills_sha256` — and runs it. Requires `estimated_tokens` before dispatch, warns at 1.5× the estimate, halts at 3×, and halts the mission at its spend ceiling. The model and harness are a plug with an ordered fallback chain.

**Decision:** budget is enforced by the runner, never by the agent. An agent stuck in a loop is by definition not judging its own budget well.

### 7. Sandbox rooms

Each agent works in a room generated from its roles: builder or checker. Code runs in a running room, and delivery happens in a delivery room. Mounts enforce directory boundaries; an exit checkpoint enforces pattern boundaries such as test files. The provider is a plug — local Docker, with others added later.

**Decision:** the GitHub credential exists in exactly one room, and the room that executes untrusted code has no network.

### 8. Completion records

Every dispatch closes with a `CompletionReport`: actual tokens, the hash of every artifact read and written, re-reads, and every blocker.

**Decision:** the cost fields are required — a dispatch cannot start without an estimate or close without an actual. A consumer's recorded hash that does not match the producer's shows an agent worked from the wrong version of an interface, caught before integration.

## Verify and ship — prove it, then deliver

### 9. The gate

Tests, the mutation floor, spec coverage, Fenn's golden scenarios, accessibility, fuzzing, the permission matrix, and the absence check all produce typed findings. `decide(findings)` turns them into pass or block.

**Decision:** no model decides whether work ships. Models produce evidence; arithmetic decides. **Build the function before any gate screen** — the previous build had gate display components and no decision function at all. A gate result may be overridden by the operator with written rationale. A violation — writing where an agent was not permitted — never can be.

### 10. Render

Produces the delivery package byte-for-byte identically every time, with a hash over every path and its content.

**Decision:** determinism is what makes the gate trustworthy. The rebuild follows `EXPORT-ENGINE.md` §13, including a versioned hash definition. Because the delivery re-renders rather than reusing the preview's bytes, the two hashes must match — a free determinism check on every export.

### 11. Delivery

Reads the client repository, computes what a write would create and overwrite, refuses a preview that has gone stale, runs pure-function guards, and delivers by zip, pull request, or push.

**Decision:** it is a safety mechanism that happens to write files. See `EXPORT-ENGINE.md` — the rebuild follows its §13 point by point.

## Learn — get better

### 12. Knowledge and metrics

Confirmed defects become permanent checks on every future mission. Agent performance is keyed by name · territory · engagement: discipline measures combine across everything under a name; outcome measures only within the same territory on the same template. Internal and client work are never combined, and reconstructed records are used for findings only.

**Decision:** the system learns; agents never edit their own instructions. A role changes only when the operator changes its definition, one variable at a time, and re-runs the same template.

## Across all stages

### 13. Surfaces

Web, desktop, and mobile — one backend, with desktop and mobile as Tauri builds of the web app. Mobile can approve but never initiates a delivery.

**Decision:** the server enforces what each surface may do. A rule that only hides a button is not a rule.

### 14. Proposals

**Agents may propose anything. They may act only inside a dispatch and their mount.** Every proactive output is a proposal in the operator's queue, approved or dismissed by the operator — the same pattern as Canon's brief.

Four sources:

| Proposal | Triggered by | Produced by | Approving it |
|---|---|---|---|
| **Next module** | A module's gate going green | Code | Dispatches the next module, with its token estimate filled in |
| **Calibration alert** | A pattern across completion reports — estimates repeatedly missed, blockers that are always provisioning gaps, a module that keeps crossing its soft ceiling | Code | Opens a change to a role definition or an estimate, for the operator to make |
| **Post-delivery check** | A schedule | Code — dependency and security checks re-run against delivered repositories | Records the finding, and may wake the incident role |
| **Intake questions** | Client notes arriving | Canon | Adds the questions to intake before the operator has read the notes |

Three of the four are code. Only intake questions involve a model, and it proposes questions — it decides nothing.

**Why proposals rather than autonomy.** An agent that starts its own work has an unbounded budget, cannot be attributed to a dispatch, and drifts outside its module — exactly what the runner, the mounts, and the version hash exist to prevent. Proactive action would undo the architecture. Proactive proposals remove the operator as the only source of momentum without giving up control.

**Whether post-delivery checks are offered to clients is a business decision,** since AVEL's terms are fixed price with no retainers. Running them on AVEL's own templates costs nothing either way.

---

## Explaining it in an interview

### The two-minute version

> AVEL is a platform I'm building to run AI coding agents on real client work. The problem it solves is that AI produces work that looks finished but isn't — not wrong answers, missing layers. The code compiles, the tests pass, and there's no access control, because nobody asked for it.
>
> So the core principle is: models do the creative work, but nothing a model *says* is trusted. Every claim that something is done gets checked by code.
>
> The pipeline has six stages. **Plan** turns a client request into numbered requirements, and code reads the repo to decide how the work splits. **Assemble** breaks the work into roles and assigns them to agents under one hard rule: nobody grades their own work. **Execute** runs each agent in a sandbox generated from its role, with a budget the runner enforces. **Verify** runs tests, mutation testing, an independently written fixture, and security checks; they all produce findings, and the ship decision is a pure function over those findings, never a model's opinion. **Ship** renders deterministically and delivers through an export engine that treats writing into someone else's repo as a safety problem. **Learn** turns confirmed defects into permanent checks and measures every agent against a versioned identity, so I can A/B test changes to an agent.
>
> The thread through all of it: wherever there's a rule, it's enforced by structure — a mount, a function signature, a database constraint — rather than by asking the model to behave.

Then let the interviewer choose the deep dive. The three strongest are the gate as a function (module 9), the credential living in one room (module 7), and delivery (module 11), which `EXPORT-ENGINE.md` already prepares in full.

### Likely follow-ups

**Why not let a model decide pass or fail?** A model's decision can be argued with; a function's cannot. Models produce findings, and arithmetic decides.

**How do you stop agents gaming their own tests?** Builders cannot write tests and testers cannot write code — enforced by their sandboxes, not by instruction. Mutation scoring proves the tests catch defects. And the golden fixture is written by an agent that has never seen the code, so it catches wrong code paired with a test that agrees with it.

**How do you control cost?** An estimate is required before dispatch, the runner warns at one and a half times it and stops at three, and building by modules keeps each run's context small.

**What if two agents disagree about an interface?** Handoffs are files, never messages. Each agent records the hash of every file it read, so a mismatch is a finding before integration.

**Are your agents autonomous?** They are proactive in detection and bounded in action. They file blockers rather than working around problems, flag defects outside their own scope, and every confirmed defect becomes a permanent check. But they act only inside a dispatch and their sandbox. Anything proactive becomes a proposal a person approves — because an agent that starts its own work has an unbounded budget and cannot be held to anything.

**How does it scale?** Modules dispatch independently and in parallel where their dependencies allow. The sandbox provider is a plug, so execution scales out, and the backend is a stateless API over Postgres.

**What is actually built?** Read `STATE.md` before the interview and say exactly what it says. Being precise about the scope of your own claims is part of the pitch.

---

## Open questions

| Question | Blocking |
|---|---|
| How often the post-delivery check runs, and against which repositories | Before module 14 is built |
| Module 5 stores each identity version, but `DATA-CONTRACTS-V2.md` says versioning is counter-only with no version-history table. Where does a past identity file live, so a hash can be resolved back to its content? | Before module 5 is built. *Partly answered 2026-10-05:* only the hash is recorded, on `CompletionReport`; module 5 chooses storage, and every recorded hash must resolve to its exact identity text. `DECISIONS-V2.md` |
