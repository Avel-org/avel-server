# AVEL Command Center — State

*The single source of truth for build status, counts, and gaps. **No other document may state build status, entity counts, or agent counts.** They link here.*

**Last updated:** 2026-10-21

---

## One-line status

**Rebuilding against `COMMAND-CENTER.md`. Module 0 (Foundation) is built.** The previous build, at `github.com/Javaris500/avelcc`, is a reference to read, never a source to copy; its lessons live in the docs. **Zero client missions have run end to end through the platform.** On 2026-10-21 a live smoke took one mission from intake to gate on the real Agent SDK, in a rolled-back transaction, on the dev template fixture (`tests/smoke/first-mission-live.test.ts`, `COST-LOG.md`). Nothing has rendered or delivered.

---

## Counts

| Thing | Count |
|---|---|
| Command Center modules (`COMMAND-CENTER.md`) | **15**, numbered 0–14 |
| Core entities | **20** + SkillSource (supporting catalog): all 20 built (`Dispatch` with module 6; `File` on 2026-10-19, moved before the first mission for Canon). Plus Canon's **5** supporting entities: CanonSession, CanonMessage, CanonQuestion, ClientMemory (built 2026-10-19), and CanonStep (built 2026-10-20). Every one has a field list (`DATA-CONTRACTS-V2.md`). |
| Database tables built | **34**: the 26 of 2026-10-14, plus `file`, `intake_files`, `canon_session`, `canon_message`, `canon_question`, `client_memory`, `canon_step` and `dispatch_step` (2026-10-20). Migrations `0000`–`0040` applied on `avel_dev` (41), counted against `information_schema` on 2026-10-19. `0041` (2026-10-20) adds the `mission.spend_ceiling_set` action. `0042` (Canon chat), `0043` (its activity actions) and `0044` (`dispatch_step`) follow. `0045` (2026-10-21) adds `turn_prompt_seq` and `turn_prompt_sha256` to `canon_session`. `avel_dev` was re-created and re-seeded on 2026-10-21 and holds all 46, counted against `drizzle.__drizzle_migrations`, with 34 tables. |
| Tables under row-level security | **7**, all enabled and forced: `file`, `intake_files` and the five Canon tables (counted on `avel_dev` 2026-10-20). The other 26 are not, by J's ruling (2026-10-19). An open Canon session's rows have no client and are visible only to an unscoped transaction. |
| SECURITY DEFINER functions | **4**: the three Canon client-id lookups, and `canon_session_index()`, the session list's summaries (J, 2026-10-20). A test asserts there are no others. |
| Error codes in `src/contract/shared/errors.ts` | **24** — 6 generic · `NOT_OPERATOR` · 2 route · 12 `BLAST-RADIUS.md` · `GITHUB_REJECTED` · `DISPATCH_CLOSED` · `AGENT_NOT_PERMITTED` (counted in the file 2026-10-19; unchanged since 2026-10-14) |
| Precondition reasons in the same file | **67** (counted 2026-10-20): the 64 of 2026-10-19 plus `spend_ceiling_not_raised`, `canon_mode_unavailable` and `canon_session_final` |
| Roles (`ROLES.md`) | **35** — 23 model · 11 code · 1 human |
| Model agents — target, horizontal cut (`ROSTER-V2.md`) | **13** in every mission (A 3 · B 5 · C 3 · D 2), plus up to 2: concurrency when required, incident on demand |
| Model agents — `template-booking` (`TEMPLATE-BOOKING.md`) | **10**, plus the operator |
| Orchestrator | **1** — Axis, the human |
| Roster runs so far | **2**: one feature agent (Mission 002) and one verification agent, each once. Separately, **2** smoke dispatches ran on the real harness on 2026-10-14, on a scratch repo in a rolled-back transaction, outside any mission, and **3** on 2026-10-21, each inside a mission built over the API in a rolled-back transaction, on the template-booking dev fixture (`COST-LOG.md`) |
| Agent identity files | **0** run in a mission. The generator is built (module 5): identities come from the roles in `ROLES.md`, never hand-written. The dev seed holds 17 versions: one for each of its 15 model agents, a second for one of them, and one for Canon (2026-10-19). The 19 hand-written v1 files are superseded. |

Honest external framing: *a role catalog of 35 jobs, assigned to a small set of named model agents per project, plus one human operator and a set of code functions.* Never "25 AI agents," and never "18 build agents" — both describe rosters that no longer exist. <!--allow-stale-->

---

## Module status

Legend: ⬜ not started · ◐ partly built · ✅ built.

| # | Module | State |
|---|---|---|
| 0 | Foundation | ✅ |
| 1 | Intake | ✅ The intake itself. Canon, the briefer, is ◐ (2026-10-19): sessions, messages, the question pop-up, client memory, the roster recommendation, the knowledge prep with citations, and the model turn behind `AVEL_HARNESS=agent-sdk` are built and tested with a fake model. A real model ran Canon turns on 2026-10-21 in the live smoke; the first failed before any call, because nothing created the SDK's config folder (fixed in both SDK paths) Approval refuses `intake_questions_open` while a question is open |
| 2 | Repo read | ✅ GitHub only; Next.js app-router layouts return no cut |
| 3 | Mission planner | ◐ plan read and write with its mechanical check, `template_ref`/`template_version` (a templated mission's type must match), template reads from the repositories (dev fixture until the repositories exist), playbook reads and writes with versions, `computeCoherence` (the first-wave block and the vertical-cut roles warning) |
| 4 | Roles and roster | ✅ catalog reads and writes, roster reads and writes, apply-preset, mission skills, preset create and update, `accessFor` (derived access, not enforced until module 7), per-entry access overrides, agent descriptions. Agent template writes are built in module 5 |
| 5 | Identity generator | ✅ role definitions in server code (`src/lib/roles.ts`); the generator (`src/lib/identity.ts`: identity.md and depth.md from roles, mount and approved role skills; 1200-token cap per file; sha over identity, NUL, depth); `agent_identity_version`, append-only; version reads by number, sha or `slug@vN`; operator regenerate; template edits (`PATCH`: title, description, roles, waves, paths) with the merge-rule refusals; contract display labels for roles, teams, runners, sides and kinds; the dev seed's corrected roster of 15 builders plus the operator. Not yet delivered to an agent: that is dispatch (module 6) |
| 6 | Dispatch and runner | 🟨 mission start and halt with readiness; dispatches queued, started, halted and read; the runner core (`src/runner/`): budget at the soft and hard ceilings, the mission spend ceiling and the wall clock, system-filed reports for halted and failed dispatches, and a sweep for over-limit runs. Step 9 (`STEP-9-PLAN.md`, 2026-10-14): plan `reads` and `checks` with `checkPlan` rule 5 and `requirement_unchecked`; the four-part brief rendered and frozen with its hash at start, and served at `GET /api/dispatches/:id/brief`; `AgentSdkHarness` on the Claude Agent SDK `0.3.296`, behind `AVEL_HARNESS=agent-sdk`, with the runner ticking in the server process; `claude-sonnet-5-5` priced at `prices-2026-10-14`. The FakeHarness stays the default and the test harness. 2026-10-21: usage still queued at a close, and usage that arrives after it, is counted (runner H1); the runner loop and server wiring are tested (`src/runner/wiring.ts`); shutdown on SIGINT and SIGTERM; the interval variables refuse anything but a positive whole number. Unbuilt: the CLI fallback (D1) |
| 7 | Sandbox rooms | 🟨 Tier 0, worktree-only (`src/rooms/`): one git worktree per dispatch, opened at start from a local clone under `AVEL_SOURCES_DIR` (since 2026-10-21 by origin: an internal mission's template at its pin, a client mission's one approved intake's repo at the commit read even when it pins a template; `source_unavailable` otherwise), kept after close until released. File tools only (read, write, edit, list), with path, symlink, `.git` and Windows-alias refusals; since 2026-10-21 also a link whose real path lands in `.git`, and an 8.3 short name such as `GIT~1` (reproduced on NTFS); the write check is `[attestation]`. The exit checkpoint (changed files against the writable globs, `writes_outside_mount`) is built and tested, and step 8 calls it. No container and no running room. The real harness calls the file tools for the agent (step 9d), and ran in a room on the dev fixture on 2026-10-21; nothing calls release yet |
| 8 | Completion records | ✅ the agent's own report (`POST /api/agent/report`, complete or blocked) after the room's exit checkpoint (`writes_outside_mount` keeps the dispatch running). The server computes tokens, hashes, model, artifacts written and files touched from the dispatch and the room, and records edge mismatches against each path's latest producer on the mission without refusing. The report and the dispatch close in one transaction, and the token dies. System-filed reports for halted and failed dispatches come from the runner (module 6). A report's status equals its dispatch's by construction, checked by tests, not by a database constraint |
| 9 | The gate | ◐ (2026-10-19) `decide()` (`src/lib/gate/`, `DECIDE_VERSION` 1) with property tests; producers that need no runner (spec-check, `file_exists`, the test-file checkpoint, protected paths, judge coverage); `GATE_CONFIG` v1; the receipt (canonical JSON and its SHA-256, unsigned); dispatch commits at close and the integration commit; `POST /api/missions/:id/gate` with run reads; finding triage (list, confirm, dismiss). The spec check reports on `qa` (J, 2026-10-21), and the seeded Booking playbook lists no `phase1-close`. On branch `fe-pending`, not `main`: `assurance` (`verified` or `not_fully_checked`), `DECIDE_VERSION` 2. Unbuilt: test, typecheck and command checks (no runner, so they are degraded warns), prior findings (a Finding holds no executable check), mutation, permissions, signing, the GateRun table |
| 10 | Render | ⬜ |
| 11 | Delivery | ⬜ |
| 12 | Knowledge and metrics | ⬜ |
| 13 | Surfaces | ◐ read routes for missions and activity |
| 14 | Proposals | ⬜ |

**Module 0, built:** a Hono and ts-rest server with one route, `GET /api/health`, wrapped in the success envelope. The error vocabulary: one union of 21 codes (counted in the file on 2026-10-05; `GITHUB_REJECTED` was added after the union of 20 was first built), the success and error envelopes, cursor pagination, error middleware, and a request id on every response. Time and identifiers are injected through `src/lib/clock.ts` and `src/lib/ids.ts`, and `scripts/check-determinism.sh` enforces it. The database pipeline: a lazy client, `drizzle-zod`, migration 0000 enabling pgvector, column helpers with no database defaults, `live()`, and `withTx`. CI runs the docs check, the determinism check, typecheck, lint, and tests against `pgvector/pgvector:pg17`, one of them over a real node socket.

**Module 0, schema built (2026-10-05):** 24 tables across migrations `0000`–`0008`, read from `drizzle/*.sql` and `src/db/schema/*.ts` and matched to `DATA-CONTRACTS-V2.md`. This includes the ActivityLog append-only triggers (`UPDATE`, `DELETE`, `TRUNCATE`), the actor CHECKs, `Finding`'s dismissed-reason CHECK, `mission_skills.source`, the flat Export gate-override columns, and `package_sha256` / `package_hash_version`. Better Auth is wired in `src/auth/` with the GitHub provider and the operator allowlist. Status lists come from `src/contract/shared/status.ts`.

**Module 0, routes and sign-in built (2026-10-05):** migrations `0009` (Mission engagement follows origin) and `0010` (`connection.revoked`). Every `/api/*` route except `/api/health` and `/api/auth/*` requires an allowlisted operator (401 before 404; 403 off the allowlist). Sign-in is proven end to end on the real tables, with GitHub mocked. Sessions slide, and the refreshed cookie reaches the browser. `clients` (list, get, create, update) and `engagements` (list, get, create, update, close) are built. Close revokes the engagement's live connections in the same transaction. A client cannot be closed while it has an active engagement. Both rules hold under concurrent transactions, proven on a throwaway database. CORS is limited to `AVEL_WEB_ORIGINS`, and sign-in POSTs need a trusted Origin. Tests migrate an empty database first, so CI starts clean. 161 tests, green on consecutive runs and on an empty database. A code review of `src/`, `tests/` and `drizzle/` found two defects, a session cookie that never slid and a forged cursor that answered 500. Both are fixed and tested.

**The previous build is evidence, not code.** It produced the export engine design, the four day-one defects that passed a build, and Mission 002's findings — all recorded in the docs. None of its code is assumed to exist in the rebuild.

---

## Gaps

### Blocking

- **`[attestation]` until a mechanism exists** (`DATA-CONTRACTS-V2.md`):
  - `RosterEntry.estimated_tokens` and its two ceilings are nullable. "Required before dispatch" holds only by convention until a dispatch entity can carry a NOT NULL. `Dispatch` is specced (2026-10-06) and closes this when module 6 builds it.
  - `role_skills` holds only `role`-layer skills, and `mission_skills` only `stack` and `domain`. No trigger enforces either.
- **The API test harness runs the app on one rolled-back transaction**, so a handler that wrote through `deps.db()` instead of its own transaction would not be caught by the atomicity tests. `logActivity` accepts only a `Tx`, which covers the log rows but not the mutation writes.
- **A dev preview mode exists** (`AVEL_DEV_PREVIEW=1`): read-only access with no session, for viewing seeded data locally before the GitHub OAuth App is set up. It refuses to start outside a `_dev` database, outside localhost, or in production. It is a deliberate hole in the auth wall, guarded by those three startup checks. Real GitHub sign-in was configured in dev on 2026-10-14. Its removal, with `signInDisabled`, is built on branch `fe-pending` (2026-10-21) and waits on avel-web's two test expectations; on `main` it is still on.
- **Canon's suggestions have no proposal kind yet.** *2026-10-19: Canon's briefing is built as its own entities, not as proposals. This item now covers only suggestions outside a briefing.* `Proposal.kind` and the `proposal_kind` enum hold `next_module · calibration · post_delivery · intake_questions`. Chat suggestions need a kind, added in the same change as the code that writes them, not before. Proposals (module 14) come after the first mission (decided 2026-10-06), so the Canon chat stays not built until then.
- **Agents can call the API, narrowly** (module 6, 2026-10-13). One middleware resolves the operator, an agent (by its running dispatch's token) and the runner (by its credential). The per-family table is built from `ROLES.md`, with Operate and Firm still refusing. Two agent routes exist: read its own dispatch, and, for judges, file an open Finding (`Finding.reported_by_dispatch_id`, with per-dispatch idempotency keys). Dispatch start issues the token (2026-10-13) and only the harness holds it. *The firm roster and `Intake.drafted_by_dispatch_id` were withdrawn on 2026-10-19: Canon is not a dispatch (`DECISIONS-V2.md`).* Built before the first mission, the first of two exceptions to the 2026-10-05 schema freeze (decided 2026-10-06).
- **The preset "Used by" read scans ActivityLog.** `GET /api/presets/:id/applications` filters on `action` and `payload->>'presetId'`, which no index serves. Fine at today's volume; an expression index is a migration.
- **One approved intake per mission is assumed, not enforced.** The plan route reads the approving Intake by `mission_id`. Approval mints the mission id, so it is 1:1 today, but `intake.mission_id` has no unique index. Adding one is a schema change under the freeze.
- **The coherence disjointness warning is deferred** (decided 2026-10-10). `writable_paths` has no exclusion form, so the canonical vertical layout, where feature agents exclude test files, cannot be expressed and would always warn. It waits until exclusions are designed, after the first mission. A human's foundations entry will be exempt.
- **avel-web still consumes the contract through a live `link:`** to a sibling checkout, which its CI cannot resolve. Decided 2026-10-06: it moves to a git dependency pinned to an avel-server commit. Both repos are private, so avel-web's CI needs a read token for avel-server, which the operator creates. The pin can point only at a pushed commit. `CLAUDE.md` still describes the live link; it changes when the pin lands.
- **No delete routes exist.** Soft delete is exercised only in tests.
- **The `auth.signed_in` row is written in its own transaction, after Better Auth commits the session** (2026-10-21). A failed session insert leaves no log row. If the log write fails, the session is deleted and sign-in fails with no cookie; if that delete also fails, a session row with no cookie remains.
- **Request bodies are capped at 2 MiB** on `/api/*` (2026-10-21), 400 `VALIDATION_FAILED`; the upload route keeps its own cap. A refusal answers before the body is drained, so a keep-alive client reusing that socket gets ECONNRESET.
- **Firm roles are refused at template edit, mission start, dispatch create and dispatch start** (`template_not_rosterable`, 2026-10-21). Readiness does not report it, so readiness can say ready while start refuses. Roster add reads the template without a lock, so it can race a template edit; the start checks catch the result.
- **A gate pass can run zero tests** on `main`: a degraded check only warns. The `not_fully_checked` assurance that marks it is on `fe-pending`.
- **The real harness, as built 2026-10-14** (`STEP-9-PLAN.md`):
  - **The CLI fallback (D1) is not built.** When the SDK cannot start or throws, the dispatch fails with a system-filed report.
  - **Most late tokens are counted** (2026-10-21): usage queued at a close, a message mid-stream, and usage that arrives after the close, which can take the mission to its ceiling. Not counted: the SDK's end-of-run totals after an abort (they never arrive), and a call aborted before its `message_start`. A report keeps its tokens as filed, so `dispatch.tokens_used` can exceed `actual_tokens`. The per-message count has not been cross-checked against the SDK's totals on a live run.
  - **The runner loop and the server wiring are tested** (2026-10-21), but not the process boot of `src/index.ts` or real signal delivery, which Windows cannot send to a child the way a handler sees it.
  - **The agent's process runs on the host as the operator's user.** Isolation is the tool list (seven AVEL tools, every built-in tool removed, everything else denied by a hook) and a minimal environment, not an OS boundary. `[attestation]` until a container provider exists.
  - **On Windows, the SDK's child process holds the room's folder for a moment after a stop,** so an immediate delete fails with EPERM. Rooms are kept after close anyway.
  - **Dev dispatches open on a real commit** (2026-10-21): `pnpm dev:sources` builds the template-booking fixture under `AVEL_SOURCES_DIR`, the same on every machine, at `DEV_BOOKING_SHA`. It is a stand-in, not the template in `TEMPLATE-BOOKING.md`. Only internal missions open on it: the seed's client missions pin template-booking but have no approved intake, so a start on one (the queued dispatch on `halvorsen-pike/billing` sprint 2) refuses `source_unavailable` at `["intake"]`.
  - **The gate does not run the brief's checks.** Module 9 runs them; while the Docker running room is on hold, only `file_exists` checks can run.
- **Better Auth stamps its own times.** Its tables have snake_case columns, uuid ids from the injected `IdGenerator`, and no database defaults, but `created_at`, `updated_at` and `expires_at` come from Better Auth's clock, not the injected `Clock` (`src/auth/index.ts`). This is an exception to `CLAUDE.md`'s determinism rule, recorded rather than fixed.
- **The first-mission test found two gaps** (`tests/api/first-mission.test.ts`, 2026-10-21): no route creates an agent template, so the test inserts one; and nothing checked that the repository an intake read is the one the room opens (there a client repository was read and the template opened). The second is closed: a client mission's rooms and gate base now come from its intake's read, and the test's client clone is at the commit its intake reads.
- **Tests time out under load.** With three sessions running the suite on one database, `tests/api/dispatch-rooms.test.ts`, `tests/api/runner.test.ts`, `tests/api/preview.test.ts` and `tests/db/activity.test.ts` each timed out once and passed alone.
- **Client-side contract conformance is unspecified.** See `CLIENT-CONTRACT-CONFORMANCE.md` — the artifact a client repository must carry has no defined format, and the top-priority gate cannot be built until it does.

### Built 2026-10-19, and what is not proven

Three backend sessions built this in one day (`DECISIONS-V2.md`, *Decided 2026-10-19*). Nothing below has run in a mission.

- **The runtime role** `[built]`. The server connects as `avel_app` (`AVEL_APP_DATABASE_URL`), never the owner. `DATABASE_URL` stays the owner, for migrations, the seed and tests. The server refuses to start without the variable, as the owner's login, on another database, or when the role is a superuser, BYPASSRLS, or a member of either or of an RLS table's owner (`src/db/runtime.ts`).
- **The client scope** `[built]`. `withClientScope` sets `avel.client_id` for one transaction and takes only a branded `ClientId` from a server-side lookup (`src/db/client-id.ts`). Policies read it through `avel_client_scope()`.
- **The Drive** `[built]`: `File`, `intake_files`, a blob gateway with keys per client, upload, download (always an attachment), purge (bytes destroyed, row kept) and the file list. The 10 MB cap is `[hypothesis]`.
- **Canon** `[built]`: its four tables, 16 routes under one client's scope each, the dev-seed template (roles `intake`, `strategy`) with a generated identity, and the model turn (`src/runner/canon/`) on its own 3-second tick. The tick always runs (2026-10-20): the real model behind `AVEL_HARNESS=agent-sdk`, otherwise `offlineCanonModel`, which answers every turn with a fixed "no model is connected" reply. Before that, the tick ran only with the real model, so without it a posted message left its session mid-turn for good. The turn sweep's 10 minutes is `[hypothesis]`.
- **Canon chat, slices 1 to 4 of 4** `[built]` 2026-10-20 (*Decided 2026-10-20: Canon chat*). Open sessions with no client, client sessions with or without an engagement and an intake, modes on sessions and messages, titles, reopen, archive, the list across clients (`GET /api/canon-sessions`), and the `canon_step` table with its read route. Draft mode needs an intake. Slice 3: fetch mode's one read tool (`src/runner/canon/fetch.ts`, nine entities, no client text), whose rows come back as a table or a card on the reply's `parts`; the turn writes its steps as it runs (reasoning summaries, text in chunks of 400 characters, each tool call and result); Canon names an untitled session with `name_session`; and a prompt per mode and scope (instructions version 2). The stuck-turn sweep and the tick cover the open scope. In a client session, fetch reads only that client's rows by a filter in code, tested against seeded rows of another client: `[attestation]`, by J's ruling. Slice 4: a dispatch's run trace, `GET /api/dispatches/:id/steps`, in Canon's `runStep` shape. The harness reports step events (`src/runner/sdk-steps.ts` maps the Agent SDK's text, reasoning, tool calls and results), and the runner writes them to the append-only `dispatch_step` on its tick, so they land every `AVEL_RUNNER_INTERVAL_MS`, not as they happen. A report closes the run, so the harness writes its queued steps first; a tool result that arrives after the report is not written. The FakeHarness writes steps only when scripted. **Not built:** per-step token counts (always null); a test that a halted turn writes no more steps. Whether the Agent SDK passes reasoning summaries through, and whether 400 characters is a good chunk for polling, are `[hypothesis]` until a live run.
- **The gate** `[built]`: see module 9 above.
- **Route tests can run as `avel_app`** (`withApi(fn, { asApp: true })`). Without it a route test runs as the owner, which bypasses row-level security.

Not proven, or not built:
- **The Agent SDK passes search-result blocks and their citations through unchanged** (probes, 2026-10-21). The first live Canon turn still returned none: its brief went out as tool input, which cannot carry citations. Brief sources and a cited reply (instructions version 3) are built on `fe-pending`, where one live run sourced 6 of 6 brief items and resolved 3 of 3 citations. On `main`, Canon is at instructions version 2. Nothing checks that a cited passage supports its requirement.
- **The git half of the gate has passing tests, but its 27 deliberate breaks were never recorded**: the run was killed for low memory. Commits are made with `--no-gpg-sign`, and file modes across platforms are `[attestation]`.
- **A Canon turn runs once** (2026-10-21, migration `0045`): it is claimed with its operator message's seq and prompt hash before the model runs, and a claimed turn never runs again. Turns run one at a time across all clients.
- **Orphan blobs** left when a transaction fails after the bytes are written have no sweep. The upload and purge lock has no concurrency test.
- **`touchesClient` does not show client-memory activity**, which carries no engagement.
- **A protected file that is a symlink is invisible to the protected-paths check**, because tree reads leave symlinks out.
- **Neon** `[unspecified]`: never run there. The role must be created with SQL; a console role joins `neon_superuser`, which bypasses row-level security.
- **`pnpm check` stops at lint on a Windows checkout** with `core.autocrlf=true`; an LF copy lints clean.
- **The full suite ran on 2026-10-19 with two workers**: 1466 passed, 1 skipped, 2 failed in `tests/db/seed.test.ts`, which still expected the seed's counts from before Canon's template. Fixed; that file then passed 7/7.

### Carried from the previous build

A scan of the previous repository found six problems. Each now has a rule that prevents it in the rebuild.

| Found | Prevented by |
|---|---|
| The README said "no backend, no database and no export engine" over code containing all three | `CLAUDE.md`: a README never states build status |
| No CI and no `test` script, so 469 passing tests ran only when someone remembered | Module 0: CI and `pnpm test` from the first commit |
| Three database tests crashed when no database was present, instead of skipping | `EXPORT-ENGINE.md` §13: tests connect lazily, and CI provides a database |
| The ship decision was never built — the gate module was display components only | Module 9 is a function, `decide(findings)`, before any gate screen |
| The schema reflected the pre-roles design: teams instead of roles, skills joined to agents, no proposals | Module 0 builds from `DATA-CONTRACTS-V2.md` — 18 entities |
| The repository carried its own copy of the docs, which drifted from the doc set | One copy only — the docs live in `avel-server/docs`, and nowhere else |

A seventh surfaced in this doc set while fixing the others: the doc check's capability rule still enforced a decision that had been reversed. It is rewritten, and `CLAUDE.md` rule 6 now requires every check to be proven by failing.

### Agent system flaws

Fourteen known flaws in the agent design, all addressed in the specification and **none closed**, because no mission has yet run under the new specification. Full ledger in `ROSTER-V2.md`, section *Known flaws*. A flaw closes only when a mission runs without reproducing it.

### Content-blocked, not code-blocked

- No skill library exists. The design is settled in `SKILLS.md`. Module 5 writes approved role skills into identities, but only the dev seed's role skills exist; the first real ones for `template-booking`'s roles are still unwritten.

### Unowned

- **No OS-level sandbox exists.** Tier 0 rooms are worktrees (module 7), and the real harness limits the agent to AVEL's file tools, but the agent's process still runs with the operator's user privileges on a machine holding the GitHub credential, with every client's code on one filesystem. `SANDBOX.md` Tier 0's container half is deferred.
- **`cc-palette.html` is not in this repository.** `ROUTES.md` references it as the source of the tokens. It needs an owner doc and a location, or the reference goes.
- **`avel-gates-diagram.html` and `avel-cc-shell.html` are not in this repository.** They are in the operator's frontend bundle, under `design/` (operator, 2026-10-05). `DOC-OWNERSHIP.md`, `STUDY-GUIDE.md` and `DAY-ONE-FRONTEND.md` reference them.
- **No mobile doc is written, and none is needed now.** Offline capture is deferred (`DECISIONS-V2.md`, *Decided 2026-10-05*). `DAY-ONE-FRONTEND.md` still lists the old mobile doc as a blocker; that file belongs to another session.
- **The Platform family has no Owns or Checked-by fields** (`ROLES.md`, *Open questions*). They were deferred to module 4, which is now starting. Module 4's code does not need them, so the doc is what's due.
- **Two figures in `WHY-AVEL-EXISTS.md` are not fully verified.** See that doc's *Sources*.

---

## The parallel-session problem

**`DATA-CONTRACTS-V2.md` in this repository is the canonical data model** (decided 2026-10-05). An earlier copy kept outside the repo drifted ahead of the doc set three times, and each reconciliation surfaced real conflicts. There is now one copy.

**Re-read it before any schema work.** Parallel sessions still edit it.

`scripts/check-docs.sh` now catches the mechanical half of this automatically. It does not catch semantic drift.

---

## What has to happen next

**One mission, end to end, measured.** Not the frontend, not more architecture. Every decision in `DECISIONS-V2.md` is a hypothesis until a real client project passes through the whole pipeline — manually in places if necessary — and produces a number.
