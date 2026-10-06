# Roster v2

Status: `[specced]`. Build status lives in `STATE.md`.

This document defines how roles are assigned to agents: the two cuts, how to choose between them, the mount and edge rules, and what stays fixed regardless.

**The roles themselves live in `ROLES.md`.** This document does not define jobs. It defines who covers them.

Related: SANDBOX.md covers where agents execute. DECISIONS-V2.md covers the gate model.

## Agents are assignments of roles

A role is a job with a fixed definition — what it owns, produces, consumes, and how it is checked and measured. An agent is an instance covering one or more roles for a set of paths.

```
ROLES.md       35 roles — fixed
    │
    ├── the cut          decides how roles group into agents
    ├── grain            decides how many agents cover a role
    └── composition      decides which roles a project needs at all
    │
    ▼
ROSTER         agents, each covering a set of roles over a set of paths
```

**Only `model` roles are assigned to agents.** A `code` role is a function in the pipeline and never appears on a roster. The `human` role, `foundations`, is the operator's `RosterEntry`.

**An agent's identity file is generated** from the roles it covers, plus its mount and edges. It is not hand-written, so it cannot drift from the role catalog.

## The correction

The earlier version of this document listed fifteen agents cut by layer and presented them as AVEL's roster. That was wrong in a specific way worth recording.

Those fifteen were derived from a layer-organized codebase. Applied to a feature-organized one, the cut does not survive. NestJS puts a module's controller, service, repository, and DTO in one directory, so a layer boundary becomes a file-suffix pattern that no filesystem mount can enforce.

The earlier version treated that as an enforcement problem and reached for diff checking. It is a decomposition problem wearing an enforcement problem's clothes. Under a feature cut it does not arise at all: one agent owns the directory, and the mount works.

So:

> **AVEL does not have a roster. It has a roster shape that is instantiated per stack.**

The principle is fixed. The cut is chosen by reading the client's directory structure.

## What is fixed

These hold for every instantiation, on every stack, always.

> **Audited during the roster redesign.** This section is the part of the document everything else trusts, and four of its claims had gone stale — one of them false since the day it was written. Each is corrected below with a note stating what it previously said. Trusted sections need re-auditing whenever the design changes underneath them; this one was not, and nothing flagged it.

**An agent boundary is worth its handoff cost only if it can be written as a set of writable paths.** This decides how roles group into agents and which cut to use.

*Correction:* this previously said the path rule "decides everything else." It does not. Role boundaries are decided by artifact — one kind of output per role — and the path rule decides only how roles group into agents. See `ROLES.md`.

**Verification and review agents cannot write source.** They get test directories and findings directories, nothing else. An agent that can edit the code it is testing can make any failing test pass by changing the code instead of fixing the bug. Remove the ability and you remove the temptation.

**Nothing that writes source writes the tests that grade it.** Every mount that writes source excludes `*.spec.ts`, `*.test.ts`, and `tests/**`, including inside the agent's own directories. Mission 002's feature agent wrote its code and its unit spec because the mount allowed it. This rule and the one above are the same principle from both directions.

*Correction:* this previously said "builders." Foundation roles also write source — migrations, contracts, tokens, primitives — and their mounts carried no exclusion. The principle was always about source, not about which family a role sits in.

**Agents exchange declared artifacts, never direct messages.** Every handoff is a file: a contract, a type definition, a findings report. Every consumer records the SHA-256 of what it read. Handoffs cannot be eliminated, but they can be made verifiable instead of assumed.

**Phases are global: foundation, build, verify, review, then operate after the ship decision.** Team or feature is a label, not a schedule. The v1 roster had frontend in wave 2 depending on an artifact produced by backend in wave 3, which is the kind of contradiction global phases prevent.

*Correction:* this previously listed four phases ending in "quality." Quality is now review, and a fifth family — operate — runs after the ship decision. Deploy and rollback had been placed in the review phase, producing findings for a decision they had no part in.

**The ship decision holds block authority above every builder, and it is a function.** `ship-decision` is arithmetic over typed findings from verify and review. The people who built something are biased toward shipping it, and a function has no bias either way. Only the operator overrides, and only with written rationale that renders into the delivery.

*Correction:* this previously said "quality holds block authority." That was true when the quality lead was an agent making the call. The call became a function because an agent deciding whether work ships is inference in the gate path. Review agents produce findings; they hold no authority.

**An agent with no writable paths is not an agent.** This is what cut the two lead roles from v1. Neither wrote product code, so neither produced an artifact. For a language model the scarce resource is context, and a lead consumes a great deal of it reading everyone's output to produce a summary no mechanism acts on.

*Correction:* this previously said the integration pass those leads held was "a script." No such script existed. The integration pass is assembling modules into a composition root, which is `foundations` work.

**No agent edits its own instructions.** Identity files are generated from the role catalog. Roles improve only when the operator changes a definition, one variable at a time, and re-runs the same template.

## Flexible instantiation — four axes

AVEL does not have a roster. It has a roster shape instantiated per project. Until now that instantiation flexed on one axis: the cut. It flexes on four, and all four are derived from the project rather than chosen.

| Axis | What it decides | Derived from |
|---|---|---|
| **Cut** | Layer or feature | Which boundary is a directory |
| **Grain** | How much one agent owns | Boundary size |
| **Composition** | Which specialist roles exist | What the project contains |
| **Phasing** | Which phases apply | The playbook for the project type |

### Grain from boundary size `[hypothesis]`

`Boundary.files` and `Boundary.loc` are already read at onboarding. They decide grain the same way the directory structure decides the cut.

| Boundary size | Instantiation |
|---|---|
| Several small boundaries, whole project under ~150 files | **Merge** into one agent owning all of them |
| One boundary, typical size | One agent per boundary — the current default |
| One boundary over ~400 files, or with internal sub-directories that are themselves directories | **Split** into sub-boundaries, one agent each |

**The thresholds are guesses.** One vertical-slice mission ran, produced zero boundary violations, and caught a real defect — the only evidence available, and it argues against splitting. Calibrate from the completion-report signals below before trusting any number here.

**A merge or split still produces disjoint writable paths.** A merged agent's mount is the union of the boundaries it absorbed. A split produces sub-boundaries whose paths do not overlap. Grain changes how many agents exist; it never produces two agents sharing a path.

### Composition from project content

Specialist roles are added when the project contains the thing they specialise in, and omitted otherwise.

| Project contains | Adds |
|---|---|
| Authentication or authorization | Security role |
| A user interface | Accessibility, as part of verification |
| Payments or money movement | Reconciliation specialist |
| Performance-sensitive surfaces | Performance budget |
| Real-time or concurrent writes | Concurrency review |
| None of the above | None — a small internal tool gets builders and verification only |

Detection is the same read as everything else at onboarding: dependencies, routes, schema, and directory names. It is code, not a model's judgment.

### Phasing from the playbook

`Playbook.waves_applicable` already declares which waves a project type uses. It now also shrinks the roster: a phase the playbook omits is a phase whose agents are not instantiated.

Every roster that writes source runs A through D, because the floor in *Merging roles into agents* needs a tester and a judge. Phasing can drop E. The hard block still applies to whichever wave comes first.

### What never flexes

**Flex the instantiation. Never flex the invariants.** Whatever shape a project gets:

- Every boundary is a set of writable paths
- Verification agents cannot write source
- Handoffs are artifacts, never messages — and consumers record the hash of what they read
- Foundations provisions before any builder dispatches
- No agent exists without writable paths
- Every dispatch carries a token estimate; every completion carries the actual

A one-agent project still has a verification pass that cannot touch source. A forty-agent project still routes every handoff through a hashed artifact. The shape changes. The guarantees do not.

### The calibration signals

Recorded on every completion report, so grain and composition become measured rather than asserted:

- **Distinct file types touched** — SQL, TypeScript, components, tests, config
- **Re-reads** — files read more than once in one dispatch
- **Blockers filed**, and whether each was an operator provisioning gap
- **Tokens, estimated versus actual**

High re-read counts on a heterogeneous slice are the evidence that grain is too coarse. Blockers that are all provisioning gaps are evidence the foundations phase is under-scoped. Neither is knowable today.

---

## Merging roles into agents

**Roles merge freely within a side, and never across one.** The side is what a role produces relative to everything else:

| Side | Roles | Produces |
|---|---|---|
| **Author** | Foundation and build roles | Source |
| **Tester** | Verify roles | Tests |
| **Judge** | Review roles, and `incident-response` | Findings |
| **Fixture** | `fixture` alone | The independent expected result |

Code roles are pipeline functions and never merge. Firm roles run between missions and never appear in a mission roster.

| Merge | Allowed | Why |
|---|---|---|
| Author + author | **Yes** | Both write source; neither grades the other. The vertical cut depends on it — Atlas · *feature* covers `schema` and `contract` alongside `domain` and `interface`. |
| Author + tester | **Never** | Grading your own work. F1. |
| Tester + judge | **Never** | One agent that misreads the specification carries the misreading into both its tests and its judgment. The two agree, and nothing catches it. |
| Author + judge | **Never** | Judging your own code. |
| Fixture + anything | **Never** | Every other role can see the code. The fixture's value is that its author cannot. |

**The floor follows from this.** Any roster that writes source needs one author, one tester, one judge, and Fenn — four model agents plus the operator. Anything smaller forces something to check its own work. A roster that writes no source, such as the audit template, has no author and so no floor of four.

**The merge rule is necessary, not sufficient.** Path still decides grouping. `design-system` may legally merge with Atlas — both are authors — but stays a separate agent because every feature shares it.

**Enforced by `scripts/check-docs.sh`,** which derives each role's side from its family in `ROLES.md` rather than from a hand-kept list, and fails on any assignment row that spans two sides.

*Correction:* this rule was first stated as "roles merge only within the same family." The vertical cut already broke it — Atlas merges foundation-family and build-family roles — and that merge is safe. Families were standing in for the real line, which is between producing and judging.

## Naming

**Every agent has a personal name. An agent assigned to one part of a project also carries a territory.** The two answer different questions, and keeping them separate is what lets agents keep their names without anyone learning something false from the numbers.

| Part | Answers | Example |
|---|---|---|
| **Name** | *How does it work?* — the identity file it runs on | Atlas |
| **Territory** | *What does it own here?* — the part of this project it is scoped to | `scheduling` |
| **Engagement** | *Which project is this?* | A dental clinic's booking app |

An agent with a territory is written **Name · territory**: Atlas · scheduling. An agent without one — doing the same job across the whole project — is just its name: Nemi.

**This applies to any agent, not only builders.** A territory appears whenever an assignment covers one part of a project rather than all of it:

| Situation | Written as |
|---|---|
| A feature under the vertical cut | Atlas · scheduling |
| A layer split across two parts of a large app | Leon · storefront, Leon · admin |
| Testing split per feature in a large project | Nemi · scheduling, Nemi · accounts |
| A large feature split into sub-parts | Atlas · bookings/calendar, Atlas · bookings/payments |

**Atlas is the default name for a builder that owns one feature through every layer** — the most common assignment under the vertical cut. Every such builder runs the same identity file, so two feature builders in one mission are two instances of one identity: Atlas · scheduling and Atlas · accounts.

**Why Atlas.** It is one of the original names, retired when the backend lead role was cut. That role's description included full-stack integration, and it was cut for producing no artifact. As the full-slice builder, Atlas writes every line of source for a feature — the most artifact-heavy job in the roster. The name was never the problem; the job was.

### What tells one app's feature from another

**The territory and the engagement, never the name.** Atlas · scheduling in a dental clinic's app and Atlas · scheduling in a hotel's app run the same instructions on different codebases. They share an identity file. They do not share numbers.

Every measurement is keyed by **name · territory · engagement**. What may be combined depends on what kind of measurement it is:

| Kind | Examples | Combines across |
|---|---|---|
| **Discipline** — how the agent behaves | Boundary violations; blockers filed versus absorbed; reading the wrong version of an artifact; test-file writes caught at the exit | Every territory and engagement under the same name — "is Atlas following the rules?" |
| **Outcome** — how hard the task was | Tokens, cost, time, defects found, first-pass gate rate | **Only the same territory on the same template** — "is Atlas · scheduling on `template-fullstack` getting cheaper?" |

A hotel booking app may simply be harder than a dental one. Averaging their costs would say something about Atlas that is really about hotels.

**Discipline numbers are less affected by the domain, not unaffected.** A messy client codebase raises re-reads regardless of how disciplined the agent is. So even discipline numbers are never combined across greenfield and brownfield work, or across internal and client missions.

**Never store or report a territory-scoped measurement under the bare name.** "Atlas's cost" means nothing. A report that drops the territory or the engagement is refused by code, not by convention.

### The mount table is still keyed by path

A territory resolves straight to its paths: `modules/scheduling/` belongs to Atlas · scheduling. The name points at one identity file, and the territory does the lookup — so no separate table maps names to folders, and nothing drifts.

### History

This section previously said a personal name meant an agent owned no feature, and a territory name meant it did — so a feature builder had no personal name at all. That was a way of preventing cross-project averaging by withholding names. It worked, but it cost the names. Keying measurements by name · territory · engagement prevents the same error directly.

It also once said personal names were dangerous because they "imply persistence." Persistence was never the problem; for role agents it is what makes their measurements meaningful. The danger was a persona that **produced no artifact** — the two lead roles, cut for having no writable paths, not for having names.

**Historical records keep the names they ran under.** Mission 002's agent is recorded as `transactions`, because that is what ran. New rosters use Atlas · transactions.

### Merged agents

Which roles may merge is governed by *Merging roles into agents* above. When they do, **the agent takes the name of its heaviest role** — the role doing most of the work in that project. In a webhook integration the merged reviewer is mostly checking signatures, so it is Zane rather than Brennan. The name is a hint about emphasis, never a limit on which roles the agent covers.

### The name register

Every name from the original roster, and where it lives now.

| Name | Covers | Status |
|---|---|---|
| Axis | `foundations` | The operator |
| Leonora | `schema`, `contract` | Active |
| Fantem | `design-system` | Active |
| Fenn | `fixture` | Active — reassigned from deploy and recovery, which became code |
| Kel | `domain` | Active |
| Dunn | `api-surface`, `integration`, `realtime` | Active |
| Gat | `auth` | Active |
| Ghost | `state` | Active |
| Leon | `interface` | Active |
| Iyo | `backend-tests` | Active |
| Nemi | `frontend-tests` | Active |
| Raze | `property-tests` | Active |
| Brennan | `spec-judgment` | Active |
| Zane | `security-review`, `compliance-review` | Active |
| Kodie | `concurrency` | Active — reassigned from performance, which became code |
| Grim | `incident-response` | Active — the model half of his original role; the ship decision became a function |
| Canon | `intake`, `strategy` | Active |
| Trace | `research` | Unbuilt |
| Uno | `client-ops` | Unbuilt |
| Blair | `knowledge` | Code — name kept as a label |
| Plye | `render` | Code — name kept as a label |
| Neil | — | Free; observability became code |
| Atlas | The full-slice builder — every build role for one feature | Active — revived; written Atlas · *feature* |
| Zero | — | Retired; folded into `foundations` |
| Della | — | Retired; cost is a field |

**Fenn and Kodie were reassigned rather than retired.** Their original roles became code, which freed the names. Kodie's fits closely — performance and concurrency are both about behavior under load. Fenn's is a new job under an existing name.

**Blair and Plye are code, not agents.** They keep their names as labels for two pipeline components. A label on a function is harmless as long as nobody mistakes the function for something that reasons.

## Choosing the cut

Read the client's directory structure before assigning anyone.

| The codebase groups files by | Cut | One agent owns |
|---|---|---|
| Layer | Horizontal | One layer, across every feature |
| Feature | Vertical | One feature, through every layer |

**Layer-organized** looks like `services/`, `handlers/`, `db/`, `components/` at the top level. A Go service, a Rails app, most Express codebases. The layer boundary is a directory, so it mounts cleanly.

**Feature-organized** looks like `modules/transactions/`, `modules/documents/`, each holding its own controller, service, and repository. NestJS, Next.js app-router colocation, most Angular. The feature boundary is a directory; the layer boundary is a suffix pattern.

The test is mechanical: **which boundary is a directory in this codebase?** That is the cut. You are not choosing a philosophy, you are reading a filesystem.

## The horizontal instantiation

For layer-organized codebases. **One agent per role**, across every feature.

| Phase | Agent | Covers roles | When |
|---|---|---|---|
| A | Leonora | `schema`, `contract` | always |
| A | Fantem | `design-system` | always |
| A | Fenn | `fixture` | always |
| B | Kel | `domain` | always |
| B | Dunn | `api-surface`, `integration`, `realtime` | always |
| B | Gat | `auth` | always |
| B | Ghost | `state` | always |
| B | Leon | `interface` | always |
| C | Iyo | `backend-tests` | always |
| C | Nemi | `frontend-tests` | always |
| C | Raze | `property-tests` | always |
| D | Brennan | `spec-judgment` | always |
| D | Zane | `security-review`, `compliance-review` | always |
| D | Kodie | `concurrency` | conditional — real-time or concurrent writes |
| E | Grim | `incident-response` | on demand — after delivery, on an incident |
| A | operator | `foundations` | always |

**Thirteen model agents in every mission, plus up to two more:** Kodie when composition requires concurrency review, and Grim on demand after delivery. The operator covers `foundations`. Code roles — `accessibility`, `performance`, `spec-check`, `adversarial`, `reconciliation`, `deploy`, `recovery`, `observability`, and the platform roles — run as pipeline functions and have no agent.

**Every model role that runs inside a mission has a row with a real agent.** Firm roles run between missions. A previous version of this table listed `concurrency` against an agent of `—`, meaning nobody; `fixture` and `incident-response` had no row at all. The audit that first checked this counted a role as assigned if its name appeared anywhere in the table, so the `—` row passed. `scripts/check-docs.sh` now checks for a real agent in the row, not a mention.

**Fenn cannot share a mount.** Agents normally group by path, but the fixture's value is independence from the render, so it is the one role that is never grouped with another.

The count is thirteen now, where the previous table said thirteen but listed twelve. It is the same number for a different reason: Fenn was added. Counted from the table, not carried over.

**Changed from the previous horizontal roster:**

- Kodie is no longer an agent. `performance` is a code role; charts moved into `interface`.
- Fenn is no longer an agent. `deploy` and `recovery` are code roles in the new Operate family, after the ship decision.
- Raze covers only `property-tests`. `adversarial` is a fuzzer.
- Brennan covers only `spec-judgment`. `spec-check` is a set difference.
- Dunn covers three roles. One agent is fine at default grain; split when real-time work is heavy.

### Mount table

Paths are illustrative. Concrete globs come from the client project and are stored in `AgentTemplate.writable_paths`. **Every builder row excludes test files.**

| Agent | Writable | Read-only |
|---|---|---|
| Leonora | `db/`, `migrations/`, `contract/` — excluding tests | none |
| Fantem | `tokens/`, `styles/`, `primitives/` — excluding tests | none |
| Fenn | `fixtures/golden/` | the render specification only — never render source or output |
| Kel | `services/`, `domain/` — excluding tests | `db/`, `contract/` |
| Dunn | `routes/`, `api/`, `integrations/` — excluding tests | `services/`, `contract/` |
| Gat | `auth/`, `middleware/` — excluding tests | `db/`, `contract/` |
| Ghost | `lib/`, `stores/`, `hooks/`, `types/` — excluding tests | `contract/` |
| Leon | `components/`, `app/` — excluding tests | `primitives/`, `tokens/`, `types/` |
| Iyo | `tests/backend/` | all source |
| Nemi | `tests/frontend/` | all source |
| Raze | `tests/property/` | all source |
| Brennan | `findings/spec-judgment/` | everything |
| Zane | `findings/security-review/`, `findings/compliance-review/`, `permissions/policy.json` | everything, incl. the security surface doc |
| Kodie | `findings/concurrency/` | everything, plus load-test and race-detection output |
| Grim | `incidents/`, runbooks | everything, plus observability signals |

### Edges

| From | Artifact | To |
|---|---|---|
| Leonora | `contract/api.openapi.json` | Kel, Dunn, Ghost, Iyo, Raze |
| Fantem | `tokens/`, `primitives/` | Leon |
| Ghost | `types/boundary.ts` | Leon |
| Kel | service signatures | Dunn |
| Gat | `docs/security-surface.md` | Zane |
| `spec-check` | uncovered criteria | Brennan |
| Verify and review | `findings/` | `ship-decision` — a function |

Every consumer records the SHA-256 of each artifact it read in its `CompletionReport`.

## The vertical instantiation

For feature-organized codebases. Agent count equals feature count, plus the horizontal roles.

One agent owns one feature through every layer: its schema tables, its services, its endpoints, its guards, its state, its components. It is dispatched once and gated once.

CounselOS is the reference implementation. Six feature agents (transactions, documents, deadlines, chat, drafts, case-ops) plus Nemi.

### Role assignment

**A feature agent covers every build role its feature needs, for that feature's paths only.**

| Agent | Covers roles | Over | When |
|---|---|---|---|
| Atlas · *feature* — one per feature | `schema`, `contract`, `domain`, `api-surface`, `auth`, `state`, `interface` — plus `integration` or `realtime` if the feature has them | That feature's paths | always |
| Fantem | `design-system` | Shared tokens and primitives | always |
| Fenn | `fixture` | `fixtures/golden/` | always |
| operator | `foundations` | Shared surface | always |
| Nemi | `backend-tests`, `frontend-tests` | Test paths across all features | always |
| Raze | `property-tests` | `tests/property/` | always |
| Brennan | `spec-judgment` | `findings/spec-judgment/` | always |
| Zane | `security-review`, `compliance-review` | `findings/`, permission policy | always |
| Kodie | `concurrency` | `findings/concurrency/` | conditional — real-time or concurrent writes |
| Grim | `incident-response` | `incidents/` | on demand — after delivery, on an incident |

**`design-system` is shared, never owned by a feature agent.** Tokens and primitives are used by every feature. A feature agent owning them would either write outside its own paths or leave the other features to invent their own, and the second is how six features end up with six button styles. A previous version of this table had no owner for `design-system` at all under the vertical cut.

The same roles as the horizontal cut, grouped differently. Horizontal groups by role across features. Vertical groups by feature across roles.

**The builder roles never include a test role.** A feature agent covers the whole vertical slice of *source*. Every test for that feature is written by a verification agent that cannot touch the source it tests.

### Why the names do not transfer

There is no horizontal agent that corresponds to a feature agent. Kel owns every service across all features; Atlas · transactions owns one service among many, plus five other layers. These are different boundaries, not different vocabularies for the same boundary.

**Nemi is the exception because Nemi is horizontal in both cuts.** She tests everything and owns no cell in the grid, which is why her name and her job are the same in both cuts.

Feature agents are written Atlas · *territory*. The name is shared, and the territory tells them apart. See *Naming*.

### The horizontal roles a vertical cut still needs

**Three, minimum. All build nothing.**

**Verification.** Nemi, or an equivalent. Tests every feature, writes only to test directories.

**Foundations.** This one is the gap the vertical cut opens and it must be filled explicitly.

Under the horizontal cut, Leonora owns schema conventions and the cross-feature contract. Under the vertical cut, six agents each own a slice of the schema and their own endpoints, and **nobody owns consistency between them.** Six agents will produce six ways of naming a timestamp column, six error envelope shapes, six pagination conventions, and you find out at integration.

A drift-recording file is not a substitute. Recording drift is what you do after you have already lost.

The foundations role owns shared schema conventions, the cross-feature contract, and the shared package. It writes conventions and reviews adherence. It does not build features.

Assign it to an existing agent, create one, or have the human orchestrator do it manually for the first slice. All three are acceptable. Leaving it unassigned is not.

**Security.** The third role, and it is currently unowned in the same way foundations was before Mission 002.

The merge queue says every agent's first backend module gets an adversarial security review in a fresh session before merge. "A fresh session" names a setting, not an owner. That is a condition with nobody attached to it, which is exactly the shape of the gap that blocked four times before the first commit.

Cross-feature permission interactions are a seam, and owning territory disqualifies you from judging a seam — the same reasoning that keeps verification horizontal. A feature agent cannot audit whether its own guards compose correctly with another feature's.

Under the horizontal cut this is Gat plus Zane. Under the vertical cut it needs a name and a mount, and it must not be a feature agent.

**Do not assign it to a feature agent.** Owning territory disqualifies you from judging a seam, which is the same reasoning that keeps the verification role horizontal.

**Foundations runs before the first feature agent, not after the second.**

This corrects an earlier version of this document, which said the role became necessary once two or more feature agents dispatched concurrently, reasoning that convention divergence requires concurrent writers.

Mission 002 falsified that. Foundations was needed on the first slice, with one agent running, and blocked four times before the first commit: the composition root, the shared package (three times), and the reports directory.

The reasoning error was about *function*. Divergence prevention is a second-order need and does require concurrent writers. **Provisioning is first-order and requires none.** Under a vertical cut, the first feature agent needs shared surface that does not exist yet and owns none of it. There is nothing to diverge from because there is nothing there.

So the role has two phases:

| Phase | When | Function |
|---|---|---|
| Provisioning | Before the first feature dispatch | Create the shared surface: composition root, shared package, contract conventions, reports and compliance directories |
| Convention keeping | Once two or more feature agents write concurrently | Prevent divergence across features |

The provisioning phase can be the operator. The convention-keeping phase is where making it an agent becomes worth considering, and by then completion reports will describe what it actually did.

### Vertical mount table shape

| Agent | Writable | Read-only |
|---|---|---|
| Atlas · *feature* | `apps/api/src/modules/<feature>/`, `apps/web/src/app/<feature>/`, `apps/web/src/components/features/<feature>/` — **excluding `*.spec.ts`, `*.test.ts`, `*.test.tsx`** | shared packages, other features, contract |
| Design system | `apps/web/src/styles/`, `apps/web/src/components/ui/` — excluding tests | all features |
| Fixture | `fixtures/golden/` | the render specification only |
| Foundations | `packages/shared/`, `apps/api/src/common/`, `apps/api/src/database/`, contract conventions | all features |
| Verification | `apps/api/test/`, `apps/web/e2e/`, `**/*.spec.ts`, `**/*.test.ts`, `**/*.test.tsx` | all source |
| Property tests | `tests/property/` | all source |
| Spec judgment | `findings/spec-judgment/` | everything |
| Security | `findings/security-review/`, `findings/compliance-review/`, `permissions/policy.json` | all source, all features |
| Concurrency | `findings/concurrency/` | all source, load-test output |
| Incident | `incidents/`, runbooks | all source, observability signals |

**The exclusion is the fix for F1.** Previously a feature agent's path `modules/<feature>/**` contained its own spec files, so it wrote the code and the tests that graded it. Test files inside a feature directory now belong to verification, even though they sit next to the source.

Every boundary here is a directory, so every boundary mounts. This is why the vertical cut is correct for feature-organized frameworks and the horizontal cut is not.

**Name the composition root explicitly.** Most feature-organized frameworks have one file every feature must register itself in: a NestJS `app.module.ts`, a router table, a plugin registry, a DI manifest. It belongs to no feature and every feature must write it.

Grant it **append-only** to every feature agent. Omitting it from the mount table means the first agent cannot load its own module, which is what happened in mission 002.

**Grant the process directories by default.** Every agent is required to write a completion report and any compliance attestation. Withholding `reports/` and `compliance/` forbids the thing the process requires.

### Sequencing

A vertical cut concentrates risk differently. One agent per slice means fewer coordination failures and more surface area per agent, including layers it may never have written before.

Stagger the first runs. One agent goes dispatch-to-completion before another starts. Choose the feature with the fewest external dependencies first, so an early failure is a process failure rather than pipeline complexity. Give each agent's first backend module an adversarial security review in a fresh session before merge.

Those conditions came from CounselOS's merge queue and they generalize.

## The block decision is a function, not an agent

The v1 roster and the first draft of this document both listed a quality lead holding pass-or-block authority over every builder. Applying this document's own rules removes it.

**It fails the boundary rule.** Its mount was `findings/`, which is a superset of `findings/spec/`, `findings/security/`, and `findings/adversarial/`. A superset is not a boundary. Every other agent in the roster is defined by a disjoint writable set; this one was defined by containing three others.

**It fails the artifact rule.** Its output was judgment over other agents' artifacts. That is the same shape as the two lead roles cut from v1, one layer higher. Authority does not change the shape — authority is a property of the gate, not of the agent standing next to it.

**And it violates the standing determinism rule.** DECISIONS-V2.md states that no inference runs in the render, freeze, gate, or delivery path. The pass-or-block decision is the gate. An agent performing inference to decide whether work ships is inference in the gate path, which is the one thing the architecture forbids outright.

**Resolution.** The block decision is a pure function over typed findings:

```
decide(findings: Finding[]) -> pass | block
```

Findings carry a severity and a class. The function is arithmetic over them. It is auditable, reproducible, and identical every run, which a model's judgment is not — and that matters most for the decision sitting above every other decision.

Brennan, Zane, and Raze remain agents. Findings are input to the gate, not the gate.

This puts the block decision alongside Blair and Plye on the permanently-code list. Replacing a provably correct function with a probably correct one is not an upgrade, and the gate is the last place to make that trade.

## Roles preserved in both cuts

Three v1 designs are the strongest part of the system and survive whichever cut is chosen.

**Implementer to attacker.** The agent that builds the security surface is required to document it. A separate agent uses that documentation as the attack map. Adversarial reuse of an artifact the builder had to produce anyway.

**Spec verifier and adversary, separated.** One agent verifies against the spec. The `adversarial` fuzzer, a code role, breaks things without reading the spec, because knowing what is supposed to work blinds you to what can break. Most rosters never separate those postures.

**The steal list.** Five real product decisions with evidence before the design agent may close. The only hard deliverable in the roster that is not code, and what separates research-backed design from training-data averages.

## The adversary now has mechanical inputs

This was the one strong role that had no mechanism behind it. The five gate additions supply three.

"Break everything without reading the spec" is a good instruction and a poor mechanism on its own. A language model with no spec produces plausible-looking adversarial tests — null, empty string, negative numbers. That is the training-data average of an edge case. It will not find the race condition.

Three inputs change that:

| Input | What it turns into |
|---|---|
| The permission matrix | Attack the undefined cells directly. Mission 002's authorization defect lived in one. |
| Property-based testing | Thousands of cases generated from stated invariants rather than a dozen imagined ones. fast-check for TypeScript, Hypothesis for Python. |
| The findings registry | Has this defect class appeared before, and does the current work reproduce it? |

Raze's mount is `tests/property/`, with read access to the permission matrix. The adversary is the `adversarial` fuzzer, a code role.

## The implementer-to-attacker edge becomes an artifact

The security pair is the best-designed relationship in the roster and it was still an unverifiable handoff: the implementer wrote prose, the attacker read it.

**Make the implementer's output the machine-readable permission policy** — the expected value for every role, resource, and state cell — rather than a document describing it.

Three things follow:

- The attacker has a concrete surface rather than a narrative
- The absence gate independently checks that every cell carries a declared expectation
- The edge is diffable, so a change to the security surface is visible as a diff rather than as a rewritten paragraph

This is the same move as the phase-1 contract: a handoff that can be verified rather than one that has to be trusted.

## The dispatch is generated, not authored

Mission 002 produced zero agent boundary violations across 61 files and **three operator errors**. All three were the same shape: a hand-written dispatch forbade something the mount table already granted — the composition root, the shared package, the reports directory.

The failure was not the agent misreading its boundary. It was a human transcribing a boundary that already existed in machine-readable form.

**Generate the dispatch from `roster.json`.** The mount section, the append-only list, the read-only set, and the edges are all already declared. A dispatch that derives them cannot contradict them.

That does not make the error less likely. It makes it structurally impossible, which is the standard every other mechanism in this system is held to.

What stays hand-written: the task, the acceptance criteria, and anything specific to this slice. What stops being hand-written: every boundary statement.

**Expected result for the next mission:** operator boundary errors go from three to zero, and if they do not, the cause is somewhere the mount table does not reach — which is itself a finding worth having.

## Command Center

The firm roles, which run between missions rather than inside them, now live in `ROLES.md` under the Firm and Platform families. Unaffected by the cut.

| Original | Now |
|---|---|
| Canon | `intake` and `strategy` — both `model`. `intake` is checked mechanically before operator approval. |
| Trace | `research` — `model`, unbuilt |
| Uno | `client-ops` — `model`, unbuilt |
| Blair | `knowledge` — `code`, permanently |
| Plye | `render` — `code`, permanently |
| Della | **Removed.** Cost per dispatch is `actual_tokens` on `CompletionReport`, which needs no role. |

Replacing a provably correct function with a probably correct one is not an upgrade.

## What this means for AVEL's data model

`RosterPreset` was modeled as a saved squad. Under this document it is the instantiation: a preset is a cut plus an agent set plus a mount table, applied to a mission.

`Mission` records which cut is in effect, because the coherence rules differ. A vertical mission with no foundations role assigned is incoherent in a way a horizontal mission is not.

The shape is `Mission.cut`, `cut_source`, and `cut_rationale` in `DATA-CONTRACTS-V2.md`.

## The one honest per-agent metric

Per-agent telemetry was demoted because with no missions run it is noise. The findings registry supplies a signal that needs no new instrumentation: **did this agent's work match a previously confirmed defect?**

That measures whether an agent repeats known mistakes. It is derived from data the gate already produces, and unlike throughput or lines written it cannot be gamed by looking busy.

Two rules for using it:

**Do not rank agents on it.** Ranking is how you get an agent that files fewer blockers because filing looks bad. Mission 002's most valuable behavior was three blockers filed rather than absorbed; a metric that penalizes that destroys the thing worth keeping.

**Aggregate at five missions, not before.** Two data points is not a trend, and a per-agent number computed from one run is an anecdote with a decimal point.

## Known flaws

An honest audit of the agent system. Several were introduced by changes made during the redesign, and are marked so; the critique applies to the recommendations as well as the originals.

**Status:** all fourteen are addressed in the design — thirteen fully, F13 partially, since a past run can only be reconstructed, never recorded. **None are closed.** "Addressed" means the specification no longer permits the flaw; it becomes "closed" only after a mission runs under the new specification without reproducing it.

| # | Status | Addressed by |
|---|---|---|
| F1 | addressed | Builder mounts exclude test files |
| F2 | addressed | `spec-judgment` as its own role |
| F3 | addressed | Identity files generated from role definitions |
| F4 | addressed | Mechanical check on `intake` before operator approval |
| F5 | addressed | `property-tests` moved to verify; `adversarial` is a fuzzer |
| F6 | addressed | `reconciliation` and `concurrency` defined in the catalog |
| F7 | addressed | Operate and Firm families recover all four duties |
| F8 | addressed | Roles split by artifact, agents group by path |
| F9 | addressed | `deploy` and `recovery` moved to Operate |
| F10 | addressed | Soft ceiling at 1.5× warns, hard ceiling at 3× halts, mission spend is the backstop; enforced by the runner, never self-policed |
| F11 | addressed | New `fixture` role, `model`, independent by mount; updates only on a specification change, never on a render change |
| F12 | addressed | The horizontal roster was always an assignment of roles |
| F13 | addressed, partially | Mission 002 backfilled from git at `31f4b44` and marked `reconstructed`: valid for its findings, excluded from all comparisons. Every run from here is `recorded`. |
| F14 | addressed | The fix for F1 was not enforceable by a mount when tests sit beside source. Pattern boundaries are enforced at an exit checkpoint; greenfield templates avoid it by using separate test directories. See `SANDBOX.md`. |

### Critical

| # | Flaw | Why it matters |
|---|---|---|
| F1 | **Builders can write their own tests.** Under the vertical cut, a feature agent's writable path `modules/<feature>/**` contains its own `*.spec.ts` files. | The self-grading risk is not unresolved — it is structurally permitted. Mission 002's agent wrote the code and the tests that graded it. |
| F2 | **Mutation testing cannot catch a wrong test.** It catches tests that assert nothing, not tests that assert the wrong thing. | An agent that misreads a requirement writes wrong code and a test confirming it, and mutation passes cleanly. Only independent spec verification and the golden fixture catch this. Spec verification has never run. |
| F3 | **Agents run on stale instructions.** Identity files were written 2026-08-16. Every roster change since lives only in this document. | This document describes agents that do not exist in the files agents actually load. |

### High

| # | Flaw | Why it matters |
|---|---|---|
| F4 | **Canon is checked only by the operator.** *Introduced by the redesign.* | Canon now writes briefs, and bad specification is among the largest causes of multi-agent failure. Its only check is operator approval, and by measured evidence the operator is the most error-prone agent in the system. |
| F5 | **Raze's mechanical input contradicts Raze.** *Introduced by the redesign.* | Property testing requires stating invariants, and invariants come from the spec. The input that made Raze enforceable removed the spec-blindness that made Raze valuable. |
| F6 | **The composition table calls for agents that do not exist.** *Introduced by the redesign.* | "Reconciliation specialist" and "concurrency review" have no identity file, no mount, and no definition. The roster can require an agent it has no way to instantiate. |
| F7 | **Four duties have no owner.** Incident response (Grim), observability (Neil), the integration pass (Zero and Atlas — described as "a script" that does not exist), and Canon's strategic role. | Cutting an agent removed the name and left the work unassigned. The same failure as deleting a definition and leaving references behind, applied to responsibilities. |

### Medium

| # | Flaw | Why it matters |
|---|---|---|
| F8 | **The writable-paths rule is blind to expertise.** | It decides boundaries by directory, so REST routes, integrations, and real-time stay together because they share `routes/`. Real-time concurrency is a different failure class from CRUD. The rule sees where files live, not that one agent is doing three jobs. |
| F9 | **Fenn sits in the wrong phase.** | Deploy and rollback are builder work, not verification. Fenn produces findings for a ship decision it should not be part of. |
| F10 | **Nothing stops an agent mid-run.** | Token estimate is required at dispatch and actual at close, but nothing enforces a ceiling while running. `spend_ceiling_usd` is still read by nothing. |
| F11 | **The golden fixture has no owner over time.** | Hand-written once, correctly. As the render evolves, nobody keeps it current, and every determinism test becomes a comparison against a stale baseline. |
| F12 | **The horizontal roster may be maintenance for nothing.** | The horizontal roster, designed for layer-organized codebases, has never run. Most modern frameworks, CounselOS included, are feature-organized. |

### Low

| # | Flaw | Why it matters |
|---|---|---|
| F13 | **Mission 002 cannot be attributed to an agent version.** | The version hash was added after the fact. The only successful feature-agent run predates the mechanism for learning from it. |

### Fix before the rewrite

- **F1 and F2 together** — exclude `*.spec.ts` from every builder mount and grant it to verification, then run spec verification once.
- **F3** — rewrite the identity files against the current roster. Every other fix is invisible to an agent until then.
- **F4** — a mechanical check on Canon's brief before operator approval: every requirement maps to an acceptance criterion, and `open_questions` is empty or explicitly acknowledged.

---

## Open questions

| Question | Status |
|---|---|
| Does `Mission` carry a `cut` field? | **Resolved.** Derived from the repo, not chosen. `cut`, `cut_source`, `cut_rationale`. See DATA-CONTRACTS-V2.md. |
| Who owns foundations in CounselOS Slice 1? | **Resolved.** The operator, unless a dispatch names someone else. |
| Named identities or territory names? | **Resolved, twice.** First as territory names only. Then as both: every agent has a personal name, and a scoped agent also carries a territory — Atlas · scheduling. See the naming section. |
| Should the horizontal instantiation be trimmed? | **Not on data — the rule already trimmed one.** A successful vertical mission is weak evidence about a horizontal roster: different cut, different coordination surface, different failure modes. The vertical cut's advantage is that it minimizes coordination, so it cannot measure coordination cost. Only a horizontal mission on a layer-organized codebase can. Until then the horizontal instantiation stays specced, untrimmed, and labeled untested. |
| Is the cut a property of the repository or of a mount root? | **Open.** A monorepo can be layer-organized on the backend and feature-organized on the frontend. CounselOS is uniform so it will not surface here, but a scalar `cut` bakes in an assumption. Decide before the first non-uniform client. |
| How many horizontal roles does a vertical cut need at minimum? *The horizontal roles a vertical cut still needs* says three and calls security unowned, while the vertical role table assigns seven non-feature agents as always, Zane among them. | **Resolved 2026-10-05:** four model agents (author, tester, judge, fixture) plus the operator. The two sections above have not been rewritten to match; see `DECISIONS-V2.md`. |
| What severity is F14? It has a status row but no row in the severity tables. | **Deferred** (2026-10-05). |
