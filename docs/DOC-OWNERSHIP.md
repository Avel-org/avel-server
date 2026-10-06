# Doc Ownership

*One fact, one owner. A fact restated in two documents will drift — this has happened three times on this project, twice within a single writing pass.*

*This replaces `DOC-RECONCILIATION.md`. That document asked an agent to be diligent; `scripts/check-docs.sh` checks instead.*

---

## The map

| Document | Owns | Must never contain |
|---|---|---|
| `PRODUCT.md` | The external pitch, the problem statement, the bet | Schema · stack names · build status · counts |
| `DECISIONS-V2.md` | Rationale, trades, rejected ideas, open questions | Schema blocks · stack tables · status |
| `DATA-CONTRACTS-V2.md` | Entity shapes, contract structure, invariants, migration order | "Why we changed" prose · status |
| `STACK-AND-RESOURCES.md` | Provisioning: what to install, what to sign up for, and when | Decisions · shapes · status |
| `TECH-STACK.md` | The tool table, one line each, operational notes | Re-argued rationale · schema · status |
| `STATE.md` | **All** build status, counts, gaps | Anything else |
| `CLIENT-CONTRACT-CONFORMANCE.md` | The client-side gate problem and its open decisions | Implementation before D1–D5 are answered |
| `BLAST-RADIUS.md` | The pre-delivery preview: remote tree read, diff, dry-run path, pre-flight screen | Verification gate logic · status counts |
| `ROUTES.md` | The frontend route tree, per-route device class, per-screen contract needs | Component internals · shapes · status |
| `COUNSELOS-STATE.md` | CounselOS current state, Slice 0 blockers, stack-specific mount globs | AVEL platform decisions |
| `STUDY-GUIDE.md` | Onboarding curriculum for developers joining the project | Decisions · shapes · status |
| `avel-gates-diagram.html` *(not in this repo; in the operator's frontend bundle, `design/`)* | The visual: phase flow, gate stages, interactive gate panel, cut comparison | — |
| `GOLDEN-FIXTURE.md` | The hand-written package the renderer must reproduce; the render specification | Schema shapes · status |
| `SKILLS.md` | How skills work: layers, types, trust, measurement | Entity shapes · status |
| `COMMAND-CENTER.md` | The Command Center's fifteen modules, what each does and why, and how to explain it | Build status · entity shapes |
| `TEMPLATE-BOOKING.md` | The booking template and its first client: scope, stack, requirements, routes, data model, roster | Template mechanics · role definitions |
| `TEMPLATES.md` | Template catalog, how templates are built, the agent evaluation loop | Shapes · status |
| `ROLES.md` | The role catalog: every job, its runtime, and its five fields | Agent assignment · mounts · status |
| `ROSTER-V2.md` | How roles are assigned to agents: cuts, mounts, edges, known flaws | Execution environment · status |
| `SANDBOX.md` | Where agents execute, isolation tiers, credential and egress boundaries | Roster composition · shapes |
| `PRIOR-ART.md` | Existing tools in this space, what to adopt vs. rebuild, the build/wrap decision | Shapes · status |
| `DEV-TIPS.md` | Build practice | Status · shapes · rationale |
| `EXPORT-ENGINE.md` | Teaching narrative for the export engine. It restates other owners on purpose and is never a source of truth | — |
| `DAY-ONE-DISPATCH.md` | The three-session dispatch plan for day one: sequencing and disjoint mounts | Shapes · status |
| `COST-LOG.md` | Tokens and spend, per agent, per mission. Append-only | Rationale · status |
| `SURPRISES.md` | Unpredicted agent behaviour, one line each | Rationale · status |
| `WHY-AVEL-EXISTS.md` | The market research behind the thesis | Shapes · status |
| `DESIGN-PLUGINS.md` | Using design plugins without breaking mounts | Shapes · status |
| `LOGO-BRIEF.md` | Logo and motion direction | Shapes · status |
| `DOC-OWNERSHIP.md` | Which doc owns which fact, the epistemic markers, the stale-term denylist | Status |

**Cross-reference instead of restating.** "Zero missions have run" belongs in `STATE.md` and nowhere else; every other document links.

---

## Epistemic markers

Every claim carries its status inline. A reader — including a fresh session — must be able to tell a shipped mechanism from a reasoned intention, because these documents are written in one confident register and the register is not evidence.

| Marker | Means |
|---|---|
| `[built]` | Code exists, runs, is tested |
| `[specced]` | Designed in detail, not implemented |
| `[hypothesis]` | Believed, unmeasured — including every claim about agent-design efficacy |
| `[attestation]` | Enforced by an agent's report, not a mechanism |
| `[unspecified]` | Named as needed, shape unknown |

`[attestation]` exists because that is the project's recurring failure mode. Anything carrying it is a gap, not a feature.

---

## Stale-term denylist

These strings must not appear in `docs/` outside a "Stale markers:" line, a line marked `<!--allow-stale-->`, or this file. `scripts/check-docs.sh` enforces it.

```
tRPC                        → ts-rest
Supabase                    → Neon
bytea                       → R2 / snapshot_key
skippable                   → mandatory | warn + gate_override
ADR-010 to ADR-019          → the decision is in DECISIONS-V2
10, 11 or 13 entities       → see STATE.md
25 AI agents                → see STATE.md
19 build agents             → see STATE.md
Capability (as an entity)   → Skill.type = 'capability'
```

*Restored 2026-10-05:* the Capability row was suspended while the question was open and returned when it was decided. A check must not enforce a reopened decision (`CLAUDE.md` rule 6).

---

## Rules

- **Report before fixing** still applies to *semantic* drift — where two docs disagree and canonical is silent, that is a question, not a judgment call.
- **Canonical wins** on entities, ADR numbers, and field shapes. Never "fix" canonical to match a repo doc.
- **Distinguish doc gaps from build gaps.** "RepoPolicy isn't in the shapes doc" is a doc gap. "RepoPolicy has no table" is a build gap and belongs in `STATE.md`.
- **Don't consolidate on your own initiative** — recommend it and explain.
- **The script is not sufficient.** It catches stale strings and duplicated status. It cannot catch two documents that describe the same mechanism differently in fresh words. That still needs reading.
