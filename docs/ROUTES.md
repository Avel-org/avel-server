# Routes & Screens

**Status: `[specced]` — the route tree and screen contracts. Nothing built.**

*Owns: the frontend route map, the device boundary per route, and what each screen needs from the contract. Shapes are in `DATA-CONTRACTS-V2.md`; the pre-flight surface is specified in detail in `BLAST-RADIUS.md`.*

---

## Conventions

**Device classes** — the boundary is per route, not per app.

| Class | Meaning |
|---|---|
| 📱 **capture** | Works on a phone. Offline-capable where marked. |
| 🖥 **construction** | Desktop only. A phone gets "open this on desktop." |
| ✅ **approve** | Read + a single approving action. Phone-allowed; initiation is not. |

**Every screen gets four states** — loading (content-shaped skeleton), empty (designed, brand voice), error (mapped per `error.code`), success. Enforced by the `<Surface>` generic, not by memory:

```tsx
<Surface query={q} loading={<SkeletonRosterRow />} empty={<NoAgents />} error={ErrorState}>
  {(data) => …}
</Surface>
```

---

## The sidebar

Twelve links in three groups, per ruling 3 of `avel-web/design/AVEL-DESIGN.md` (2026-10-05). An earlier draft of this section listed sixteen; that was a stale field count. A thirteenth, Drive `/drive`, is decided (2026-10-06) and arrives with the Drive after the first mission. Its design ruling is avel-web's.

| Work | Library | System |
|---|---|---|
| Home `/` | Agent templates `/catalog/agents` — read-only | Activity `/activity` |
| Missions `/missions` | Skills `/catalog/skills` | Repositories `/settings/repositories` |
| Clients `/clients` | Sources `/catalog/sources` | Connections `/settings/connections` |
| | Presets `/presets` | Account `/settings/account` |
| | Playbooks `/playbooks` | |

*Stale, recorded 2026-10-20, not yet reconciled:* this table no longer matches avel-web's sidebar (`avel-web/src/shell/nav.ts`), which also has twelve links. There the groups are Work, Library and Control; Presets is labelled Teams; Templates and Drive are links; Sources is not; Agents and Settings are parents of their links; and Playbooks is a section of Teams (ruling 51), not a link. Which rulings changed it, and whether this table follows nav.ts, is open for J.

- **Agent templates** is read-only. Identity files are generated from roles, so the page shows each generated version and its hash.
- Proposals, Findings, Roles and Templates are not in the sidebar. Decided 2026-10-06, except Templates:
  - **Proposals:** the top-bar inbox, and proposal cards in the Canon chat. They arrive with module 14, after the first mission; until then the Canon chat renders not-built.
  - **Roles:** the per-family table of what agents may do (`ROLES.md`) is shown read-only on Agent templates, `/catalog/agents`.
  - **Findings:** in mission detail, where the operator confirms or dismisses the `open` Findings that judges write. The finding routes land with module 9.
  - **Templates:** open; see *Open* below.
- No Runs page until two missions run at once.
- **The Drive** (decided 2026-10-06, built after the first mission): a client's and its engagements' files appear as Notes and Files tabs on the client's panel in `/clients`. General docs live on `/drive`.

**Every link exists in the route tree, and every route in the tree is reachable from somewhere.** A sidebar link to a missing page, or a page nothing links to, is a defect the first build's navigation tests were written to catch; keep them.

## The tree

```
/                                       → redirect /missions
/login                             📱   unauthenticated

/clients                           🖥   client list
/clients/new                       🖥   onboarding wizard
/clients/:id                       🖥   client detail, engagements, spend
/clients/:id/engagements/new       🖥   new engagement

/intake/:id                        📱   Canon's proposal — review and approve

/missions                          📱   list
/missions/new                      📱   capture — offline
/missions/:id                      📱   overview
/missions/:id/brief                📱   capture — offline
/missions/:id/roster               🖥   THE LOADOUT SCREEN
/missions/:id/playbook             🖥   resolved process, read-only
/missions/:id/exports              📱   history
/missions/:id/exports/new          🖥   THE PRE-FLIGHT SCREEN
/missions/:id/exports/:exportId    ✅   status + delivery detail
/missions/:id/activity             📱   mission-scoped log

/catalog/agents                    🖥   templates
/catalog/agents/:slug              🖥   template detail
/catalog/skills                    🖥   skill library
/catalog/skills/:slug              🖥   skill detail
/catalog/sources                   🖥   SkillSource catalog

/presets                           🖥   saved squads
/presets/:id                       🖥   preset editor

/presets?section=playbooks         🖥   process per mission type (avel-web ruling 51, 2026-10-20)
/presets/playbooks/:missionType    🖥   playbook builder

/settings/repositories             🖥   RepoPolicy
/settings/connections              🖥   Connection lifecycle
/settings/account                  📱   session, sign out

/activity                          📱   global log

/drive                             🖥   general docs (after the first mission)
```

**Nothing at `/knowledge`.** KnowledgeEntry has no write path in V1 and an empty vault; a screen over zero rows is a screen that teaches you nothing. Deferred with the write-back.

---

## Contract gaps this map surfaces

`src/contract/` holds route groups for clients, engagements, missions, missionPlans, activity, intakes, connections, agentTemplates, skills, skillSources, roster, presets and playbooks (checked 2026-10-10). Export and repo-policy arrive with modules 10 and 11. Exact routes: `DATA-CONTRACTS-V2.md`, *Built so far*.

| Gap | Needed by | Severity |
|---|---|---|
| ~~No `client`, `engagement`, or `intake` route groups.~~ Resolved: built with modules 0 and 1. | `/clients/*`, `/intake/:id` | — |
| ~~No `preset` route group.~~ Resolved 2026-10-10: `presets` list, get, create, update; applying is `roster.applyPreset`. | `/presets`, `/presets/:id`, and the loadout screen's "apply preset" | — |
| ~~No `skillSource` procedures.~~ Resolved: built with module 4. | `/catalog/sources` | — |
| `export.preview` | pre-flight | specced in `BLAST-RADIUS.md`, not yet in the contract |
| `mission.getWithRoster` | loadout | Not built, by decision (2026-10-06): the loadout calls `missions.get` and `roster.list` |
| `skill.resolveTiers` | loadout | Built as the pure function `resolveSkillTiers()` in the contract, not a route |
| `mission.list` → `lastActivity` | mission list | needs one aggregate join to ActivityLog, not an N+1 |

---

## Screens

### `/missions` — list 📱

**Needs:** `mission.list` (paginated, `lastActivity`)
**Empty:** first-run — this is the screen a new operator sees before anything exists. Design it as onboarding, not as a blank table.
**Row:** name (client · mission type · sprint), never the uuid; the id stays reachable through Copy · status · last activity · last export result.
**Note:** `lastActivity` is the known contract/implementation disagreement. Ship the column only when the join exists; do not substitute `updatedAt` — that is row-edit time, not audited activity.

### `/missions/new` and `/missions/:id/brief` — capture 📱 offline

The Phase Zero surface, and the only offline-capable one.

**Needs:** `mission.create`, `mission.update`
**Offline scope:** drafts persist locally; sync on reconnect. Nothing else in the app works offline.
**Design for:** one thumb, standing up, poor signal, mid-conversation with a client.
**Conflict rule:** a local draft that lost a race to a server edit surfaces both. Never silently discard the thing typed on a phone.

### `/missions/:id` — overview 📱

Hub. Brief summary · roster summary · playbook in effect · last export state · coherence status.

**Needs:** `missions.get`, `playbooks.getForType` (module 3; `/missions/:id/playbook` uses it too, with the mission's type)
**Rule:** every construction action here is a link, not an inline control — the actions live on desktop routes.

### `/missions/:id/roster` — the loadout screen 🖥

**The core interaction.** Assemble the squad, attach the mission's skills, see coherence live.

**Needs:** `missions.get` · `roster.list` · `roster.skills` · `agentTemplates.list` · `skills.list` · `resolveSkillTiers()` · `roster.add` / `update` / `remove` · `roster.applyPreset` · `roster.attachSkill` / `detachSkill` · `presets.list` (router keys as built, 2026-10-06)

**Layout:** three panes — available agents · the roster by wave · coherence and the mission's skills.

**Coherence must be instant.** `computeCoherence(mission, playbook)` is pure — no DB, no IO, no clock. **Put it in `src/contract/`, next to the error union, and let both sides import it.** One implementation, zero round trips, no drift. The server remains authoritative at gate time; the client renders the same function.

**Interactions:** toggle agent active · assign waves · attach and detach the mission's stack and domain skills (tiered: recommended / available / all; each reaches the agents whose roles it is recommended for) · edit `customized_md` · apply a preset (materializes RosterEntries — copy-then-edit, the preset holds no mission state) · save as preset.

**The one hard block:** at least one active agent in the earliest wave the playbook declares. Rendered as a block, not a warning — and it is the only thing on this screen that can prevent export.

### `/missions/:id/exports/new` — the pre-flight screen 🖥

**The screen that carries the product.** Preconditions → gates → verification → blast radius → one button.

Fully specified in **`BLAST-RADIUS.md`**, including the wireframe, all twelve error codes, and the staleness rules. Do not re-derive it here.

**Non-negotiables:** deliver is disabled by state, never by styling · the base SHA and read age are always visible · attested gates are visually distinct from mechanical ones · initiation is desktop-only.

### `/missions/:id/exports/:exportId` — status ✅

Long-running. With mutation testing in the gate, `verifying` can run for an hour.

**Design as a resumable status view keyed on export id** — it must survive a closed tab, a reload, and a phone. Not a modal you have to keep open.

**States:** `pending · rendering · verifying · previewing · previewed · delivering · pr-open · done · failed`
**Shows:** live status · verification results as they land · blast radius · `gate_override` if present (permanently) · PR link · zip download.
**Phone may:** approve a previously computed preview. **Phone may not:** initiate.

### `/clients/new` — onboarding 🖥

Six steps. Canon runs at step 6; everything before it is mechanical.

| Step | What happens | Who |
|---|---|---|
| 1 | Client record — name, contact | Form |
| 2 | Engagement — name, scope, dates | Form |
| 3 | Repository — URL, connect credential | Form + gateway |
| 4 | **Read the repository** — cut, conventions, boundaries | Code |
| 5 | `RepoPolicy` — confirm defaults | Form |
| 6 | Brief — paste call notes, Canon proposes | **Canon** |

### Step 4 in detail — one read, three outputs

The repository is read once and produces three derived results, each shown with the evidence that decided it.

**Cut.** Which boundary is a directory. Show the top-level listing alongside the verdict: *"feature-organised, so one agent per feature."*

**Conventions.** The rules actually in force, extracted rather than invented — layering, testing, naming, import rules, and what enforces them. Every entry displays its evidence: the config file or the sampled sources that demonstrate the pattern.

An entry with `confidence: 'low'` is shown as a gap, not a finding, and **blocks approval**. A repository with three competing patterns has no convention to extract. `unextracted[]` lists what the operator must supply by hand.

**Boundaries.** The natural split, with file counts and, critically, `collides_with` — shared surface that several boundaries touch. A composition root or a shared package appearing here is the signal that the foundations role has work to do before any feature agent dispatches.

The proposed roster is derived from this, not asserted. The operator may merge, split, or override; an override needs written rationale, same as the cut.

**Why this step carries the demo.** Paste a repository URL and AVEL reports the cut, the conventions in use, and the natural feature boundaries — each with the listing that decided it. Twenty seconds, and it explains the entire model without a slide.

**Nothing in step 4 is proposed by a model.** Canon does intake, which is reasoning. Reading a directory tree is pattern matching, and pattern matching is code. A model proposing the cut would reintroduce the exact failure `cut_source: derived` exists to prevent — applying a rule to a decomposition already decided on, with a confident justification attached.

**Step 5 should be conspicuously unhelpful.** A repository with no policy row is treated as no-direct-push, so the empty state is the safe state. Do not nudge toward creating policies. Enabling direct push to a default branch is a deliberate confirmation with a warning, never a toggle.

### `/intake/:id` — Canon's proposal 📱

The approval surface. Canon has produced a structured brief and a list of open questions; nothing is executable until the operator approves.

**Needs:** `intake.get`, `intake.approve`, `intake.reject`, `intake.revise`

**Shows:** the raw source alongside the proposed brief, so the operator can check the interpretation against what was actually said. `open_questions` rendered as blocking items — an approval with unanswered questions should require acknowledging them.

**On approval:** materializes a Mission. The Intake row is retained as provenance.

**Phone-allowed** because reviewing and approving is exactly the shape of work that happens between meetings. Initiation stays on desktop.

### `/catalog/agents`, `/catalog/skills` 🖥

Library management.

**`/catalog/agents` has no identity editor.** Identity files are generated from the roles an agent covers, so the page shows the generated file read-only, with its version history and hashes. Changing an agent means changing a role in `ROLES.md`; a hand edit here would reintroduce the drift generation exists to prevent. `identity_md` and `depth_md` are each capped at 1200 tokens, enforced on the generator's output.

**`/catalog/skills` is where skills are written and reviewed.** Each shows its layer, its type, its status, the roles it is recommended for, and — for capabilities — the tools it grants. The description field shows its length live, since it is loaded into every relevant dispatch. Imported skills arrive as drafts and cannot be attached until approved.

**A badge never claims more enforcement than the running system provides.** A capability is enforced by its room; where no room is enforcing it, the badge says so. A badge that implies enforcement that isn't happening is the product lying about itself. See `SKILLS.md`.

### `/presets/playbooks/:missionType` 🖥

The playbook builder, a page (avel-web ruling 35 amended, 2026-10-10). *Moved 2026-10-20 (avel-web ruling 51, J's direction):* Playbooks is the second section of Teams (`/presets?section=playbooks`), so the builder sits under `/presets` and `/playbooks` no longer exists. It writes through `playbooks.create` and `playbooks.update`, and its Versions tab reads `playbooks.versions`. An edit is refused while a mission of that type is active or halted.


Gates (`mandatory | warn` only) · `waves_applicable` · `deliverable` · `required_fields` · `default_preset_id`.

**Show the consequence of every edit.** Removing phase1 from `waves_applicable` changes what the hard block resolves to. Marking a gate `warn` changes what can ship. This screen edits the rules that constrain the operator, so it should make that visible rather than presenting a form.

### `/settings/repositories` — RepoPolicy 🖥

`allow_direct_push_to_default` defaults **false**; a repo with no row is treated as false.

**The empty state is the correct state.** Do not nudge toward creating policies — safe behavior needs no setup, only the permissive behavior is opt-in. Enabling direct push to a default branch should require a deliberate confirmation, not a toggle.

### `/settings/connections` 🖥

Scope · status · rotation · revocation. **The token is never displayed** — `credential_ref` names where it lives.

**Revocation is a step in engagement close.** Make it a visible, one-click action with a confirmation, not something buried in an edit form. This is the largest real risk surface in the system and the UI should treat it that way.

Surface expiring credentials on the shell, not just here.

### `/activity` 🖥📱

Append-only. Filter by `action` domain, `entity_type`, mission, date. Both are closed vocabularies, so filters are enums — never free-text search over `action`.

---

## The device boundary

One guard, applied by route metadata:

```tsx
export const Route = createFileRoute('/missions/$id/roster')({
  staticData: { device: 'construction' },
})
```

A phone hitting a construction route gets a designed screen — what it is, why it needs a desktop, and a way to send itself the link. Not a redirect, not a blank.

**Same codebase, same auth, same routes. Route split, not app split.**

**The rule that matters:** approving a gated export from mobile is fine. **Initiating an irreversible export from a phone is not** — that requires the desktop pre-flight first, enforced by `previewExportId` being required on `export.create` for `github_push`.

---

## Build order

**Demo-first note.** The pre-flight screen can be built against real data with no backend at all: the golden fixture is a real package, and `gitBlobSha` and `computeBlastRadius` are pure functions that can classify files in a real repository from one API call. That is the actual mechanism running in a browser with no schema, no API, and no export engine. Build it early.

Foundation first — six modules, no product screens until they exist:

1. `contract-client` · 2. `tokens` (extract `cc-palette.html`) · 3. `primitives` + `<Surface>` · 4. `error-map` · 5. `app-shell` · 6. `device-boundary`

Then:

7. `/missions` + `/missions/:id` — the smallest real loop
8. `/catalog/*` — the loadout screen needs content to assemble
9. `/missions/:id/roster` — the core interaction
10. `/missions/:id/exports/*` — the pre-flight screen
11. `/settings/*` · `/presets/*` (Playbooks included, since 2026-10-20) · `/activity`

**Everything is built against contract-derived mocks** until the export engine exists. That is the point of the contract being an artifact — and it means the frontend is not blocked, but also that no screen is verified against real data until a mission runs.

---

## Open

| Question | Blocking? |
|---|---|
| `preset` route group missing from the contract | **Yes — blocks the loadout screen's preset flow** |
| Does `computeCoherence` ship in `src/contract/`? | **Yes — decide before the loadout screen** |
| TanStack Start vs. Vite + TanStack Router | No — the route tree is identical either way |
| Mobile approve: full pre-flight read-only, or a condensed summary? | Before `/exports/:exportId` |
| `MOBILE-PWA.md` does not exist | **Yes — blocks all 📱 offline work** |
| Where Templates surface. Proposals, Findings and Roles were placed on 2026-10-06 (*The sidebar*). Suggested: its own Catalog page once template-booking exists | Before the first Templates screen |
