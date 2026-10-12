# Templates

Status: `[specced]`. Build status lives in `STATE.md`.

A template is a reusable mission configuration. This document defines the catalog, how templates are built, and how building them doubles as the evaluation loop for AVEL's agents.

Related: `ROSTER-V2.md` defines the four instantiation axes. `DATA-CONTRACTS-V2.md` defines `Playbook`, `RosterPreset`, and `CompletionReport`.

---

## What a template is

**A template is scope × starting state. Domain is a parameter, not a template.**

"E-commerce" is not a template. Treating it as one produces e-commerce full stack, e-commerce backend, e-commerce frontend — a combinatorial catalog nobody can maintain. Three axes, and only two decide the roster:

| Axis | Values | Decides |
|---|---|---|
| **Scope** | full stack, frontend, backend, integration, data, automation, migration, audit | Roster shape, via the four instantiation axes |
| **Starting state** | greenfield, brownfield | How conventions and cut are obtained |
| **Domain** | e-commerce, booking, legal, CMS, SaaS, real-time | Domain-specific obligations for the absence gate |

Domain contributes obligations — booking adds "a slot cannot be double-booked," e-commerce adds "an inventory reservation releases on abandon." Those land in the absence gate and the findings registry. They do not change who is on the mission.

---

## The eight scopes

**Full stack.** Schema through UI. Phases A to D, feature cut, full specialist composition.

**Frontend only.** The client has an API and needs a UI. No backend builders. The contract is consumed, never defined, so conformance against their existing API matters more than usual.

**Backend / API only.** Contract-first, no UI agents. The contract is the deliverable.

**Integration.** Connecting systems that already exist — payment providers, CRM sync, webhooks between tools. No UI, often no new database. Usually one merged agent. The most common small-business request and the fastest to deliver.

**Data / pipeline.** ETL, reporting, dashboards over existing data. Determinism matters here more than anywhere; a report that changes on re-run is a defect.

**Automation.** Scheduled jobs, workflows, triggers. Often a single agent.

**Migration.** Moving from one system to another — spreadsheet to database, one platform to another. Requires a verification step no other scope needs: proof the data arrived complete and unaltered.

**Audit.** The condition report. **Produces no code.** Verification roster only, phases C and D, output is findings. The one template that sells before any other exists.

---

## Starting state matters more than scope

Most template thinking assumes greenfield. Most real client work is brownfield — add a feature to something that already exists.

| | Greenfield | Brownfield |
|---|---|---|
| Conventions | Chosen | Extracted — `ConventionSet` |
| Cut | Follows the scaffold | Derived from their tree |
| Blast radius | Mostly creates | Mostly overwrites |
| Golden fixture | The whole package | The delta only |
| Foundations | Provisioned | Discovered |

A greenfield template is a starter kit. A brownfield template is a procedure. The onboarding read — cut, conventions, boundaries — is what makes brownfield tractable.

---

## Mapping to the four axes

| Template | Cut | Grain | Composition | Phases |
|---|---|---|---|---|
| Full stack | feature | default | full | A–D |
| Frontend | feature | default | UI, accessibility, performance | A–D |
| Backend / API | derived | default | security if auth | A–D |
| Integration | none | merged | security | A–D |
| Data / pipeline | layer | default | none | A–D |
| Automation | none | merged | none | A–D |
| Migration | derived | default | reconciliation | A–D |
| Audit | none | none | verification only | C–D |

Each row is a `Playbook` plus a `RosterPreset` instantiation rule. No new mechanism.

---

## Building templates with AVEL's own agents

Every template build is a mission. Building them with the roster produces measured missions without a client — which addresses the constraint that has blocked every other claim in this project.

### Who builds what

| Part | Author | Reason |
|---|---|---|
| Playbook | Operator | It is policy. Agents do not write the rules that grade them. |
| RosterPreset | Operator | It defines the agents. |
| Domain obligations | Operator | A requirement, not an output. |
| Golden fixture | **Fenn** — a model agent, render absent from its room | Its value is independence, which comes from never seeing the code — enforced by the room, not by being human. Updates only on a specification change. |
| Starter scaffold | **Agents** | The actual build work. |

**This split prevents circularity.** An unproven roster writing the configuration that defines the roster would bake any flaw in the agents into the templates, which would then be graded by those same templates.

*Correction:* this table previously listed the golden fixture as operator-written by hand. The fixture became Fenn's role, a model agent whose room has the render absent. See `ROLES.md`.

### Internal missions are a benchmark, not production

When you build your own template, you write the spec, you know what good looks like, and nothing drifts. No client changes their mind. Nobody says "that is not what I meant."

**Internal missions will look better than client missions.** That is a known bias, not a defect, and it is handled by recording it in `Mission.origin`. See `DATA-CONTRACTS-V2.md`.

**Never aggregate the two.** Internal missions answer whether a change to an agent helped. Client missions answer what delivery actually costs. Mixing them produces a number that means neither.

### Recording which agent version ran

An agent improved after mission two, and mission three ran better. Was it the change, an easier template, or variance? Without knowing which version ran, the improvement is unattributable.

`CompletionReport` records the exact agent content and model at dispatch, in `agent_version_sha256` and `model`. See `DATA-CONTRACTS-V2.md`.

---

## The evaluation loop

```
build template  →  record  →  change one variable  →  rebuild same template  →  compare
```

**One variable at a time.** Change the agent file and hold the template, playbook, preset, and model constant. Change two and the result cannot be attributed to either.

| Variable changed | Holds constant | Answers |
|---|---|---|
| One agent's identity file | Everything else | Did this edit help? |
| The model | Agent files, template | Did the upgrade help? |
| Grain (merge or split) | Agents, model | Were the thresholds right? |
| Composition | Agents, model, grain | Did that specialist earn its cost? |

This is mission replay from `DECISIONS-V2.md`, used as an experiment rather than a regression check. It needs no client.

### What is compared

From `CompletionReport` and the gate, per run:

- Tokens, estimated versus actual
- Gate result — first pass or rework required
- Blockers filed, and how many were provisioning gaps
- Findings — especially any matching a previously confirmed defect
- Re-reads and distinct file types touched
- Operator errors

**Only `recorded` runs enter a comparison.** A `reconstructed` run is valid for its findings and excluded from every quantitative comparison. See the evidence tiers in `DATA-CONTRACTS-V2.md`.

**One run of each variant is an anecdote.** Two per variant is the minimum before drawing a conclusion. A difference smaller than the variance between two identical runs is noise.

---

## Build order

Three templates, each built twice:

1. **Audit** — sells now, produces no code, and every run pushes a real repository through the gate
2. **Integration** — smallest and fastest, the most common small-business request
3. **Full stack, brownfield** — the shape of most real client work, and the first real exercise of convention extraction

**Greenfield full stack is deliberately absent.** It is the most satisfying to build and the least common thing clients ask for.

Six missions total. More evidence than the project has produced to date, and none of it requires a client.

---

**Update:** the first template being built is `template-booking`, on Next.js and Postgres, specified in `TEMPLATE-BOOKING.md`, with a real client waiting on it. `template-fullstack` on FastAPI and React is deferred. The three templates above remain the plan after it.

## Where templates live

**Templates are not AVEL.** They are things AVEL produces, and they live as separate repositories in the same GitHub organization. The two-repo rule in `DECISIONS-V2.md` — `avel-server` and `avel-web`, permanently — applies to the platform and is unaffected.

```
avelco/                            GitHub organization, matches avelco.dev
├── avel-server                    platform
├── avel-web                       platform
├── template-fullstack             template — FastAPI + React base
├── template-integration           template — Python webhook and sync
└── template-audit                 template — the condition report as tooling
```

Each template repository has **Template repository** enabled in its settings, which provides "Use this template" for starting a client project.

### Every template carries its own mission configuration

A template is not starter code. It is starter code plus the configuration that governs how it is built and checked.

```
template-fullstack/
├── src/                           scaffold — built by agents
├── .avel/
│   ├── template.json              name, scope, starting state — operator authors
│   ├── playbook.md                phases and gates — generated from the Playbook row
│   ├── roster-preset.json         cut, grain, composition — operator authors
│   ├── obligations.md             domain rules — operator authors
│   └── conventions/               layering, testing, naming — operator authors
├── packs/                         vertical domain packs — see below
├── fixtures/golden/               written by Fenn from the spec, never generated from output
├── .github/workflows/gate.yml     the gate, on every push
└── README.md                      scope, starting state, domain
```

`gate.yml` is committed before any agent writes code, so the first commit is already checked.

**The Playbook row is canonical** (decided 2026-10-12). The operator writes it in the Command Center, and `playbook.md` is generated from it, never edited by hand. The playbook's `mission_type` is the repository's name. `template.json` is what the Command Center reads to list templates, alongside an allowlist of template repositories. See `DECISIONS-V2.md`, *Decided 2026-10-12*.

### The first three

| Repository | Scope | Why first |
|---|---|---|
| `template-fullstack` | Full stack, booking domain | Most common client request, and FastAPI plus React is direct practice for current interviews |
| `template-audit` | Audit | Sells before any other template exists; every run pushes a real repository through the gate |
| `template-integration` | Integration | Smallest and fastest; the most common small-business request |

Booking is the first domain because it is the closest shape to CounselOS's deadline logic and adds an obligation the absence gate should catch: a slot cannot be double-booked.

### Recommended rosters

Names follow the convention in `ROSTER-V2.md`: every agent has a personal name, and an agent scoped to one part of the project also carries a territory — Atlas · scheduling. Code roles run as pipeline functions and appear in no roster.

**`template-fullstack` — vertical cut, nine model agents plus the operator**

| Phase | Agent | Covers |
|---|---|---|
| A | Axis | `foundations` |
| A | Fantem | `design-system` |
| A | Fenn | `fixture` |
| B | Atlas · scheduling | Every build role for availability and bookings |
| B | Atlas · accounts | Every build role for users and authorization |
| C | Nemi | `backend-tests`, `frontend-tests` |
| C | Raze | `property-tests` |
| D | Brennan | `spec-judgment` |
| D | Zane | `security-review` |
| D | Kodie | `concurrency` |

**Vertical, because packs add features.** Under the vertical cut each feature a pack contributes becomes one more Atlas · *feature*. Under a horizontal cut a pack would spread across every layer agent.

**Availability and bookings are one agent, deliberately.** The domain's central rule — a slot cannot be double-booked — spans both. Split across two agents, that rule would cross an agent boundary, which is where inter-agent misunderstanding happens. Keep a domain's key invariant inside a single agent's paths.

**The first template to trigger a conditional role.** Double-booking is a race condition: two requests for the same slot at the same moment. Kodie is instantiated because the project genuinely has concurrent writes, and "no slot is ever booked twice" is Raze's natural property test.

**Fenn's golden fixture is a set of scripted scenarios,** written from the specification with the application absent from his room: a seed state, a fixed clock, and 10–15 scenarios each stating requests, expected responses, and expected final state. It includes daylight-saving edge cases and the two-requests-one-slot race. The full design is in `GOLDEN-FIXTURE.md`, section *Golden fixtures for templates*.

**Tests go in their own directories.** As a greenfield layout, every boundary becomes a directory, so every boundary is a mount and the exit checkpoint is never needed. See `SANDBOX.md`.

**`template-audit` — no builders; mostly code**

| Kind | Roles |
|---|---|
| Code, run against the target repository | coverage, mutation, permission matrix, absence checks, `adversarial`, `accessibility`, `performance`, dependency provenance |
| Zane | `security-review`, and `compliance-review` when the client is regulated |
| Fenn | `fixture` — the expected findings for a known public repository |
| Uno | The report — **pending: no role in the catalog produces it yet** |

**The riskiest template to sandbox.** Mutation testing runs the client's test suite repeatedly with the client's dependencies. Nearly all of the work happens in the running room.

**It exposed a gap.** The audit's deliverable is a written condition report, and no role produces one — it is not code, a test, or a finding. The catalog was designed around build missions. When added, the report is a `model` role with a hard rule enforced by code: **every claim must cite a finding that exists, and no finding's severity may be raised.** Uno is the natural owner, since a condition report is client communication.

**`template-integration` — the minimum viable roster: four model agents plus the operator**

| Agent | Covers |
|---|---|
| Axis | `foundations` |
| Atlas · sync | `contract`, `domain`, `integration`, `api-surface`, `auth` |
| Iyo | `backend-tests`, `property-tests` |
| Zane | `spec-judgment`, `security-review` |
| Fenn | `fixture` |

**Atlas · sync** — the full-slice builder, owning the whole integration through every layer. **Every row stays on one side** — author, tester, or judge — per the merge rule in `ROSTER-V2.md`. **Iyo and Zane are named for their heaviest role:** the testing is backend, and the review is mostly verifying webhook signatures.

Three code roles earn their place here specifically. The fuzzer, because a webhook endpoint accepts untrusted input from the internet by design. Reconciliation, because a sync service's whole job is data arriving intact. And a property test for idempotency — the same event delivered twice must produce the same result as once, and webhooks are delivered twice.

### What the three cover

| Template | Model agents | Exercises |
|---|---|---|
| fullstack | 9 | The vertical cut end to end, and the first conditional role |
| audit | 2, plus the pending report role | Code roles and the running room |
| integration | 4 | The smallest roster the rules allow |

**None of them uses the horizontal cut.** That is acceptable. It stays untested until a layer-organized client project arrives; forcing it onto a template would generate misleading data about a shape no real project asked for.

---

## Vertical templates

### A vertical is a base plus a pack, never a fork

The tempting structure is one repository per niche — `template-title`, `template-legal`, `template-accounting` — each a copy of the full-stack base with domain code added. That produces forks, and every fix to the base must then be applied to every fork. One gets missed and they drift, which is the failure this project exists to prevent, happening to its own templates.

The structure that does not drift:

```
template-fullstack         one base, one place to fix a defect
    + a domain pack        the vertical, plugged in
```

**This is consistent with the rule that domain is a parameter rather than a template.** For verticals the parameter is rich — entities, rules, compliance, vocabulary — so it is packaged. It is still a parameter.

### The shared core

Title, legal, accounting, and construction are all deadline-driven: dates that cascade from other dates, computed against business-day rules, where a miss is a claim rather than an inconvenience.

The deadline engine built for CounselOS is extracted as a shared core beneath every deadline-driven pack. One engine, tested once, reused across niches. It remains deterministic code — date arithmetic is pattern matching, not reasoning, and a wrong answer here is a malpractice claim.

### What a pack contains

```
packs/title/
├── entities.md          schema additions — closings, parties, commitments
├── deadlines.md         domain rules, fed to the shared deadline engine
├── obligations.md       absence-gate additions for this domain
├── compliance.md        gates that refuse — the regulator-facing rules
├── glossary.md          domain vocabulary
└── fixture/             seed data for the golden fixture
```

**The glossary is not optional.** An agent that calls a title commitment "a document" produces working code nobody in the industry recognises. Domain vocabulary is part of the deliverable, and it is the cheapest part to get right.

### The packs

| Pack | Carries | Status |
|---|---|---|
| **Legal** | Matters, clients, conflict checks, jurisdiction deadlines, professional-conduct rules as gates | Exists inside CounselOS. **Extract, do not build.** |
| **Title** | Closings, parties, title commitments, cure deadlines | Next. Reuses nearly all of the legal pack's deadline logic. |
| **Accounting** | Clients, engagements, filing deadlines against the tax calendar, document requests | Build on first client request |
| **Construction and trades** | Projects, change orders, RFIs, lien deadlines | Build on first client request |
| **Health practices** | Patients, appointments, intake, access control, audit logging | Build on first client request. Different compliance regime from the others. |

### Build order

1. **Extract the legal pack from CounselOS.** The domain research is already done; this is packaging, not building.
2. **Extract the deadline engine as shared core** in the same pass.
3. **Title pack.** Reuses almost everything and is the largest market on the list. Title companies and real estate attorneys work the same closings and refer to each other.

The remaining packs wait for a client. Building five ahead of demand is the same error as building a dashboard over no data.

---

## Open questions

| Question | Blocking |
|---|---|
| Where does the audit template get repositories to audit before any client? | Before audit runs. Public repositories are the obvious answer. |
| Does an internal template build need its own brief, or does the template spec serve as one? | Before the first template dispatches |
| Which template order holds? *Build order* names audit, integration, then brownfield full stack, and leaves out greenfield full stack. The update after it builds `template-booking` first, which is greenfield full stack. *The first three* puts `template-fullstack` first, which `TEMPLATE-BOOKING.md` defers. The repository tree has no `template-booking`. | **Resolved 2026-10-05:** `template-booking` first (`TEMPLATE-BOOKING.md`); the rest per this document. |
| How many runs before an agent change is considered proven? | After the first two runs show real variance |
| Does a pack live inside `template-fullstack`, or in its own repository once there are several? | After the third pack exists. Inside the base until then. |
| Is the shared deadline engine a pack dependency or part of the base? | Before extracting it from CounselOS |
| **Decided:** add a `report` role — `model`, owned by Uno, kept separate from Zane. Code enforces that every claim cites an existing finding and no severity is raised. Lands in `ROLES.md` when `template-audit` begins. | Before `template-audit` runs |
