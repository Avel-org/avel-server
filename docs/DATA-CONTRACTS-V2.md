# AVEL — Data Contracts & Schema (v2)

*This document owns **shapes**: the contract layer structure and the entity definitions. It does not carry rationale — for why any of this changed, see `DECISIONS-V2.md`. For tools and versions, `TECH-STACK.md`. For build status, `STATE.md`.*

*This document is the canonical data model. No other copy is maintained, in this repository or outside it. Decided 2026-10-05.*

*Supersedes the v1 data model. Stale markers: 13 entities · tRPC · `bytea` snapshots · `skippable` gates.*

---

# Part 1 — The Contract Layer

## What the contract artifact is

Under ts-rest the contract is a first-class artifact: a shared object of routes, methods, paths, and Zod shapes, from which an OpenAPI document is generated.

| Job | Mechanism |
|---|---|
| Type safety, both sides | Backend implements it; frontend infers from it. A change breaks both at compile time. |
| Breaking-change detection | `oasdiff` compares the generated spec against the previous one in CI. Exit 1 on breaking. |
| Reproducibility | The contract's hash freezes into the export's version manifest alongside the rendered bytes. |

**Scope note:** this artifact governs **AVEL's own API**. The phase1↔phase2 conformance gate operates on a *different* artifact in the *client's* repository — see `CLIENT-CONTRACT-CONFORMANCE.md`. Do not conflate them.

## Structure

```
src/contract/
  index.ts            the assembled contract (this is THE artifact)
  client.ts           module 0
  engagement.ts       module 0
  mission.ts          module 13 (read, built); created by module 1
  mission-plan.ts     module 3 — the plan: get · update (PUT). Its own file, because intake.ts imports mission.ts
  activity.ts         module 13 (read only)
  intake.ts           module 1
  playbook.ts         module 3
  template.ts         module 3 — template reads from the template repositories (decided 2026-10-12)
  agent-template.ts   module 4; identity versions with module 5
  skill.ts            module 4
  skill-source.ts     module 4
  roster.ts           module 4
  preset.ts           module 4 — RosterPreset: list · get · create · update. Applying is roster.applyPreset
  dispatch.ts         module 6
  completion-report.ts  module 8
  finding.ts          module 9 (moved from 12 on 2026-10-06)
  export.ts           modules 10 and 11
  repo-policy.ts      module 11
  connection.ts       module 2 (list and create, for the repo read); revoke and the rest with module 11
  proposal.ts         module 14, after the first mission
  shared/
    envelope.ts       success/error response envelope
    errors.ts         the error code union
    pagination.ts     cursor pagination
    status.ts         MISSION_STATUSES, EXPORT_STATUSES
    coherence.ts      computeCoherence — pure, imported by both sides
    access.ts         accessFor — pure, imported by both sides (decided 2026-10-12)
```

**A route group is added with the module that uses it.** No route group exists without a module behind it. Every group above lands with the module named beside it, in `COMMAND-CENTER.md`'s numbering (labeled 2026-10-06). The two module 13 groups, `mission` reads and `activity`, are read-only routes for surfaces that exist before the modules that write their rows.

**Built so far** (the code in `src/contract/` is authoritative for exact shapes):

| Group | Routes | List query |
|---|---|---|
| `health` | `GET /api/health` (public; `data.preview` reports dev preview) | — |
| `clients` | list · get · create · update. Closing a client with an active engagement is refused (422 `client_has_active_engagements`) | `q` (name or primary contact, case-insensitive, LIKE-escaped) · cursor · `meta.total` |
| `engagements` | list · get · create · update · close. Close revokes the engagement's live Connections and returns `revokedConnections` | `clientId` · `status` · cursor |
| `missions` | list · get, read-only, for the Missions surface (module 13). Created through Intake approval once module 1 lands | `origin` (required, never both) · `status` · `q` · `sort` (`lastActivity` · `sprint` · `client`) with `direction` (nulls sort lowest) · `includeArchived` · `needsYou` · `quietBefore` (no activity since, or none) · `lastExportStatus` · cursor · `meta.total` (required here; follows every filter) · `meta.counts` (ignores the status-like filters) |
| `activity` | list, read-only, for the Activity surface (module 13). Each entry is the row's columns, nothing joined | `missionId` · `engagementId` · `entityType` · `entityId` · `actorKind`, ANDed · cursor (a position, not bound to the filters) · `meta.total` (required) |
| `intakes` | list · get · create · revise (`PATCH`) · propose · approve · reject (module 1). A wrong state is 409. The check runs at propose and approve. Approve creates the Mission, and refuses `intake_cut_not_derived` until module 2 | `engagementId` · `status` · cursor · `meta.total` |
| `agentTemplates` · `skills` | list · get · get-by-slug (`/by-slug/:slug`, the live row), read-only (module 4). Skills embed their source; the list item leaves out the markdown | templates: `q` · `kind` · `role` · `wave` (array overlap) · `engagementId`. Skills: `q` · `layer` · `type` · `status` · `role` · `sourceId`. Both: cursor · `meta.total` |
| `skillSources` | list · get, read-only (module 4), with a live `skillCount` | `q` · `kind` · cursor · `meta.total` |
| `connections` | list · get · create (module 2), operator-only. `credentialRef` must look like an env var name; only the name is stored | `engagementId` · cursor |
| `roster` | list · add · update · remove · applyPreset (`POST /api/missions/:missionId/roster/apply-preset`, all or nothing; refuses a non-empty roster unless `replace`) · skills · attachSkill · detachSkill (module 4). Writes need a `draft` mission (422 `mission_not_editable`) | — |
| `presets` | list · get · create (201) · update (`PATCH`, any subset, at least one field; `agents` replaces the list; every update adds 1 to `version`) (module 4). Agents must name live, rosterable templates (422 `agent_template_not_found`, `template_not_rosterable`), each at most once per territory (409 `CONFLICT`), the same rules apply-preset meets. A missing or deleted preset is 404. No delete: `Playbook.default_preset_id` is a NOT NULL FK. applications (`GET /api/presets/:id/applications`, "Used by"): the preset's `roster.preset_applied` rows, newest first, each `{ missionId, mission: { status, type } | null when deleted, presetVersion, appliedAt, actor, added, removed }`; paged, `meta.total`; 404 for a missing or deleted preset | `q` · `cut` · cursor · `meta.total` |
| `playbooks` | list · getForType (`GET /api/playbooks/by-type/:missionType`, the live row, else 404) · create (`POST`, 201; a live mission type is 409) · update (`PUT …/by-type/:missionType`, a full replace, `version` + 1, mission type immutable) · versions (`GET …/by-type/:missionType/versions`, newest first, from the ActivityLog snapshots; `[current]` when none are logged) (module 3). Writes check: gates from the closed vocabulary, each once; waves non-empty, unique, in `WAVES` order; a live default preset (422 `preset_not_found`) that staffs the earliest wave (422 `preset_misses_first_wave`). Update is refused while a live mission of that type is `active` or `halted` (422 `playbook_in_use`) | `q` (name) · cursor · `meta.total` |
| `missionPlans` | get · update (`GET`/`PUT /api/missions/:id/plan`, module 3). The response carries the brief (null when the stored one predates the brief shape), `approvedBrief` (the approving Intake's brief, which the plan may not change; null when no Intake created the mission), `templateRef`, `templateVersion`, and `check: { passed, issues }` from `checkPlan`. Update replaces the plan on a `draft` mission (422 `mission_not_editable`), saves whether or not the check passes, and refuses any change to the approved brief (422 `plan_changes_approved_brief`, with `issues`) | — |
| `intakes.readRepo` | `POST /api/intakes/:id/read-repo` (module 2): pins the commit, reads the tarball, writes the derived fields and the repo columns. Never changes status | — |

Every list uses keyset cursors, and a cursor from a different sort is 400. Search escapes `\ % _` through one helper, `containsPattern()` in `src/routes/shared.ts`.

**JSON on the wire is camelCase; database columns are snake_case.** The entity blocks below use the column names. The contract's Zod shapes carry the camelCase form of the same fields.

**`apply` materializes.** `preset.apply` copies the preset into RosterEntries (copy-then-edit); the preset holds no mission state. The procedure name should make it obvious that applying is a write, not a reference.

**Placement rule:** the contract lives in `avel-server` at `src/contract/`, and `avel-web` consumes it as a git dependency pinned to a commit. Neither side can change it without the other seeing the change. Reaffirmed by the operator on 2026-10-06. Until then avel-web used a live `link:` to a sibling checkout, which CI cannot resolve. A contract change reaches avel-web only when the frontend moves the pin. So a backend handoff names the commit to pin to. The export resolves only within `src/contract/`, which imports nothing outside itself but `zod` and `@ts-rest/core`.

## Route shape

Every route declares method, path, request shape, and **responses per status code**.

```ts
// src/contract/export.ts
export const exportContract = c.router({
  create: {
    method: 'POST',
    path: '/exports',
    headers: z.object({
      'idempotency-key': z.string().uuid(),
    }),
    body: z.object({
      missionId: z.string().uuid(),
      target: exportTargetKind,           // zip | github_pr | github_push
      repoUrl: z.string().url().optional(),
    }),
    responses: {
      201: exportSchema,
      200: exportSchema,                  // replay: same key and body; Idempotency-Replayed: true
      409: errorEnvelope,                 // IDEMPOTENCY_REPLAY: same key, different body
      422: errorEnvelope,                 // PRECONDITION_FAILED
      502: errorEnvelope,                 // EXTERNAL_GITHUB
    },
  },
})
```

## Idempotency

`[specced]` 2026-10-06. Agents retry on timeouts, and a duplicate CompletionReport or Proposal corrupts attribution.

- **The key travels in an `Idempotency-Key` header,** a uuid, never in the body. Export's routes carry their key the same way (`BLAST-RADIUS.md`), and follow the same replay rule below (decided 2026-10-06).
- **Every create an agent can reach takes one:** Proposal, Finding and the Intake draft.
- **Same key and same body** returns the original record with `200` and the response header `Idempotency-Replayed: true`. Nothing is written twice.
- **Same key with a different body** is `409 IDEMPOTENCY_REPLAY`. The server stores a hash of the request body beside the key so it can tell the two apart.
- **Keys are unique per dispatch:** `(dispatch_id, idempotency_key)`. Another dispatch reusing a key cannot reach this dispatch's record, which keeps the 404 rule under *Dispatch*.
- **A CompletionReport needs no key.** Its `dispatch_id` is unique, so a retry finds the report that already closed the dispatch.
- **Operator creates are out for now:** clients and engagements take no key. Adding the optional header later breaks nothing.
- **Export is the one operator create with a key.** It keeps its global `export.idempotency_key`, since an export has no dispatch, and replays the same way: the original export, or `409` for a different body.

## The envelope

```
success:  { success: true,  data: T, meta?: {...} }
error:    { success: false, error: { code, message, details?, requestId } }
```

**The frontend switches on `error.code`. It never parses `message`.** The code union lives in `contract/shared/errors.ts`; both sides import it.

**`details` is typed per code.** The error envelope is a discriminated union on `code`. Two codes carry a strict schema, and the other twenty keep `details` optional and untyped:

- `PRECONDITION_FAILED`: `{ reason, clientId?, engagementId?, issues? }`, required. `reason` is the closed list `PRECONDITION_REASONS` in `src/contract/shared/errors.ts`, which is authoritative; each module's handoff names the reasons it adds and when they fire. A new reason is an edit to that list, announced to `avel-web` first.
- `VALIDATION_FAILED`: `{ params?, headers?, query?, body? }`, each an array of `{ path, message, code? }`, optional because an unparseable body has no issues.

A thrower cannot attach details that don't match its code: `ApiError` is typed per code, so a wrong reason fails to compile. Decided 2026-10-06.

**Both envelopes are in the contract's response schemas,** not only in the handlers. Each route's success response is declared as the success envelope around its data shape, and each error response as the error envelope, so `avel-web` gets both through its pinned dependency. The error envelope's `code` is the closed error-code union.

**The union** is the generic codes `VALIDATION_FAILED · UNAUTHENTICATED · FORBIDDEN · NOT_FOUND · CONFLICT · INTERNAL`, `NOT_OPERATOR` (403: a live session whose GitHub id is no longer on the operator allowlist, so the client shows sign-out; `FORBIDDEN` stays for per-resource denials, decided 2026-10-05), the route codes `IDEMPOTENCY_REPLAY · PRECONDITION_FAILED`, the codes in `BLAST-RADIUS.md` *Error cases*, and `GITHUB_REJECTED` (decided 2026-10-05: GitHub refused the request, not retryable; `EXTERNAL_GITHUB` stays the retryable failure). Whether the code matches this is in `STATE.md`.

**Statuses:** a request whose shape fails validation is `400 VALIDATION_FAILED`. A request that is well formed but not allowed in the current state is `422`. Unknown routes and wrong methods are `404 NOT_FOUND`.

**Lists are cursor-paginated** through `contract/shared/pagination.ts`. No offset pagination.

## Non-contract routes

Four deliberate exceptions:

- **Zip download** — authenticated `GET`, streams the frozen package.
- **File bytes** `[specced]`, after the first mission — upload and download for the Drive (*File*).
- **GitHub webhook** — receives, does not envelope. It moves an Export from `pr-open` to `done` when the PR merges, and to `closed` when the PR is closed without merging.
- **Sign-in** — Better Auth's own routes at `/api/auth/*`, GitHub provider. An allowlist of GitHub ids in an environment variable is checked in Better Auth's sign-in hook; any other GitHub account is refused.

---

# Part 2 — The Schema

## The twenty core entities

**Client · Engagement · AgentTemplate · Skill · KnowledgeEntry · Finding · Intake · Mission · Playbook · RosterEntry · Dispatch · CompletionReport · RosterPreset · Export · RepoPolicy · Connection · ActivityLog · User · Proposal · File**

Plus **SkillSource** (supporting catalog). Deferred: PromptFragment (V1.5). Session is not an AVEL entity: Better Auth owns sessions, in its `session`, `account` and `verification` tables (see *User*).

**Two names, two things.** `Finding` is the entity below: a defect recorded against a mission. `GateFinding` is the typed result a gate check produces and `decide()` reads (`COMMAND-CENTER.md` module 9). Its shape is decided in module 9.

Up from twelve. `Client` and `Engagement` close the agency layer, `Intake` holds Canon's proposal before an operator approves it into a Mission, `Finding` turns a confirmed defect from one mission into an executable check on every mission after it, `CompletionReport` makes cost and edge consumption required fields rather than habits, and `Proposal` is how anything proactive reaches the operator without acting on its own.

`Dispatch` joined on 2026-10-06 `[specced]`, built with module 6. It is the run itself: one agent, one piece of work, one budget, one access token. Before it, nothing sat between "on the team" (`RosterEntry`) and "finished" (`CompletionReport`).

`File` joined on 2026-10-06 `[specced]`, built after the first mission: one document store, scoped general, client or engagement.

---

## Entity reference

### Client

```
id · name · status ('active' | 'closed')
primary_contact? · notes_md?
deleted_at · timestamps
```

`Mission.client` was a text field. At three clients that makes "everything for Meridian" ungreppable, and every query that should have been client-scoped was not. Retrofitting scoping through a codebase is where authorization bugs live.

### Engagement

```
id · client_id      FK → Client
name · scope_md?
status              'active' | 'closed'
started_at · closed_at?
deleted_at · timestamps
```

An engagement groups missions, connections, and knowledge for one body of work. **Closing an engagement revokes its Connections** — that is the lifecycle step `Connection.revoked_at` exists for.

### Intake

Canon's proposal. Never a Mission until an operator approves it.

```
id · engagement_id          FK → Engagement
status                      'draft' | 'proposed' | 'approved' | 'rejected'
source_md                   raw input: call notes, transcript, email thread
proposed_brief?             jsonb — Canon's output
open_questions              text[], NOT NULL — ambiguities Canon surfaced
derived_cut?                'horizontal' | 'vertical'  — computed, not proposed
derived_cut_evidence?       text — the directory structure that decided it
derived_conventions?        jsonb ConventionSet — extracted from the repo, see below
derived_boundaries?         jsonb Boundary[] — the feature/layer split found in the tree
suggested_preset_id?        FK → RosterPreset — follows from the cut
drafted_by_dispatch_id?     FK → Dispatch — [specced] 2026-10-06; the firm session that drafted it, null when the operator did
approved_by?                FK → User
approved_at?
mission_id?                 FK → Mission, set on approval
deleted_at · timestamps
```

*As built 2026-10-05:* the four `derived_*` fields and `proposed_brief` are nullable until the repository is read and Canon has written. A CHECK requires `approved_by`, `approved_at` and `mission_id` when `status = 'approved'`.

*Specced 2026-10-06:* an agent may write an Intake only while it is `draft` and only if its own dispatch drafted it. From `proposed` on, only the operator changes it.

**The brief shape** (decided by the operator 2026-10-06, module 1). `proposed_brief`, and `Mission.brief` once approved:

```
summary              text
requirements         [{ id: 'R1', text }]                         — at least one; ids unique and permanent
acceptanceCriteria   [{ id: 'AC1', requirementId: 'R1', text }]   — ids unique; each cites an existing requirement
modules              [{ id: 'M1', name, requirementIds: ['R1'] }]  — [built] 2026-10-10, module 3; defaults to [] so a brief stored before it parses
```

Module 3's planner extends this same list. It never starts a second one. *Decided by the operator 2026-10-10:* the modules live in the brief, not a table. The operator writes the plan on a draft Mission and code checks it, the Intake pattern; no model is in the path. An Intake's brief carries no modules (the intake check's rule 6). Module ids may change while the mission is a draft, because the plan is still being written. `[attestation]` until the dispatch unit builds the move out of `draft`: from then on, nothing changes the brief.

**The plan check** (`checkPlan`, `src/lib/plan-check.ts`) is Intake's rules 1 to 4, plus: at least one module, unique module ids, every requirement a module lists exists and is listed once, and every requirement sits in exactly one module. Saving a plan does not require a pass.

**The approved brief is fixed.** A plan may add requirements, criteria and modules. It may not change the summary, or remove or edit an approved requirement or criterion; the approval signed off their text. The approved brief is the approving Intake's `proposed_brief`, which no route changes after approval. A mission no Intake created has nothing fixed.

**The mechanical check** runs at `propose` and again at `approve`. It requires a brief that parses, at least one requirement, unique ids, every criterion citing a requirement, and every requirement with at least one criterion. It also requires an empty `modules` list, since the plan adds them (rule 6, 2026-10-10). At `approve` it also requires every open question to be acknowledged: the approve body's `acknowledged[]` must equal `open_questions` as a set. The acknowledgements are recorded in the `intake.approved` ActivityLog payload, so the schema is unchanged.

**The repository read is recorded on the Intake** `[specced]` 2026-10-06, module 2. `repo_url?`, `repo_commit_sha?` and `repo_read_at?` are set by `POST /api/intakes/:id/read-repo`, together with the `derived_*` fields. Approve requires its `repoUrl` to equal `repo_url`, refusing with `422 intake_repo_mismatch`. Otherwise an operator could read one repository and approve a mission on another. An empty repository is refused at read time (`422 EMPTY_REPOSITORY`); greenfield work starts from an AVEL template. A freeze exception, decided by the operator.

**Approval creates the Mission and refuses until the cut is derived.** The approve body carries `missionType` and `repoUrl`. While `derived_cut` is null, approval is `422 intake_cut_not_derived`, because the cut is derived, never chosen. Until module 2 reads repositories, nothing is approved for real.

**`derived_cut`, `derived_conventions`, and `derived_boundaries` are all computed by reading the repository, not proposed by Canon.** One capability — read the client's tree — with three outputs. See the Canon decision in `DECISIONS-V2.md`.

```
read the client repository
    ├── cut            which boundary is a directory
    ├── conventions    the rules actually in force
    └── boundaries     the natural split, and how big each piece is
```

### ConventionSet

The conventions a codebase actually follows, as opposed to the ones its README claims. Extracted, never invented.

```
ConventionSet {
  layering?      { pattern, evidence }    e.g. controller→service→repository
  testing?       { runner, location, naming, evidence }
  naming?        { files, exports, evidence }
  imports?       { rules[], evidence }    e.g. modules import services, never repositories
  formatting?    { tool, config_path }
  enforcement    { eslint?, tsconfig?, precommit?, ci? }
  confidence     'high' | 'low'
  unextracted    text[]  — conventions the operator must supply by hand
}
```

**Every entry carries `evidence`** — the files or config that demonstrate the pattern. A convention asserted without evidence is a guess, and a guess in `conventions/` is worse than a gap, because agents follow it.

**`confidence: 'low'` blocks approval.** A repository with three competing patterns has no convention to extract, and inventing one is the failure this whole system exists to prevent. *Specced 2026-10-06, module 2:* confidence is computed per dimension. A dimension is low when its dominant pattern covers under 80% of the samples, and the set is low when any dimension is. Approve refuses with `422 intake_conventions_low_confidence` and lists what disagreed. The block clears only when the repository is fixed and read again. There is no operator override (decided by the operator).

**This closes a real gap.** `conventions/layering.md` is required by the golden fixture and no role owns writing it. CounselOS's were written by hand. At the third client that is the same provisioning problem Mission 002 found, one level up.

### Boundary

The natural split found in the tree. Makes the roster derived rather than asserted.

```
Boundary {
  kind          'feature' | 'layer'
  path          the directory that is the boundary
  files         count
  loc           approximate
  suggested_territory         the territory for this boundary — the agent is written Name · territory
  collides_with path[]        shared surface two boundaries both touch
}
```

**`collides_with` is the useful field.** A composition root, a shared package, or a barrel file that several boundaries write is exactly what needed the foundations role in Mission 002. Surfacing it at onboarding means the shared surface is provisioned before the first agent dispatches rather than after it blocks four times.

**This makes the roster size a finding rather than an opinion.** The current roster asserts a number of feature agents; nothing has ever checked whether it is right. Reading the tree turns "I picked seven" into "the codebase has six feature boundaries, here they are, and two of them share a file."

**Still operator-approved.** Derived boundaries are a proposal for the roster, not the roster. The operator can merge, split, or override — and an override, like a cut override, requires written rationale.

**Approval materializes a Mission.** Nothing Canon writes becomes executable until an operator says so. The Intake row is retained — it is the provenance for how the brief came to exist.

### AgentTemplate
An agent as data.

```
id · slug              path segment in the export, and the mount lookup key
name
kind                   'horizontal' | 'feature'
roles                  role[] — from the closed vocabulary in ROLES.md
engagement_id?         FK -> Engagement, nullable — engagement scoping lives on Mission
wave_defaults          wave[]   — wave is 'A' | 'B' | 'C' | 'D' | 'E'
identity_md            ≤800 tokens, Zod refinement
depth_md               ≤800 tokens, Zod refinement
writable_paths         text[]   ← glob patterns this agent may modify
version · deleted_at · timestamps
```

`writable_paths` backs the file-ownership check at render time: a file modified by an agent outside its declared globs is a gate failure. This is the mechanical form of "testers never modify code under test."

**`roles` is a closed vocabulary** of the 35 roles in `ROLES.md`, a pgEnum because code branches on it. Only `model` roles may appear on an `AgentTemplate`, with one exception: the `human` role `foundations` appears on the operator's template. A `code` role is a pipeline function and has no template.

**Measurements are keyed by name · territory · engagement, and what may be combined depends on the measurement.**

**Waves** are `A | B | C | D | E`, the global phases in `ROSTER-V2.md`; `E` is Operate, after the ship decision. Every `wave` and `wave[]` field in this document uses this type.

`AgentTemplate.name` is the identity — the instructions an agent runs on. `RosterEntry.territory` is the optional scope within one project. The engagement is the project, and it is scoped on `Mission`: Atlas is one shared identity, so `AgentTemplate.engagement_id` is nullable. Atlas · scheduling in two different clients' apps shares a template and nothing else.

| Kind | Combines across |
|---|---|
| Discipline — boundary violations, blockers filed versus absorbed, edge hash mismatches, test-file writes caught at the exit | Every territory and engagement under the same name |
| Outcome — tokens, cost, time, defects, first-pass gate rate | Only the same territory on the same template |

**Neither kind is ever combined across greenfield and brownfield work, or across internal and client missions.**

A query or report that returns a territory-scoped measurement without its territory and engagement is refused. See the naming section of `ROSTER-V2.md`.

### Skill

```
id · slug · name
description            one or two sentences, always visible to the agent
content_md             the full skill, loaded only when the task needs it
avel_enhancement_md?   AVEL's additions to an imported skill, kept separate
layer                  'role' | 'stack' | 'domain'
type                   'knowledge' | 'capability'
grants?                text[] — capability only; what the runner provides in the room
io_shape?              jsonb { reads: 'large' | 'small', returns: 'large' | 'small' } — capability only
recommended_for        role[] — from the closed vocabulary in ROLES.md
source_id              FK → SkillSource
content_sha256         hash of description, content_md, avel_enhancement_md,
                       grants, io_shape, type, and layer
status                 'draft' | 'approved' | 'retired'
reviewed_by?           FK → User
reviewed_at?
version · deleted_at · timestamps
```

**Layers decide where a skill is delivered.** `role` skills are part of the identity file and hashed into `agent_version_sha256`. `stack` and `domain` skills are given at dispatch and hashed into `CompletionReport.skills_sha256`. See `SKILLS.md`.

**`type='capability'` is enforced by the room.** The runner provides the tools in `grants` and nothing else. A code check rejects a capability attached to any role whose room cannot hold it — a judge cannot be granted write access to source, and only the delivery room can hold the credential.

*Correction:* this previously said a capability "declares a tool grant; it does not enforce one," because no runtime could restrict a tool. The sandbox rooms are that runtime.

**`io_shape` is the declaration the routing rule depends on.** A capability that reads large and returns small is tool-heavy and routed accordingly. `DECISIONS-V2.md` and `SANDBOX.md` both refer to a skill's declared inputs and outputs; until this field existed, they referred to nothing.

**Only `approved` skills can be attached.** Imported skills start as `draft`, are reviewed, and are pinned by `content_sha256`.

**Anything that changes an agent's behavior is in the hash.** An edit to any field listed under `content_sha256` changes the pinned hash. Decided 2026-10-05.

Render paths are unchanged:
`knowledge` → `.avel/skills/[agent]/[slug].md` · `capability` → `.avel/capabilities/[agent]/[slug].md`

Join tables: **`role_skills`** (role → skill, `role` layer only) and **`mission_skills`** (mission → skill, `stack` and `domain` layers only). They replace `agent_template_skills` and `roster_entry_skills`, which attached skills to agents and left them behind whenever roles moved between agents. At dispatch, an agent receives the mission's skills whose `recommended_for` includes one of its roles.

**Template, pack, and client skills are copied into `mission_skills` when the mission is created.** No further join tables. Each row records where the skill came from:

```
mission_skills
mission_id             FK → Mission
skill_id               FK → Skill
source                 'template' | 'pack' | 'client' | 'manual'
```

*As built 2026-10-05:* `role_skills` has the composite primary key `(role, skill_id)` and `mission_skills` has `(mission_id, skill_id)`. The layer rules (`role_skills` holds `role`-layer skills only, `mission_skills` holds `stack` and `domain` only) are `[attestation]`: no trigger enforces them yet.

**Capability stays in Skill.** A CHECK constraint requires `grants` and `io_shape` when `type = 'capability'` and requires them to be null otherwise. Decided 2026-10-05; see `DECISIONS-V2.md`.

### SkillSource
Open catalog, not an enum. `Skill.source_id` is an FK. Ships empty; populated in-app.

```
id · name
kind                   'internal' | 'vendor' | 'community'
url? · license?
deleted_at · timestamps         deleted_at added 2026-10-05, as built
```

*(The test: does code branch on the value? If yes it's an enum. If it's a label that grows, it's a catalog.)*

### Proposal

Anything proactive — from code or from a model — reaches the operator as a proposal and does nothing on its own. See `COMMAND-CENTER.md`, module 14.

```
id
kind                   'next_module' | 'calibration' | 'post_delivery' | 'intake_questions'
source                 'code' | 'model'
proposed_by_dispatch_id?  FK → Dispatch — [specced] 2026-10-06; required exactly when source = 'model'
engagement_id? · mission_id?
summary                one line the operator reads in the queue
payload                jsonb — exactly what approving it would do
premise                jsonb — the facts it was based on, e.g. the gate result it followed
status                 'pending' | 'approved' | 'dismissed' | 'expired'
reason?                the operator's note on dismissing
decided_by?            FK → User
decided_at?
timestamps             created_at, updated_at (as built 2026-10-05); status and decided_at change after creation
```

**A model proposal names the run that made it.** `proposed_by_dispatch_id` leads to the agent, its version hash and its budget, so a Canon chat suggestion is attributable to one session. A CHECK ties it to `source = 'model'`.

**Approving a proposal starts its action through the normal path.** A `next_module` proposal still creates a dispatch that needs its estimate, its room, and its ceilings. Approval skips nothing.

**A proposal expires when its premise stops being true.** If the gate result a next-module proposal followed is reversed, the proposal becomes `expired` and cannot be approved. Stale proposals are the queue's version of a stale preview.

### Finding

A defect recorded against a mission. Confirmed findings are what `verification.findings` checks every later mission against. Not the same thing as a `GateFinding` (see *The twenty core entities*).

```
id · mission_id        FK → Mission
client_id?             FK → Client — null = general; same one-way door as KnowledgeEntry
rule                   the detection rule
subject                what it was found in
severity               'critical' | 'high' | 'medium' | 'low'
class
caught_by              the check or role that found it
reported_by_dispatch_id?  FK → Dispatch — [specced] 2026-10-06; set from the token when a judge writes it
status                 'open' | 'confirmed' | 'dismissed'
dismissed_reason?      required when status = 'dismissed'
timestamps
```

*As built 2026-10-05:* `rule`, `subject`, `class` and `caught_by` are free text, not enums.

**A finding is never deleted.** Findings are evidence, so the table has no `deleted_at`. Removing one is `status = 'dismissed'` with a written `dismissed_reason`, enforced by a CHECK constraint. Decided 2026-10-05.

**The finding routes land with module 9,** not 12 (decided 2026-10-06), because confirming a judge's finding is part of gating.

**A judge's finding names the run that wrote it** `[specced]`. `reported_by_dispatch_id?` is an FK to Dispatch. The server sets it from the token, and it is null when code or the operator records the finding. It carries the per-dispatch idempotency key (*Idempotency*), and it attributes a judge's finding to one run. Decided by the operator on 2026-10-06, built before module 9: the fourth new foreign key under the freeze exceptions.

### KnowledgeEntry

```
id · type              pattern | decision | registry | component | reference | anti-pattern
agent_id               nullable — null = agent-agnostic
client_id              nullable — null = genuinely general, never client-specific
supersedes             self-reference
content_md
version · deleted_at · timestamps
```

**`client_id` is the one-way door.** A pattern learned on one client's codebase must not be retrievable by an agent working another client's mission. Nothing auto-promotes from client-scoped to general — promotion is explicit and requires the entry be rewritten to strip anything client-specific.

**No write path in V1.** The entity exists so the shape is right. Deferred past ~10 real missions; when built, provenance, candidate/promoted status, and forgetting come first, retrieval second, auto-promote never.

### Mission

```
id
engagement_id?         FK → Engagement — required when origin = 'client', null when 'internal' (CHECK)
origin                 'internal' | 'client'
type                   text — joins Playbook.mission_type, no FK; equals template_ref when that is set (decided 2026-10-12)
brief                  jsonb, NOT NULL
sprint_n
status                 'draft' | 'active' | 'halted' | 'shipped' | 'archived'
cut                    'horizontal' | 'vertical'
cut_source             'derived' | 'overridden'
cut_rationale          text — required when overridden, renders into delivery
repo_url               a DEFAULT, not the binding destination
spend_ceiling_usd?     numeric(12,2), nullable; the runner halts the mission when attributed spend reaches it
template_ref?          [built] 2026-10-10, module 3 — the template slug it was built from, e.g. 'template-booking'; null when none
template_version?      [built] 2026-10-10, module 3 — the template repository's commit sha, 40 lowercase hex (decided 2026-10-10); set exactly when template_ref is (CHECK mission_template_complete)
deleted_at · timestamps
```

**`template_ref` makes the evaluation loop a query.** `TEMPLATES.md` improves a role by rebuilding the same template and comparing, and `ROSTER-V2.md` compares outcome measures only within the same template. Neither can be queried unless a mission records its template. Built before the first mission so that mission is comparable; the second exception to the schema freeze (`DECISIONS-V2.md`).

`spend_ceiling_usd` is modeled now so cost governance is a gate check rather than a migration later.

**`engagement_id` follows `origin`.** Decided 2026-10-05: a client mission belongs to an engagement; an internal mission belongs to none. A CHECK requires `engagement_id` when `origin = 'client'` and requires it to be null when `origin = 'internal'`. Migration `0009` carries it. A second CHECK requires a non-blank `cut_rationale` when `cut_source = 'overridden'`.

**`halted` is the state the runner puts a mission in when its attributed spend reaches `spend_ceiling_usd`** (`SANDBOX.md`, and *CompletionReport* below). The status values are exported from the contract as `MISSION_STATUSES` in `src/contract/shared/status.ts`, and the database pgEnum is built from that list. Decided 2026-10-05.

**`origin` separates benchmark from production.** Template builds run by AVEL's own roster are `internal`: the operator wrote the spec and nothing drifts, so they will look better than client work. **Never aggregate internal and client missions.** Internal answers whether a change helped; client answers what delivery costs.

**`cut` is derived, not chosen.** At mission setup the system reads the connected repository's directory structure and determines which boundary is a directory: layer or feature. That is the cut. `cut_source` defaults to `derived`.

An operator may override, and an override requires `cut_rationale` in writing, which renders into the delivery. This is the `gate_override` pattern applied one layer up, and it exists for a specific reason: the original roster defect came from applying the decomposition rule to a roster that had already been decided on. A free-choice field permits exactly that failure. A derived field with a written-rationale override does not.

**Open:** the cut is a property of a mount root rather than of a repository. A monorepo can be layer-organized on the backend and feature-organized on the frontend. A scalar bakes in a uniformity assumption. See ROSTER-V2.md.

### Playbook

```
id · mission_type (unique among live rows) · name
waves_applicable       wave[]
gates                  jsonb { gate, policy: 'mandatory' | 'warn' }[]
deliverable            'pr' | 'report' | 'recommendation'
required_fields        text[]
default_preset_id      FK → RosterPreset, NOT NULL
version · deleted_at · timestamps
```

Gate vocabulary is closed: `phase1-close · alignment · qa · security · rollback · acceptance`.

**References a preset; never lists agents.** Squad composition is RosterPreset's; the Playbook owns process.

**What it owns** (decided 2026-10-12, reasons in `DECISIONS-V2.md`): which waves run, switched on or off in the fixed A to E order; the gates that apply, as a set with a policy each; the deliverable; and the required fields. It never holds domain obligations, the cut, or thresholds. The planner, the runner, the gate and render read it. This row is canonical: a template repository's `.avel/playbook.md` is generated from it.

**A template's playbook is keyed by the template's slug.** A mission with a template has `type` equal to its `template_ref`, so the existing join on `mission_type` finds the template's playbook. A plan update that sets a `template_ref` other than the mission's `type` is refused (422 `template_type_mismatch`) `[specced]`. A mission with no template keeps a playbook keyed by its type, such as `discovery`.

### RosterEntry
One agent customized for one mission, or one standing agent of the firm.

```
id · mission_id? · agent_template_id
scope                  'mission' | 'firm'   — [specced] 2026-10-06
active · waves
customized_md?
writable_paths?        overrides the template's, per mission
territory?             the part of this project the agent is scoped to — written Name · territory
estimated_tokens?      integer — required before dispatch, [attestation]; see below
token_soft_ceiling?    integer — warn and log, do not stop; default 1.5× estimate
token_hard_ceiling?    integer — halt the dispatch; default 3× estimate
grain                  'merged' | 'default' | 'split'
absorbed_boundaries    text[] — when grain is 'merged', the boundaries it owns
access_overrides?      jsonb { skill_id, grant, mode: 'none' | 'read' }[] — narrows accessFor's tool rows, per mission; [specced] 2026-10-12
deleted_at · timestamps         deleted_at added 2026-10-05, as built
```

*As built 2026-10-05:* the three token fields are nullable. A RosterEntry exists before it is dispatched, and no dispatch entity exists yet to carry a NOT NULL. Until one does, "required before dispatch" is `[attestation]`. *Specced 2026-10-06:* `Dispatch` carries the binding estimate and ceilings as NOT NULL. These three fields stay as the planning default a dispatch is created from.

Whether an agent is on a mission = whether its RosterEntry exists and is active. Skills are a relation.

**`access_overrides` only narrows** `[specced]` 2026-10-12. Each override names one tool row from `accessFor` by `skill_id` and `grant`, and lowers it to `read` or `none`. It is written through the roster entry update (`PATCH`, `accessOverrides`; `null` clears it) while the mission is a draft. An override that names no tool row the agent has, raises a mode, or repeats a row is refused (422 `access_override_invalid`, with `issues`). It is the freeze exception recorded in `DECISIONS-V2.md`, *Per-agent overrides*. Nothing enforces it until module 7.

**The firm roster** `[specced]`. Canon, Trace and Uno work for the agency between missions rather than inside one, so their entries have `scope = 'firm'` and no mission. A CHECK requires `mission_id` exactly when `scope = 'mission'`. A firm entry has no `territory`, `writable_paths`, or `absorbed_boundaries`: firm agents write no files. A partial unique index allows at most one live firm entry per `agent_template_id` (decided 2026-10-06), so there is one Canon. Without a firm entry, an agent working outside a mission could not be named by `ActivityLog.actor_roster_entry_id`, and its actions could not be attributed.

### Dispatch

`[specced]` 2026-10-06, built with module 6. One run of one agent on one piece of work. A RosterEntry is dispatched many times: once per module, again after a fix.

```
id · roster_entry_id   FK → RosterEntry
mission_id?            FK → Mission — required exactly when the RosterEntry is mission-scoped
brief_ref?             the module and requirement IDs this run is for; null for a firm session
status                 'queued' | 'running' | 'complete' | 'blocked' | 'failed' | 'halted'
halt_reason?           'token_hard_ceiling' | 'spend_ceiling' | 'wall_clock' — when halted
estimated_tokens       integer NOT NULL
token_soft_ceiling     integer NOT NULL — default 1.5× estimate
token_hard_ceiling     integer NOT NULL — default 3× estimate
tokens_used            integer NOT NULL — the runner's running count, starts at 0
agent_version_sha256   NOT NULL — frozen when the dispatch starts
skills_sha256          NOT NULL — frozen when the dispatch starts
model?                 set when it starts
token_sha256?          SHA-256 of the dispatch's access token; never the token itself. Unique: it is the lookup key on every request
idempotency_key        unique — a retried start cannot run twice
started_at? · closed_at?
timestamps
```

**The estimate becomes a constraint.** A dispatch cannot be inserted without `estimated_tokens` and both ceilings, which closes the `[attestation]` on RosterEntry. The ceilings are copied from the RosterEntry's defaults and may be changed per dispatch before it starts.

**The runner owns `tokens_used`.** It adds to it as the agent works, records a soft-ceiling crossing, and sets `halted` with its reason at the hard ceiling. No agent-reachable route writes it.

**A dispatch closes with exactly one CompletionReport,** through `CompletionReport.dispatch_id`. `closed_at` is set in the same transaction. Decided 2026-10-06:

| Ends as | Who files the report |
|---|---|
| `complete`, `blocked` | The agent, with its token, while the dispatch is `running` |
| `halted`, `failed` | The runner, as the `system` actor, because the agent's token no longer works |

**The token works only while the dispatch is `running`.** `queued`, `complete`, `blocked`, `failed` and `halted` all answer `401 DISPATCH_CLOSED`.

**A firm session is a dispatch.** A Canon chat session is a dispatch of Canon's firm RosterEntry, with no mission and no brief, under its own estimate and ceilings. Chat therefore has a budget, an audit trail, and a token that dies when the session ends, like every other agent.

**Agent access.** An agent reaches the API with its dispatch's token, sent as `Authorization: Bearer`. The token is random and opaque. The server stores only its hash and resolves every request to a caller:

```
token → token_sha256 → Dispatch
  not running, or not found         → 401 DISPATCH_CLOSED
  RosterEntry → AgentTemplate.roles → allowed actions for this route's module and verb
  verb not allowed                  → 403 AGENT_NOT_PERMITTED
  data outside the dispatch's mission → 404 NOT_FOUND
```

- **Three callers, one middleware.** A request resolves to `{ kind: 'operator', operator }`, `{ kind: 'agent', dispatch, rosterEntry, roles }`, or `{ kind: 'system' }` for the runner. The runner has its own credential, held by the runner process and never in a room. It writes only what the runner owns: `tokens_used`, status and halt changes, and the report for a halted or failed dispatch. It logs as `actor_kind = 'system'` (decided 2026-10-06). Every route declares the resource, the verb (`read`, `propose`, `act`), and what "its own" means for it, e.g. `{ resource: 'completion_report', verb: 'act', own: 'dispatch' }`. A route with no declaration refuses every agent.
- **Approval, dispatch, delivery, gate overrides and token issue require an operator in code,** not through the per-family table. An error in that table cannot grant them. The full list is in `ROLES.md`.
- **What each agent may do comes from its families,** per `ROLES.md`, *What each family may do through the API*. Until that table is built, it is empty and every route refuses an agent.
- **"Its own" is derived from the token, never supplied by the agent.** The server sets `CompletionReport.dispatch_id`, `Finding.caught_by` and `Finding.mission_id`, and `Intake.drafted_by_dispatch_id` from the dispatch. A body that names a different dispatch or mission is refused.
- **Agent writes log as `actor_kind = 'agent'`** with `actor_roster_entry_id` set from the dispatch, under the existing actor CHECKs.
- **Data outside the mission answers 404, not 403,** so an agent cannot learn which other missions exist. A firm dispatch reads across missions, and is held to `read` and `propose`. It may read clients, engagements, missions, exports and activity. It never reads connections, repo policies or any credential (decided 2026-10-06; `ROLES.md`).
- `DISPATCH_CLOSED` and `AGENT_NOT_PERMITTED` join the error union when module 6 builds this.

Where the token is held is a sandbox boundary: see `SANDBOX.md`.

### CompletionReport
What an agent produced, and the evidence it consumed. Required to close a dispatch.

```
id · roster_entry_id     FK -> RosterEntry
dispatch_id              FK -> Dispatch, unique — [specced] 2026-10-06; one report closes one dispatch
mission_id
status                   'complete' | 'blocked' | 'failed' | 'halted'
halt_reason?             'token_hard_ceiling' | 'spend_ceiling' | 'wall_clock' — when halted
soft_ceiling_crossed     boolean — the dispatch passed its soft ceiling
actual_tokens            integer, REQUIRED to close
agent_version_sha256     SHA-256 of identity.md + depth.md at dispatch — the hash only
skills_sha256            SHA-256 over the sorted stack and domain skills given at dispatch
version_source           'recorded' | 'reconstructed'
model                    the model that actually ran
artifacts_read           [{ path, sha256 }]  — every declared edge input
artifacts_written        [{ path, sha256 }]
files_touched            integer
file_types_touched       text[]              — calibration signal
rereads                  integer             — calibration signal
blockers                 [{ description, workaround, provisioning_gap: boolean }]
deleted_at · timestamps           deleted_at added 2026-10-05, as built
```

A CHECK requires `halt_reason` exactly when `status = 'halted'`.

**Two fields are required, not optional, and that is the point.** `Dispatch.estimated_tokens` cannot be null (specced 2026-10-06; until it is built, the rule sits on `RosterEntry.estimated_tokens` as `[attestation]`). `CompletionReport.actual_tokens` cannot be null at close. Cost logging has been a stated rule since the first mission and has produced zero rows across three, because a rule you have to remember keeps failing. A dispatch that cannot be created without an estimate, and a mission that cannot close without an actual, turns the cost log from a habit into a query.

**`artifacts_read` enforces the edge graph.** Every consumer records the hash of what it read. The ownership check compares each hash against the producer's `artifacts_written`. A mismatch means the consumer worked from a different version of the interface than the producer wrote — the inter-agent-misunderstanding failure, caught mechanically.

**`file_types_touched` and `rereads` calibrate grain.** The merge and split thresholds in `ROSTER-V2.md` are guesses. These two fields are how they stop being guesses.

**The token ceilings are enforced by the runner, never by the agent.** Closes F10. Before this, the estimate was required at dispatch and the actual at close, and nothing stopped a looping agent in between — cost was learned only after it was spent. The runner tracks cumulative tokens during the dispatch, warns at the soft ceiling, and halts at the hard ceiling, recording `status: 'halted'` with the reason. It also halts when the mission's attributed spend reaches `Mission.spend_ceiling_usd`, which until now was read by nothing.

**An agent never polices its own budget.** An agent asked to stop itself near a limit is an agent judging its own performance — the self-grading problem again. The ceiling lives in the runner, outside the agent's reach.

**Two levels, not one number.** A single multiple is a guess that will be wrong in both directions before there is data.

| Level | Default | Does |
|---|---|---|
| Soft | 1.5× estimate | Warns and records `soft_ceiling_crossed`. The work continues. |
| Hard | 3× estimate | Halts the dispatch. |
| Backstop | `Mission.spend_ceiling_usd` | Halts the whole mission. |

**The hard ceiling can afford to be loose because runaway loops are not subtle.** A loop does not overshoot its estimate by twenty percent; it overshoots by an order of magnitude. Three times the estimate catches every real runaway while leaving room for a task that simply ran long. The soft ceiling meanwhile produces calibration data from every run without stopping anything.

Both defaults are `[hypothesis]`. After roughly ten recorded runs, set the hard ceiling from the observed ratio of `actual_tokens` to `estimated_tokens`. Start global, and move to per-role multiples once there is enough data — a design-system dispatch and a domain dispatch will not vary alike.

**`version_source` separates measured from reconstructed.** Closes F13 as far as it can be closed. Mission 002 ran before version hashing existed, but it ran at a known commit, `31f4b44`, and the identity files at that commit are recoverable from git history. Hashing them backfills the version.

It is marked `reconstructed` rather than `recorded`, because it assumes the agent loaded the committed files and not a local edit. That assumption is probably true and cannot be verified. Every run from here forward is `recorded`.

**The version matters for attribution, not for findings.** Those are different questions, and conflating them would throw away real evidence.

A defect a mission caught is real regardless of which agent version caught it. Using that mission as a baseline to judge whether a later agent change helped is only valid when the version is known. So every run falls into one of three tiers, each used only for what it can support:

| Tier | Valid for | Not valid for |
|---|---|---|
| `recorded` · `client` | Everything, including what delivery actually costs | — |
| `recorded` · `internal` | Benchmarks, agent comparisons, calibration | Quoting delivery cost to a client |
| `reconstructed` | Qualitative findings — defects caught, blockers filed, boundary adherence | Any quantitative comparison, cost trend, or agent A/B test |

**Mission 002 is `reconstructed`.** Its findings stand: the authorization defect, the error-wrapping defect, zero boundary violations across 61 files, three blockers filed and none absorbed. It is excluded from every comparison — twice over, since it also recorded no cost. Nothing is discarded, and nothing contaminates a comparison it is unfit for.

**Only the hash is stored here.** Where identity text is kept is decided in module 5, under one constraint: every recorded `agent_version_sha256` must resolve to its exact identity text, or an A/B comparison cannot be reproduced. Decided 2026-10-05.

**`agent_version_sha256` and `model` make improvements attributable.** When an agent's identity file changes between runs, the result is tied to exact agent content. Without these, a better run after an edit could be the edit, an easier task, or variance, and there is no way to tell. See `TEMPLATES.md` for the evaluation loop they enable.

### RosterPreset
A saved squad. Applying it **materializes** RosterEntries (copy-then-edit); the preset holds no mission state.

```
id · name · description?
cut                    'horizontal' | 'vertical'
agents                 jsonb [{ agent_template_id, waves, territory?,
                                writable_paths?, estimated_tokens? }]
version · deleted_at · timestamps
```

**A preset's `estimated_tokens` is a default only.** Every mission re-estimates; `Dispatch.estimated_tokens` is still required for every run.

### Export

```
id · mission_id · sprint_n
idempotency_key (unique)
target_kind            'zip' | 'github_pr' | 'github_push'
connection_id?         FK → Connection    what authorizes this; null only for target_kind 'zip' (CHECK)
status                 see Lifecycle below
status_changed_at      when the export entered its current status; set from the clock in the same write that changes status. Trigger 0013 refuses a status change that does not move it forward; a CHECK keeps it at or after created_at
pr_status?             free text
dry_run                boolean, default false
preview_export_id?     FK → Export — the preview this was approved from
base_commit_sha?       the branch tip the blast radius was computed against
base_ref?              branch name
blast_radius?          jsonb — shape in BLAST-RADIUS.md
verification           see below
gate_override_gate?            which gate was overridden
gate_override_justification?   written reason, required
gate_override_by?              FK → User
gate_override_at?
                       all four null, or all four set with a non-blank
                       justification (CHECK). Four flat columns, 2026-10-05
replay_of              FK → Export, nullable — this export re-ran a past
                       mission's frozen inputs against a different model
package_sha256         hash over every rendered path and its content
package_hash_version   which package hash definition produced package_sha256
snapshot_key           object storage key (R2 deferred; see TECH-STACK.md)
snapshot_sha256        content hash — the integrity check
snapshot_bytes         size
version_manifest       structured, IN POSTGRES — queryable, never inside the blob
contract_sha256        AVEL's frozen contract artifact hash
timestamps             no deleted_at (2026-10-05)
```

*As built 2026-10-05:* `connection_id` is nullable only for `zip`, by CHECK. `idempotency_key` is plainly unique, across all rows. `verification`, the `snapshot_*` fields, `version_manifest`, `contract_sha256` and the `package_*` fields are nullable, because they are filled as the export advances.

**Lifecycle:**

```
pending → rendering → verifying → previewing → previewed | delivering → pr-open → done | closed | failed
```

- A dry run (`dry_run: true`) ends at `previewed`, which is terminal. Nothing leaves it.
- A real export goes `previewing → delivering`. `zip` and `github_push` end at `done`. `github_pr` ends at `pr-open` until the GitHub webhook reports the PR: merged moves it to `done`, closed without merging moves it to `closed`.
- Any stage can end in `failed`.
- A preview is not required for `zip` (`EXPORT-ENGINE.md` §7).

The status values are exported from the contract as `EXPORT_STATUSES` in `src/contract/shared/status.ts`, and the database pgEnum is built from that list. Decided 2026-10-05.

**The determinism comparison uses `package_sha256`.** A real export's package hash must equal its preview's, under the same `package_hash_version`. The hash definition is versioned so a later change to it never makes an earlier export unretrievable (`EXPORT-ENGINE.md` §13). Decided 2026-10-05.

Immutable after freeze; only `status` and `pr_status` advance.

**Four gate stages, in order:** verify → conform → blast radius → deliver. There is deliberately no AI review stage — no inference in the gate, permanently. See `DECISIONS-V2.md`.

**Every stage is headless.** The machine interface is primary; any human-facing view consumes it. A gate that needs a TUI cannot run in CI, which is the case that matters.

**`verification`:**

```
verification {
  build       { status: 'pass' | 'fail', ... }
  tests       { status, total, failed, ... }
  analysis    { status, findings, ... }
  coverage    { lines_pct, delta_pct }
  mutation    { score_pct, killed, survived, scope: 'changed' | 'full' }
  ownership   { status, violations: [{ agent, path }] }
  permissions { status, cells_total, cells_undefined,
                gaps: [{ role, resource, state, expected, actual }] }
  absence     { status, obligations_total, unmet:
                [{ rule, subject, detail }] }
  findings    { status, checked, matched:
                [{ finding_id, mission_id, rule, subject }] }
  conformance { status, breaking: [...] }        ← see CLIENT-CONTRACT-CONFORMANCE.md
  verified_at
  runner      which capability-type Skill produced this
  runner_chain [{ slug, attempted_at, ok }]   ordered fallbacks — a failed
                                              runner degrades to the next
                                              rather than failing the export
} | null
```

Gate passes only when: build pass · zero test failures · analysis pass · coverage delta ≥ 0 · mutation score ≥ the global floor · zero ownership violations · zero breaking conformance diffs · zero undefined permission cells · zero unmet obligations · zero matched prior findings.

**An ownership violation is never overridable.** `gate_override` can bypass a failed gate with written reasons; it cannot bypass `verification.ownership` or any `BLAST_RADIUS_VIOLATION`. Decided 2026-10-05; `COMMAND-CENTER.md` module 9.

**`permissions`** is the full role × resource × state matrix generated from the schema. A cell that is neither explicitly allowed nor explicitly denied is a gap, not a pass. Mission 002's authorization defect was this shape.

**`absence`** checks what the contract implies but the code lacks. Every other field in this object inspects what is present; this is the only one that inspects what is missing, which is the shape of the failure class this product exists to catch.

**`findings`** checks the work against previously confirmed defects. Deterministic list matching — no retrieval, no inference, nothing auto-promoted.

**The mutation floor is not stored on Export.** It is global, versioned, and lives in config under source control — changing it is a reviewed commit, not a per-mission field. `verification.mutation` records the *measurement*; policy lives elsewhere. `version_manifest` carries the config hash, so "what bar did this ship against" stays answerable exactly, later — same move as `contract_sha256`.

**`scope`** distinguishes an incremental run (changed files, normal export, minutes) from a full-project run (sprint ship, hours, its own job).

> **⚠ `conformance` is a placeholder.** Its inner shape depends on the client-side artifact format, which is unspecified.

### RepoPolicy

```
id · repo_url (unique among live rows, normalized) · label?
allow_direct_push_to_default   boolean, default FALSE
default_target?                'zip' | 'github_pr' | 'github_push'
deleted_at · timestamps
```

A repo with no policy row is treated as `false`. The safe behavior needs no setup; only the permissive behavior is opt-in.

### Connection

```
id · service ('github')
engagement_id?         FK → Engagement — null for AVEL's own internal work
label                  e.g. "Meridian engagement"
scope_type             'owner' | 'repo'
scope_value            e.g. "meridian-co" or "meridian-co/app"
credential_ref         env var name or secret ref — NEVER the token
status                 'active' | 'expired' | 'revoked'
expires_at? · last_rotated_at? · revoked_at?
deleted_at · timestamps
```

- **The token is never stored in the database.** `credential_ref` names where it lives; the gateway resolves it.
- An export resolves **both** a Connection (*what authorizes this?*) and a RepoPolicy (*what am I allowed to do?*).
- **Revocation is a step in engagement close** — set `revoked_at`; the gateway refuses.

V1 reads a single token from env. The model supports many, so the second client is a row, not a migration.

### File

`[specced]` 2026-10-06, **built after the first mission** (decided by the operator; not a freeze exception). One store for documents: the agency's general docs, a client's files, an engagement's files.

```
id
scope                  'general' | 'client' | 'engagement'
client_id?             FK → Client — required when scope is 'client' or 'engagement', null when 'general' (CHECK)
engagement_id?         FK → Engagement — required exactly when scope is 'engagement' (CHECK)
name                   the uploaded file name, for display only
mime                   detected by the server from the bytes, never taken from the upload
bytes                  integer, under a size cap
sha256                 computed by the server; the storage key
storage_key            where the blob gateway holds the bytes; null once purged
uploaded_by            FK → User
purged_at?             set when the bytes are hard-deleted
deleted_at · timestamps
```

```
intake_files           intake_id FK → Intake · file_id FK → File — source material attached to an Intake
```

**`client_id` is the one-way door,** as on KnowledgeEntry and Finding. A client's or an engagement's file is never readable by an agent working another client's mission.

**Bytes live behind the blob gateway,** the same one that holds frozen export snapshots: `put` and `get` by sha256 key, in `AppDeps`. Local disk in dev and tests, R2 in production (`DECISIONS-V2.md`, *Decided 2026-10-06: the Drive*).

**Deleting a file hard-deletes its bytes and keeps the row as a tombstone.** A client document can carry a duty to destroy it, which a soft delete cannot honor. The row keeps `sha256`, `name`, `uploaded_by` and the time, sets `purged_at` and clears `storage_key`. This is the one stated exception to the soft-delete invariant below, decided by the operator.

**Uploads and downloads are byte routes outside the contract,** like the zip download. A download always sends `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and never serves HTML or SVG inline, so an uploaded file cannot run script in the app's origin.

**Agents never search the store.** A mission agent reads the files listed in its dispatch brief, hashed with the brief the way its skills are. Firm agents read across scopes, per `ROLES.md`. Files reach a room only as copies, never as a mount of the store (`SANDBOX.md`). Agents learn from a file only when the operator promotes it to a knowledge skill, through draft, review and approval pinned by hash (`SKILLS.md`). There is no retrieval and no write-back.

### ActivityLog
Append-only. `action` and `entity_type` are **closed vocabularies**. Adding a mutation adds its action to the enum in the same change. The action prefix is a *domain*, not the entity_type (`roster.preset_applied` logs against entity_type `mission`, as built; corrected 2026-10-10, this said `roster_entry`). Two payloads are read back by routes, so their shapes are contract: `roster.preset_applied` is `{ presetId, presetVersion, added: uuid[], removed: uuid[] }`, and `playbook.created` / `playbook.updated` hold the full playbook as written (wire shape). The write happens **inside the same transaction** as the mutation.

```
id · at
actor_kind               'operator' | 'system' | 'agent'
actor_user_id?           FK → User
actor_roster_entry_id?   FK → RosterEntry — which agent, when actor_kind = 'agent'
action                   enum
entity_type              enum
entity_id
mission_id?              FK → Mission
engagement_id?           FK → Engagement
request_id               NOT NULL — a system job passes its run or job id
payload                  jsonb
```

**Append-only is enforced by database triggers** that refuse `UPDATE`, `DELETE` and `TRUNCATE`. Not by convention. Decided 2026-10-05.

**Two actor CHECKs:** `actor_kind = 'operator'` exactly when `actor_user_id` is set, and `actor_kind = 'agent'` exactly when `actor_roster_entry_id` is set. Decided 2026-10-05.

**The vocabularies (2026-10-05):**

| Enum | Values |
|---|---|
| `activity_action` | `client.created` · `client.updated` · `engagement.created` · `engagement.updated` · `engagement.closed` · `auth.signed_in` · `connection.revoked` |
| `activity_entity_type` | `client` · `engagement` · `user` · `connection` |

**`mission.created`, `mission.status_changed`, `export.created` and `export.status_changed` (with entity types `mission` and `export`) were added in migration `0011`, ahead of the mutations that will write them.** This is an exception to "an action enters the enum with its mutation": the dev seed writes them, so mission lists show real activity before the mission and export mutation routes exist. Decided 2026-10-05. **`connection.revoked` and `connection` were added in migration `0010`.** Closing an engagement revokes its Connections in the same transaction, and writes one `connection.revoked` row per revoked Connection. The other values are as built.

Each later mutation adds its action, and its entity type if new, in the same change.

### User

**Better Auth's `user` table is the User entity**, extended with two columns. As built 2026-10-05:

```
id
name
email                  unique
email_verified         boolean
image?
github_id              unique   — AVEL's addition
github_login                    — AVEL's addition
timestamps
```

Better Auth also creates `session`, `account`, and `verification`. Those are Better Auth's tables, not AVEL entities. Sign-in mechanics are under *Non-contract routes*. Decided 2026-10-05.

**Every `*_by` field is a foreign key to User:** `Intake.approved_by`, `Skill.reviewed_by`, `Proposal.decided_by`, and `Export.gate_override_by`. The override is four flat columns rather than jsonb so this one is a real constraint too.

---

## Coherence

```
computeCoherence({ cut, roster: CoherenceEntry[] }, playbook: { wavesApplicable, gates }) → {
  block?: { code: 'no_agents_in_first_wave', reason, wave: Wave | null },
  warnings: CoherenceWarning[]
}
CoherenceEntry = { id, active, waves, kind, roles, writablePaths }   — writablePaths resolved
```

*As built 2026-10-10* (`src/contract/shared/coherence.ts`, module 3). The mission wire carries no roster, so the caller passes the cut and the resolved roster. `resolveWritablePaths(entry, template)` is exported so both sides resolve paths the same way: the entry's override, else the template's. Only active entries count. `earliestWave(playbook)` is exported too: the lowest wave in `WAVES` order that the playbook declares, or null when it declares none. **A playbook with no waves blocks, with `wave: null`** (fails closed, decided 2026-10-10). The one warning built is `vertical_cut_roles_unassigned`: under a vertical cut, `foundations` and a Verify-family role must each be held by an active entry. It applies whatever gates the playbook declares (decided 2026-10-10). `gates` is in the input but read by no check yet.

**The disjointness half of cut coherence is deferred** (decided 2026-10-10) until `writable_paths` can express exclusions; a human's foundations entry will be exempt. The glob classifier it needs is built and exported, wired into no warning: each glob is a prefix, an exact file, a leaf anywhere (`**/<leaf>`), or unknown, and pairs compare by segment, never by character. A literal without a trailing slash is a file; write a directory as `dir/` or `dir/**`. Any pair with an unknown glob is not proven disjoint.

**This function lives in `src/contract/`, not in the service layer.** It is pure — no database, no network, no clock — so both sides import the same implementation. The frontend calls it for live feedback on the loadout screen; the export gate calls it for permission. Shared code, single authority: a client that lies about coherence still cannot ship.

**Cut coherence is path arithmetic, not an assertion.** "Is a foundations role assigned" passes if foundations is assigned to a feature agent, which is the failure mode it was meant to catch. The checkable form:

> Under the vertical cut: a foundations role and a verification role are both assigned, and each one's writable set is disjoint from every feature agent's writable set.

Computable from the mount table. This enforces the rule that owning territory disqualifies you from judging a seam, mechanically rather than by good intentions.

**The hard block:** the mission must contain at least one active agent in the **earliest wave its playbook declares**. For `template-booking` that resolves to wave `A`; for `discovery` it resolves to whatever that playbook starts with.

Warnings are playbook-relative — read the playbook's `gates`, so absences a playbook doesn't declare aren't flagged.

---

## Cross-cutting invariants

- **Soft delete** on anything an Export can reach. `deleted_at` + an explicit `live()` filter in every list query — Drizzle has no middleware, so it is never implicit. Exceptions: a `File`'s bytes are hard-deleted and its row kept as a tombstone (decided 2026-10-06); `Finding` is never removed, only dismissed; `ActivityLog` is append-only; `Export` has no `deleted_at`; Better Auth's tables have none.
- **No database defaults for ids or times.** The only column defaults are `repo_policy.allow_direct_push_to_default = false` and `export.dry_run = false`. As built 2026-10-05.
- **Unique slugs and keys are partial unique indexes on live rows** (`deleted_at is null`): `agent_template.slug`, `skill.slug`, `playbook.mission_type`, `repo_policy.repo_url`. `export.idempotency_key` is plainly unique. As built 2026-10-05.
- **Foreign keys are `ON DELETE no action`,** except `session.user_id` and `account.user_id`, which cascade. A user who acted cannot be hard-deleted. As built 2026-10-05.
- **Versioning is counter-only.** No version-history table, deliberately.
- **Determinism in the render.** No clock, no randomness, no unstable ordering in rendered bytes.
- **Zod defines shape once.** Tables derive via `drizzle-zod`; the contract imports the same schemas. One definition, three consumers.
- **Enums are pgEnums when code branches on them**; catalogs are tables when they're labels that grow.

---

## Access

```
accessFor({ roles, writablePaths, skills, missionSkillIds, overrides }) → { enforced: false, rows: AccessRow[] }

AccessMode = 'none' | 'read' | 'write_held' | 'send_after_approval'
AccessRow  = { kind: 'repository', mode: 'write_held' | 'read', scope: string[] }
           | { kind: 'grant', skillId, skillSlug, grant, system, derivedMode: 'read' | 'write_held', mode: 'none' | 'read' | 'write_held' }
           | { kind: 'delivery', mode: 'send_after_approval' }
AccessOverride = { skillId, grant, mode: 'none' | 'read' }
```

*As built 2026-10-12* (`src/contract/shared/access.ts`). Pure, like `computeCoherence`: both sides import it. Reasons are in `DECISIONS-V2.md`, *Access modes are derived*.

- **`writablePaths` is resolved** (`resolveWritablePaths`). The repository row is `write_held` when it is non-empty and `read` when it is empty. Its scope is the paths.
- **Tool rows come from capability skills** that are approved and recommended for at least one of the agent's roles. A `role`-layer skill counts on its own. A `stack` or `domain` skill counts only when attached to the mission (`missionSkillIds`). Knowledge skills are text, not tools, and make no row.
- **One row per grant.** `system` is the grant up to its first `:`, or the whole grant when it has none. `derivedMode` is `read` when the verb after the `:` is exactly `read`, else `write_held`. `mode` is the override's mode when an override names the row, else `derivedMode`. Overrides that name no row are ignored on read; the write refuses them.
- **Order is fixed:** the repository row, then tool rows by skill slug and then grant order, then the delivery row.
- **The delivery row is always present and never overridable.** Agents never deliver.
- **`enforced` is `false` until module 7.** A surface shows every row as recorded, not enforced.
- **No `write` mode.** Every file an agent writes is held until the gate passes, so nothing would derive it.

`checkAccessOverrides(rows, overrides)` is exported too. It returns the issues the roster update refuses with, in a stable order.

## Templates

A template is not an entity. It is read from its repository (`TEMPLATES.md`, *Where templates live*), and no table holds it (decided 2026-10-12).

```
GET /api/templates           every template in the allowlist, in allowlist order
GET /api/templates/:slug     one; a slug not in the allowlist is 404

Template = {
  slug                 the repository name, e.g. 'template-booking'; the mission template_ref and the playbook mission_type
  readable             false when the repository or its manifest could not be read
  name? · scope? · startingState?     from .avel/template.json; null when not readable
  latestSha?           the default branch's head, 40 lowercase hex; null when not readable
  defaultPresetId?     the template's live playbook's default preset; null when it has no playbook
  missionCount         live missions with this template_ref
}
scope          'full-stack' | 'frontend' | 'backend' | 'integration' | 'data' | 'automation' | 'migration' | 'audit'
startingState  'greenfield' | 'brownfield'
```

`[specced]` 2026-10-12. The allowlist is configuration under source control and is bounded, so the list is not paged. A `TemplateSource` gateway in `AppDeps` does the reading. Production reads GitHub, and dev and tests read a fixture, so the route works on `avel_dev` under dev preview. One unreadable repository marks its own row and never fails the list.

---

## Migration order

As built, from `drizzle/` (2026-10-05). Each table comes after every table its foreign keys reference. `User` precedes `Skill` because `Skill.reviewed_by` references it.

| Migration | Creates | Notes |
|---|---|---|
| `0000` | pgvector extension | Unused, so V2 retrieval needs no migration later |
| `0001` | `client`, `engagement` | |
| `0002` | `connection`, `repo_policy`, `skill_source` | |
| `0003` | `agent_template`, `roster_preset`, `playbook`, `mission`, `roster_entry`, `completion_report`, `finding`, `knowledge_entry` | |
| `0004` | `user`, `session`, `account`, `verification` | Better Auth's tables |
| `0005` | `skill`, `role_skills`, `mission_skills`, `intake`, `export`, `proposal` | |
| `0006` | `activity_log` | Last, so every `entity_type` it logs against exists |
| `0007` | ActivityLog append-only triggers | Refuse `UPDATE`, `DELETE` and `TRUNCATE` |
| `0008` | Export gate-override CHECK | Rejects a null justification, which the first version of the CHECK let through |
| `0009` | Mission engagement CHECK | `engagement_id` nullable; required for `client`, null for `internal` |
| `0010` | ActivityLog enum values | Adds `connection.revoked` and `connection`. `ADD VALUE` runs inside the migration transaction, so no migration in the same batch may use a newly added value |
| `0011` | ActivityLog enum values | Adds `mission.created`, `mission.status_changed`, `export.created`, `export.status_changed`, and entity types `mission`, `export` |
| `0012` | `export.status_changed_at` | Added nullable, backfilled from `created_at`, then NOT NULL. CHECK `status_changed_at >= created_at` |
| `0013` | Export status trigger | Refuses any status change that does not move `status_changed_at` forward |
| `0014` | ActivityLog enum values | Intake's five actions and entity type `intake` |
| `0015` | ActivityLog enum values | Skill source and skill actions, entity types `skill_source`, `skill` |
| `0016` | ActivityLog enum values | Roster and mission-skill actions, entity type `roster_entry` |
| `0017` | Intake repository read | `intake.repo_url`, `repo_commit_sha`, `repo_read_at` under an all-or-none CHECK; `intake.repo_read`, `connection.created` |
| `0018` | ActivityLog enum values | `preset.created`, `preset.updated`, entity type `roster_preset` |
| `0019` | Mission plan | `mission.template_ref`, `template_version` under CHECK `mission_template_complete`; `mission.plan_updated` |
| `0020` | ActivityLog enum values | `playbook.created`, `playbook.updated`, entity type `playbook` |

`0001`–`0006` create 24 tables: 2 + 3 + 8 + 4 + 6 + 1.

`Mission` has no foreign key to `Playbook`. They join on `Playbook.mission_type`.

**Specced 2026-10-06, not yet migrated:**
- **Module 6:** `roster_entry.scope` with `mission_id` made nullable under its CHECK, plus the partial unique index on live firm entries per template. Then `dispatch`, with `token_sha256` unique. Then `completion_report.dispatch_id`, `proposal.proposed_by_dispatch_id` and `intake.drafted_by_dispatch_id`.
- **Before module 9:** `finding.reported_by_dispatch_id`, nullable.
- **With each agent-reachable create:** its `idempotency_key` and request hash, unique per dispatch (*Idempotency*).

The new foreign keys on existing tables are added nullable, backfilled, then constrained, because a NOT NULL column added in one step fails on a table that already has rows.

Forward-only. One migration per change. Never edit an applied one.
