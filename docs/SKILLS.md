# Skills

Status: `[specced]`. Build status lives in `STATE.md`.

What an agent knows and what tools it may use, where each comes from, and how it is kept honest. Shapes are in `DATA-CONTRACTS-V2.md`; this document explains them.

Related: `ROLES.md` for the roles skills attach to, `SANDBOX.md` for the rooms capabilities live inside, `COMMAND-CENTER.md` modules 5 and 6.

---

## What changed, and why

The original skill design predates the role catalog. It had five problems:

1. **Skills attached to agents, not roles.** "Property testing with fast-check" belongs to the `property-tests` role. When roles moved between agents through a merge or a split, skills attached to an agent were left behind — the orphaned-duties failure again, one level down.
2. **They would have broken the version hash.** A Next.js skill applies only to Next.js projects. Placed in an identity file, it would make every project look like a new agent version, and comparing agent versions would stop meaning anything.
3. **Capabilities enforced nothing.** The schema said so plainly: a capability "declares a tool grant; it does not enforce one," because no runtime could restrict a tool. The sandbox rooms are that runtime.
4. **A field the docs depended on did not exist.** The cost-saving routing rule says a skill's declared inputs and outputs decide whether a step is tool-heavy. The Skill entity had no such field.
5. **`recommended_for` used team tags.** Teams no longer exist; roles replaced them.

---

## Three layers

| Layer | Examples | Attaches to | Delivered in | Recorded by |
|---|---|---|---|---|
| **Role** | Property testing with fast-check; spotting code and tests that agree and are both wrong; tagging every test with its acceptance criterion | A role | The agent's identity file | `agent_version_sha256` |
| **Stack** | Next.js route groups and route handlers; Drizzle schemas and generated migrations; Better Auth with an allow-list; Luxon and daylight saving | A template or a mission | The dispatch brief | `skills_sha256` |
| **Domain** | Booking vocabulary; timed versus day-based services; a legal pack's deadline rules | A pack or a client | The dispatch brief | `skills_sha256` |

**Role skills are part of who the agent is.** They change only when a role definition changes, and they are hashed with the identity.

**Stack and domain skills are part of what a mission needs.** They are given at dispatch, and their combined hash is recorded on the `CompletionReport` as `skills_sha256`.

Two runs with the same `agent_version_sha256` and the same `skills_sha256` ran the same agent with the same knowledge. That is what keeps results comparable when stack skills differ from project to project.

**At dispatch, an agent receives the mission's stack and domain skills whose `recommended_for` includes one of its roles** — not every skill attached to the mission. A tester does not need the migration skill.

---

## Two types

| Type | What it is | Enforced by |
|---|---|---|
| **Knowledge** | Text the agent reads | Nothing needs enforcing — it is advice |
| **Capability** | A tool the runner provides inside the agent's room | The room. A tool that is not granted is not present. |

A capability lists the tools it grants — a headless browser, read access to the database, the package registry. The runner provides those tools in the room and nothing else.

**A capability can never exceed its room.** A judge's room cannot be granted write access to source, and no room except delivery can be granted the credential. A code check rejects any capability attached to a role whose room cannot hold it — the same pattern as the merge rule's check on sides.

**Capabilities declare their shape.** Each says whether it reads a large or small input and returns a large or small result. A capability that reads large and returns small is tool-heavy, and the runner routes it to a programmatic-tool-calling runner where one is available. That classification comes from the declaration, never from a judgment made per call.

---

## Load only what's needed

Every skill an agent reads costs tokens on every dispatch. So each skill has two parts:

- **A description** — one or two sentences, always visible to the agent
- **The full content** — loaded only when the task calls for it

The agent sees every relevant skill's name and description, and reads a full skill only when its work needs it. This is the same pattern the environment these documents were written in uses for its own skills: a list of short descriptions, with a full skill file read only when a task requires it.

**A description is a contract.** If it is vague, the agent will either never load the skill or load it for everything. Write it as *when to use this*, not *what this is about*.

---

## Trust

**Agents never write or edit skills.** The same reason they never edit their own instructions: a flaw in judgment would be written into the guidance, then followed by that same judgment.

**A skill is a draft until reviewed.** Only `approved` skills can be attached. Approval records who reviewed it and when.

**Imported skills are treated like dependencies.** A skill is instructions an agent will follow, so one copied from a third party is a path for careless or malicious instructions into every mission that uses it. Review it, pin it by `content_sha256`, and only then approve it. AVEL's own additions to an imported skill live in `avel_enhancement_md`, separate from the original, so the original stays exactly what was reviewed.

**A skill is advice; a check is a rule.** When a lesson *can* be enforced by a check, it becomes a check. Skills are for what checks cannot cover — judgment, conventions, vocabulary.

| Lesson | Belongs in |
|---|---|
| "Middleware alone is not enough to protect admin routes" | The `security-review` role skill — it is judgment about where to look |
| "Every admin route handler calls `requireOwner`" | A check that fails the build |
| "A booking app's skipped daylight-saving hour must never be offered" | A golden scenario and a property test |
| "Here is what a title commitment is" | A domain skill — vocabulary cannot be checked |

---

## Skills earn their place

A skill that does not change outcomes is costing tokens on every dispatch for nothing.

**Test it like any other change:** run the same template with and without the skill, holding the identity, model, and everything else fixed. Because the skill changes `skills_sha256` and nothing else, any difference is attributable to it. Compare first-pass gate rate, rework, blockers, and tokens — including the tokens the skill itself costs to load.

A skill that moves nothing after two paired runs is retired, not kept "just in case."

---

## Unchanged

- **One entity, two types.** Capability was merged into Skill because it was the same shape and enforced nothing. It now enforces something and carries fields knowledge skills leave empty. It stays merged, and a CHECK constraint requires `grants` and `io_shape` on a capability and forbids them on a knowledge skill. Decided 2026-10-05 in `DECISIONS-V2.md`.
- **Render paths.** Knowledge skills still render to `.avel/skills/[agent]/[slug].md` and capabilities to `.avel/capabilities/[agent]/[slug].md`. Only where they come from changed, so the golden fixture is unaffected.
- **`SkillSource`** remains an open catalog.

---

## Open questions

| Question | Blocking |
|---|---|
| The first role skills to write, starting with the roles on `template-booking` | Before module 5 generates identity files |
| Whether a domain skill can come from a client directly, or only through a pack | Before the first client-supplied domain knowledge |
| Stack skills attach to a template and domain skills to a pack or a client, but the schema has only `role_skills` and `mission_skills`. Are template, pack, and client skills copied into `mission_skills` when a mission is created, or do they need their own join tables? | **Resolved 2026-10-05:** copied into `mission_skills` at mission creation, with a `source` column. No new tables. `DATA-CONTRACTS-V2.md` |
| `content_sha256` covers description, content, and grants. Should it also cover `avel_enhancement_md` and `io_shape`, so an edit to either changes the pinned hash? | **Resolved 2026-10-05:** yes, and `type` and `layer` too. Anything that changes an agent's behavior is in the hash. `DATA-CONTRACTS-V2.md` |
