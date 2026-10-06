# Start Here

Which documents your task actually needs. Read this, load two or three, and stop. Loading all of `docs/` wastes context and buries the two that matter.

**Always read `CLAUDE.md` first.** It is short and it is the rules.

---

## By task

| Doing this | Read |
|---|---|
| **Joining the project** | `STUDY-GUIDE.md` → `WHY-AVEL-EXISTS.md` |
| **Building the frontend (avel-web)** | `BUILDING-AVEL-WEB.md` → `ROUTES.md` → `DATA-CONTRACTS-V2.md` |
| **Dispatching parallel sessions** | `DAY-ONE-DISPATCH.md` |
| **The export engine** | `EXPORT-ENGINE.md` → `BLAST-RADIUS.md` |
| **shadcn components** | `SHADCN-PRINCIPLES.md` |
| **Setting up the project** | `STACK-AND-RESOURCES.md` → `TECH-STACK.md` |
| **The render or export engine** | `GOLDEN-FIXTURE.md` → `BLAST-RADIUS.md` → `DATA-CONTRACTS-V2.md` |
| **Schema or migrations** | `DATA-CONTRACTS-V2.md` → `DECISIONS-V2.md` |
| **What a role does** | `ROLES.md` |
| **Skills — what agents know and may use** | `SKILLS.md` |
| **Agents, mounts, or dispatch** | `ROLES.md` → `ROSTER-V2.md` → `SANDBOX.md` |
| **Where agents execute** | `SANDBOX.md` |
| **Design or UI** | `patches/globals-patch.css` → `DESIGN-PLUGINS.md` |
| **The Command Center — what each module does** | `COMMAND-CENTER.md` → `STATE.md` |
| **The booking template or decal client** | `TEMPLATE-BOOKING.md` → `TEMPLATES.md` |
| **Templates and agent evaluation** | `TEMPLATES.md` → `ROSTER-V2.md` |
| **Running a mission** | `MISSION-001-COUNSELOS-SLICE-0.md` → `SURPRISES.md` → `COST-LOG.md` |
| **Anything about CounselOS** | `COUNSELOS-STATE.md` |
| **Proposing a change** | `DECISIONS-V2.md` first, always |
| **Wondering if a tool already exists** | `PRIOR-ART.md` |

---

## By question

**"What is AVEL?"** → `PRODUCT.md`

**"Why does it work this way?"** → `DECISIONS-V2.md`

**"What state is it actually in?"** → `STATE.md`. Nothing else states status.

**"What shape is this entity?"** → `DATA-CONTRACTS-V2.md`

**"Which agent owns this file?"** → `ROSTER-V2.md`, mount table

**"Has someone already built this?"** → `PRIOR-ART.md`

**"How do I not break things?"** → `DEV-TIPS.md`

---

## The full set

### Core — the system
| File | Owns |
|---|---|
| `PRODUCT.md` | The external pitch |
| `STATE.md` | **All** build status, counts, gaps |
| `DECISIONS-V2.md` | Rationale, trades, rejected ideas |
| `DATA-CONTRACTS-V2.md` | Entity shapes, contract structure |
| `TECH-STACK.md` | The tool list |
| `DOC-OWNERSHIP.md` | Which doc owns which fact |
| `COMMAND-CENTER.md` | The fifteen modules, what each does and why |

### Agents and execution
| File | Owns |
|---|---|
| `ROLES.md` | The role catalog: every job, its runtime, its five fields |
| `ROSTER-V2.md` | Roster shape, cuts, mounts, edges |
| `SKILLS.md` | How skills work: layers, types, trust, measurement |
| `SANDBOX.md` | Where agents run, isolation tiers, credential boundary |

### The gate
| File | Owns |
|---|---|
| `BLAST-RADIUS.md` | The pre-delivery preview |
| `CLIENT-CONTRACT-CONFORMANCE.md` | The unbuilt half of the alignment gate |
| `GOLDEN-FIXTURE.md` | The package the renderer must reproduce |
| `EXPORT-ENGINE.md` | Teaching narrative for the export engine. Not a source of truth |

### Building
| File | Owns |
|---|---|
| `BUILDING-AVEL-WEB.md` | How avel-web is built |
| `DAY-ONE-FRONTEND.md` | Tomorrow's checklist |
| `DAY-ONE-DISPATCH.md` | The three-session dispatch plan for day one |
| `SHADCN-PRINCIPLES.md` | How shadcn/ui components are used and restyled |
| `STACK-AND-RESOURCES.md` | What to install and when |
| `ROUTES.md` | The frontend route tree |
| `DEV-TIPS.md` | Build practice |

### Learning and evidence
| File | Owns |
|---|---|
| `STUDY-GUIDE.md` | Onboarding curriculum |
| `WHY-AVEL-EXISTS.md` | The market research behind the thesis |
| `PRIOR-ART.md` | Existing tools, what to adopt vs build |

### Templates
| File | Owns |
|---|---|
| `TEMPLATES.md` | Template catalog, how templates are built, the agent evaluation loop |
| `TEMPLATE-BOOKING.md` | The booking template and its first client |

### Missions
| File | Owns |
|---|---|
| `MISSION-001-COUNSELOS-SLICE-0.md` | Mission capture template |
| `SURPRISES.md` | Unpredicted agent behaviour, one line each |
| `COUNSELOS-STATE.md` | CounselOS current state |
| `COST-LOG.md` | Tokens and spend, per agent, per mission |

### Design
| File | Owns |
|---|---|
| `patches/globals-patch.css` | Token patch — radius, elevation, states, z-scale, gates |
| `DESIGN-PLUGINS.md` | Using design plugins without breaking mounts |
| `LOGO-BRIEF.md` | Logo and motion direction |

### Tooling
| File | Owns |
|---|---|
| `scripts/check-docs.sh` | Mechanical doc consistency check |

---

## Two rules about reading

**Load two or three, not all of `docs/`.** Every doc you load is context you are not spending on the work.

**If a doc contradicts the code, the code wins** — and that is a finding. Write it down before you fix anything. See `CLAUDE.md` rule 3.
