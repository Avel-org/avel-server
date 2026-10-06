# Roles

Status: `[specced]`. Build status lives in `STATE.md`.

The catalog of jobs an AVEL mission can require. **A role is a job. An agent is an instance that covers one or more jobs.** Roles are fixed. Agents are assigned per project.

Related: `ROSTER-V2.md` defines how roles are assigned to agents under each cut, and the mount and edge rules. `DATA-CONTRACTS-V2.md` defines the `role` vocabulary on `AgentTemplate`.

---

## Why roles are separate from agents

The original roster treated a role and an agent as the same thing. Leonora *was* the schema role. Nemi *was* frontend testing.

That produced four failures, all logged in `ROSTER-V2.md`:

- Cutting an agent deleted its duties with it — four were orphaned (F7)
- The composition table could name specialists that had no definition (F6)
- The horizontal roster looked like dead weight, because it was a fixed cast rather than an assignment (F12)
- The writable-paths rule was asked to decide both role boundaries and agent boundaries, and could only see one of them (F8)

Separating the two resolves all four. The catalog below is the fixed thing. The cut, grain, and composition decide which agents cover which roles.

---

## The two rules

**Roles split by artifact.** Each role produces exactly one kind of output. A role producing two unrelated kinds is two roles.

**Agents group by path.** Roles whose outputs share a directory can be covered by a single agent.

These do different jobs and do not conflict. Frontend tests and the accessibility audit are two roles because they produce different artifacts, and can be one agent because they share a mount. The writable-paths rule was never wrong. It decides agent boundaries, and was being asked to decide role boundaries too.

---

## The runtime test

**Does this require reasoning, or is it pattern matching and measurement?**

| Runtime | When | Cost |
|---|---|---|
| `model` | Deciding what to build, or whether it is right | Tokens |
| `code` | Measuring, matching, or executing something deterministic | None |
| `human` | Provisioning shared surface; approving what a model proposed | Operator time |

**Only `model` roles are covered by agents.** A `code` role is a function in the pipeline, not an agent, and never appears on a roster. The one `human` role, `foundations`, is covered by the operator's `RosterEntry`.

**Where a tool can measure something, the tool runs first and the model interprets its output.** A model never guesses at what a function could have measured.

---

## The catalog

Every role carries five fields plus its runtime.

| Field | Question |
|---|---|
| **Owns** | Which paths may it write? |
| **Produces** | What single kind of artifact does it output? |
| **Consumes** | Which artifacts does it read? Each read is recorded by hash. |
| **Checked by** | What verifies its output? |
| **Measured by** | How is it known to have done well? |

---

### Foundation — runs first, provisions shared surface

**Owns:** composition root, shared packages, schema and contract directories, token and primitive directories, `fixtures/golden/` — **excluding `*.spec.ts`, `*.test.ts`, and `tests/**`**. The `fixture` role's mount additionally excludes all render source and all render output.
**Checked by:** every consumer records the SHA-256 of what it read; a mismatch against what was written is a finding. Downstream blockers that turn out to be provisioning gaps count against this family.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `foundations` | human | Composition root, shared package, provisioned directories | Client repository, extracted conventions | Downstream blockers that were provisioning gaps |
| `schema` | model | Migrations | Brief, conventions | Migrations needing a follow-up fix |
| `contract` | model | The API contract artifact | Brief, schema | Consumer hash mismatches |
| `design-system` | model | Tokens, primitives | Brief, brand tokens | Hardcoded values found in components |
| `fixture` | model | The golden fixture | The render specification only | Fixture updates later found to have hidden a regression — target zero |

`foundations` absorbs the integration pass that Zero and Atlas held. It was always the work of assembling modules into a composition root — foundations work, never a separate script.

`schema` and `contract` were one agent. They produce different artifacts — a migration and an OpenAPI document — so they are two roles. One agent may still cover both.

**`fixture` closes F11.** The golden fixture was hand-written once, correctly, and then had no owner. As the render evolves, a stale fixture turns every determinism test into a comparison against an outdated baseline. It is a distinct artifact, so by the catalog's own rule it is a distinct role — and the one-artifact rule exists precisely so a duty like this cannot sit unowned.

**The fixture's value is independence, and independence comes from the mount, not from being human.** The role reads the render specification and writes `fixtures/golden/`. It can never see render source or render output. On the first day of the frontend build, a model session wrote the golden fixture this way and caught a defect in the specification before writing a byte — evidence that a model can hold this role well.

An earlier draft made this role `human`. That handed another role to the operator, who is by measured evidence the most error-prone agent in the system, to protect a property the mount already guarantees.

### The rule that removes the judgment call

> **The fixture updates only in response to a specification change. Never in response to a render change.**

When the golden test fails, what happens next is mechanical:

| Golden test fails, and… | Then |
|---|---|
| The specification did **not** change | It is a regression. Fix the render. Nothing to decide. |
| The specification **did** change | The `fixture` role rewrites the fixture from the new specification, without seeing the render. |

**The fixture is never regenerated from render output.** Doing so would make the golden test compare the renderer against itself, which passes forever and proves nothing.

The rule has a deliberate consequence: an intended change in render behaviour must be declared in the specification *before* the render is allowed to produce it. An undocumented behaviour change can no longer be blessed by editing a test. The judgment "was this intended?" disappears, because intent is now something recorded rather than something recalled.

A fixture update later found to have hidden a regression is the failure this role is measured on.

---

### Build — writes source, never its own tests

**Owns:** feature or layer source paths, **with `*.spec.ts`, `*.test.ts`, and `tests/**` excluded.**
**Checked by:** the verify and review families, then the gate.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `domain` | model | Services, business rules | Contract, schema | First-pass gate rate |
| `api-surface` | model | Route handlers, DTOs | Contract, domain signatures | First-pass gate rate |
| `integration` | model | External connectors, webhook handlers | Contract, third-party API specifications | Failed deliveries to third parties |
| `realtime` | model | WebSocket and SSE handlers | Contract | Ordering and reconnection defects |
| `auth` | model | Guards, authorization logic | Contract, schema, permission policy | Undefined cells in the permission matrix |
| `state` | model | Frontend state, data fetching | Contract | Stale-data defects |
| `interface` | model | Components, screens, charts | State types, design-system primitives | First-pass gate rate |

**Nothing that writes source writes the tests that grade it.** Every mount that writes source excludes test files — in this family and in Foundation, which also writes source. Mission 002's feature agent wrote both its code and its unit spec because the mount allowed it. This closes that.

An earlier version stated this for builders only. Foundation roles write migrations, contracts, tokens, and primitives, and their mounts carried no exclusion. The principle is about source, not about which family a role belongs to.

The original API agent carried three disciplines. REST handlers, external integrations, and real-time connections produce different artifacts and fail in different ways, so they are three roles. A small project may still assign all three to one agent.

---

### Verify — writes tests, never source

**Owns:** test directories and test files only. No source path, ever.
**Checked by:** for `model` roles, the mutation score of the tests they produce. For `code` roles, the tool's configuration is itself golden-tested.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `backend-tests` | model | Backend test suites | Contract, acceptance criteria | Mutation score of the tests it wrote |
| `frontend-tests` | model | Browser and component tests | Acceptance criteria, interface | Mutation score of the tests it wrote |
| `property-tests` | model | Property-based test suites | Contract, invariants from the spec | Defects found that example-based tests missed |
| `accessibility` | code | Accessibility scan results | The built interface | Violations caught before delivery |
| `performance` | code | Performance budget measurements | The built interface, the budget | Regressions caught before delivery |

**Every test declares the acceptance criterion it covers.** That convention is what makes `spec-check` a set difference rather than a judgment call.

`property-tests` moved here from the adversarial role. Property testing requires stating invariants, and invariants come from the spec, so it was never spec-blind work.

---

### Review — writes findings, never source or tests

**Owns:** `findings/<role>/` only.
**Checked by:** for `model` roles, the true-positive rate over time — whether findings were confirmed real. For `code` roles, determinism.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `spec-check` | code | Criteria without a covering test | Acceptance criteria, test criterion tags | Uncovered criteria caught |
| `spec-judgment` | model | Findings on whether the implementation meets the intent | Brief, implementation, `spec-check` output | Findings confirmed real |
| `security-review` | model | Security findings | Security surface document, static analysis output, permission policy | Findings confirmed real |
| `compliance-review` | model | Regulatory findings | The domain's compliance rules | Findings confirmed real |
| `adversarial` | code | Crashes and failures under malformed input | Running endpoints | Defects nothing else caught |
| `reconciliation` | code | Data-integrity findings after migration | Source and target data | Discrepancies caught |
| `concurrency` | model | Race and ordering findings | Load-test and race-detection output | Defects confirmed under load |

**`spec-judgment` is the only defense against wrong code that agrees with its own wrong test.** Mutation testing catches tests that assert nothing. It cannot catch a test that asserts the wrong thing, because a model that misread a requirement writes code and test that agree with each other. Only independent judgment against the brief finds that.

**Run `spec-check` first and `spec-judgment` only on what it flags.** The cheap, exact role narrows the work for the expensive one.

**`adversarial` is a fuzzer, not a model.** The original adversarial agent was valued for breaking things without reading the spec. A language model given no spec produces the training-data average of an edge case — null, empty string, negative numbers — and will not find the unusual one. A fuzzer generates thousands of malformed inputs with no such bias. The spec-blind posture survives with a better implementation.

**`reconciliation` never needed a model.** Whether migrated data arrived complete and unaltered is row counts, checksums, and field-by-field comparison.

`security-review` and `concurrency` are model roles that lean on tools. Static analysis and dependency scanning run first for security; load tests and race detection run first for concurrency. The model interprets what the tools found and reasons about what they cannot see.

---

### Operate — after the ship decision

**Owns:** deployment configuration, instrumentation, runbooks.
**Checked by:** rollback drills that actually execute, and post-mortems.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `deploy` | code | A deployment | The shipped package | Failed deploys |
| `recovery` | code | A rollback | Deployment configuration | Rollback success, time to recover |
| `observability` | code | Logs, metrics, alerts | The running system | Incidents detected before a user reported them |
| `incident-response` | model | Incident reports, post-mortems | Observability signals | Repeat incidents |

This family is new. Deploy and rollback were previously placed in the review phase, where they produced findings for a ship decision they had no part in. They are neither review nor build — they happen after the ship decision.

It also recovers two duties that were dropped when their agents were removed: observability, and incident response.

---

### Firm — between missions

**Owns:** `Intake`, engagement records, research notes.
**Checked by:** `intake` is checked mechanically before the operator sees it — every requirement maps to an acceptance criterion, and `open_questions` is empty or explicitly acknowledged. The operator approves after that check, never instead of it.

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `intake` | model | The brief, open questions | Raw client input | Requirements changed after approval |
| `strategy` | model | Scope and approach recommendations | Brief, engagement history | Engagements needing rescope |
| `research` | model | Domain and technical research | A question from intake or strategy | Not yet measured — unbuilt |
| `client-ops` | model | Client communication, status | Engagement state | Not yet measured — unbuilt |

`intake` sits at the point where bad specification enters the system, which is among the largest causes of multi-agent failure. It was previously checked only by operator approval. By measured evidence the operator is the most error-prone agent in the system, so the highest-leverage output now passes a mechanical check first.

---

### Platform — permanently code

| Role | Runtime | Produces | Consumes | Measured by |
|---|---|---|---|---|
| `knowledge` | code | The knowledge authority | Findings, mission records | Registry entries later retired as no longer true |
| `render` | code | The deterministic package | Mission, roster, playbook | Preview-versus-delivery hash mismatches — target zero |
| `ship-decision` | code | Pass or block | Typed findings | Passes later found to have shipped a defect; blocks later found unwarranted |

A function can still be wrong — in its rules, not its execution. `render` is measured on determinism violations, which are caught for free every time a preview and its delivery are compared. `ship-decision` is measured on outcomes: a pass that shipped a defect means a finding type is missing from the rules; a block that was unwarranted means one is too strict. Neither is a model's judgment. Both are evidence that the arithmetic needs changing.

An earlier version of this catalog claimed every role carried five fields while these three carried four.

Replacing a provably correct function with a probably correct one is not an upgrade, and the ship decision is the last place to make that trade.

Billing was removed. Cost per dispatch is recorded on `CompletionReport` as `actual_tokens`, which needs no role.

---

## Counts

| Family | Total | model | code | human |
|---|---|---|---|---|
| Foundation | 5 | 4 | 0 | 1 |
| Build | 7 | 7 | 0 | 0 |
| Verify | 5 | 3 | 2 | 0 |
| Review | 7 | 4 | 3 | 0 |
| Operate | 4 | 1 | 3 | 0 |
| Firm | 4 | 4 | 0 | 0 |
| Platform | 3 | 0 | 3 | 0 |
| **Total** | **35** | **23** | **11** | **1** |

**Eleven roles cost no tokens.** Token spend is the largest unmeasured financial risk in the system, and a third of the catalog is now outside it. A function also cannot talk itself into a passing result, so the self-grading surface shrinks with it.

---

## Where the original agents went

Nothing was lost. Every original duty maps to at least one role.

| Original agent | Roles |
|---|---|
| Axis, Zero, Atlas | `foundations` |
| *(new)* | `fixture` — previously unowned, F11 |
| Leonora | `schema`, `contract` |
| Fantem | `design-system` |
| Kel | `domain` |
| Dunn | `api-surface`, `integration`, `realtime` |
| Gat | `auth` |
| Ghost | `state` |
| Leon | `interface` |
| Kodie | `performance`, and charts within `interface` |
| Iyo | `backend-tests` |
| Nemi | `frontend-tests`, `accessibility` |
| Brennan | `spec-check`, `spec-judgment` |
| Zane | `security-review`, `compliance-review` |
| Raze | `property-tests`, `adversarial` |
| Fenn | `deploy`, `recovery` |
| Neil | `observability` |
| Grim | `ship-decision`, `incident-response` |
| Canon | `intake`, `strategy` |
| Trace | `research` |
| Uno | `client-ops` |
| Blair | `knowledge` |
| Plye | `render` |
| Della | Removed — cost is a field, not a role |

---

## Improving roles

**An agent never rewrites its own instructions based on its own performance.** That is the self-grading failure one level up, and worse: a flaw in judgment gets written into the definition and then graded by that same judgment. It is the same reason knowledge write-back never auto-promotes.

Roles improve through three loops, none of which let an agent modify itself:

1. **Findings become checks.** A confirmed defect enters the registry and every future mission is checked against it. Deterministic, and already specced.
2. **Every role is measured.** The *Measured by* column above. Each measure comes from data the gate and `CompletionReport` already produce.
3. **The operator changes a role definition, one variable at a time,** versioned by hash, then re-runs the same template to see whether it helped. See `TEMPLATES.md`.

The agent improves because the system around it learns, never because it decided it should.

---

## Identity files become generated

An agent's identity file is assembled from the roles it covers, the role skills attached to those roles, its mount, and its edges. It is no longer hand-written. Stack and domain skills are not part of it — they arrive with each dispatch. See `SKILLS.md`.

That resolves F3 permanently: an identity file generated from this catalog cannot fall out of date with it. When a role changes here, every agent covering that role changes with it on the next generation.

---

## Open questions

| Question | Blocking |
|---|---|
| How are acceptance criteria given IDs, and how does a test declare the criterion it covers? | Yes — `spec-check` cannot run without it |
| Which fuzzer, per stack? | **TypeScript resolved 2026-10-05:** fast-check. Each other stack chooses when it arrives. |
| Does `research` run inside intake, or as its own dispatch? | Before `research` is built |
| What are the **Owns** and **Checked by** fields for the Platform family? Every other family states both. | Deferred to module 4 (2026-10-05) |
