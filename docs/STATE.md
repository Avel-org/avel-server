# AVEL Command Center — State

*The single source of truth for build status, counts, and gaps. **No other document may state build status, entity counts, or agent counts.** They link here.*

**Last updated:** 2026-10-06

---

## One-line status

**Rebuilding against `COMMAND-CENTER.md`. Module 0 (Foundation) is built.** The previous build, at `github.com/Javaris500/avelcc`, is a reference to read, never a source to copy; its lessons live in the docs. **Zero missions have run end to end through the platform.**

---

## Counts

| Thing | Count |
|---|---|
| Command Center modules (`COMMAND-CENTER.md`) | **15**, numbered 0–14 |
| Core entities | **19** + SkillSource (supporting catalog): 18 built, and `Dispatch` specced 2026-10-06 for module 6. Every one has a field list (`DATA-CONTRACTS-V2.md`). |
| Database tables built | **24** — the 18 entities, SkillSource, `role_skills`, `mission_skills`, and Better Auth's `session`, `account` and `verification`. Migrations `0000`–`0013` applied. |
| Error codes in `src/contract/shared/errors.ts` | **22** — 6 generic · `NOT_OPERATOR` · 2 route · 12 `BLAST-RADIUS.md` · `GITHUB_REJECTED` |
| Roles (`ROLES.md`) | **35** — 23 model · 11 code · 1 human |
| Model agents — target, horizontal cut (`ROSTER-V2.md`) | **13** in every mission (A 3 · B 5 · C 3 · D 2), plus up to 2: concurrency when required, incident on demand |
| Model agents — `template-booking` (`TEMPLATE-BOOKING.md`) | **10**, plus the operator |
| Orchestrator | **1** — Axis, the human |
| Roster runs so far | **2**: one feature agent (Mission 002) and one verification agent, each once |
| Agent identity files | **0** — to be generated from `ROLES.md`, not hand-written. The 19 hand-written v1 files are superseded. |

Honest external framing: *a role catalog of 35 jobs, assigned to a small set of named model agents per project, plus one human operator and a set of code functions.* Never "25 AI agents," and never "18 build agents" — both describe rosters that no longer exist. <!--allow-stale-->

---

## Module status

Legend: ⬜ not started · ◐ partly built · ✅ built.

| # | Module | State |
|---|---|---|
| 0 | Foundation | ✅ |
| 1 | Intake | ⬜ |
| 2 | Repo read | ⬜ |
| 3 | Mission planner | ⬜ |
| 4 | Roles and roster | ⬜ |
| 5 | Identity generator | ⬜ |
| 6 | Dispatch and runner | ⬜ |
| 7 | Sandbox rooms | ⬜ |
| 8 | Completion records | ⬜ |
| 9 | The gate | ⬜ |
| 10 | Render | ⬜ |
| 11 | Delivery | ⬜ |
| 12 | Knowledge and metrics | ⬜ |
| 13 | Surfaces | ⬜ |
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
- **A dev preview mode exists** (`AVEL_DEV_PREVIEW=1`): read-only access with no session, for viewing seeded data locally before the GitHub OAuth App is set up. It refuses to start outside a `_dev` database, outside localhost, or in production. It is a deliberate hole in the auth wall, guarded by those three startup checks; remove the flag once real sign-in is configured.
- **Canon chat (decided 2026-10-06) has no proposal kind yet.** `Proposal.kind` and the `proposal_kind` enum hold `next_module · calibration · post_delivery · intake_questions`. Chat suggestions need a kind, added in the same change as the code that writes them, not before. Proposals (module 14) come after the first mission (decided 2026-10-06), so the Canon chat stays not built until then.
- **Agents cannot call the API yet.** The design was decided on 2026-10-06 and is specced: Dispatch, the firm roster, and a dispatch-scoped token (`DECISIONS-V2.md`, *Decided 2026-10-06: agents call the API*). The per-family table of what agents may do is specced too (`ROLES.md`, 2026-10-06). Unbuilt: all four, `Intake.drafted_by_dispatch_id`, and the error codes `DISPATCH_CLOSED` and `AGENT_NOT_PERMITTED`. Also unbuilt: the runner's `system` credential, and the idempotency keys on agent-reachable creates (`DATA-CONTRACTS-V2.md`, *Idempotency*). Until then, every route accepts only the operator. It is built before the first mission, the first of two exceptions to the 2026-10-05 schema freeze (decided 2026-10-06).
- **Missions do not record their template.** `Mission.template_ref` and `template_version` are specced for module 3, before the first mission, the second freeze exception (decided 2026-10-06). The format of `template_version` is unspecified.
- **No activity read route exists.** Decided 2026-10-06: one is added now, read-only, for the Activity page.
- **Finding has no reference to the dispatch that wrote it.** Both the per-dispatch idempotency key and attributing a judge's finding to its run need one. Adding it would be a fourth new foreign key, outside the freeze exceptions. For the operator to decide before module 9 builds the finding routes.
- **Whether an Export replay returns the original** like agent creates do is unspecified. Export's spec still answers `409 IDEMPOTENCY_REPLAY`. Decide before module 10.
- **No delete routes exist.** Soft delete is exercised only in tests.
- **The `auth.signed_in` row is written in its own transaction, before Better Auth inserts the session.** If that insert then fails, a log row remains for a session that does not exist. Sign-in fails closed when the log write fails.
- **Better Auth stamps its own times.** Its tables have snake_case columns, uuid ids from the injected `IdGenerator`, and no database defaults, but `created_at`, `updated_at` and `expires_at` come from Better Auth's clock, not the injected `Clock` (`src/auth/index.ts`). This is an exception to `CLAUDE.md`'s determinism rule, recorded rather than fixed.
- **Client-side contract conformance is unspecified.** See `CLIENT-CONTRACT-CONFORMANCE.md` — the artifact a client repository must carry has no defined format, and the top-priority gate cannot be built until it does.

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

- No skill library exists. The design is settled in `SKILLS.md`; the first role skills for `template-booking`'s roles come before module 5 generates identity files.

### Unowned

- **No sandbox exists.** Agents run with full user privileges on a machine holding the GitHub credential, with every client's code on one filesystem. `SANDBOX.md` Tier 0 fixes this at zero cost.
- **`cc-palette.html` is not in this repository.** `ROUTES.md` references it as the source of the tokens. It needs an owner doc and a location, or the reference goes.
- **`avel-gates-diagram.html` and `avel-cc-shell.html` are not in this repository.** They are in the operator's frontend bundle, under `design/` (operator, 2026-10-05). `DOC-OWNERSHIP.md`, `STUDY-GUIDE.md` and `DAY-ONE-FRONTEND.md` reference them.
- **No mobile doc is written, and none is needed now.** Offline capture is deferred (`DECISIONS-V2.md`, *Decided 2026-10-05*). `DAY-ONE-FRONTEND.md` still lists the old mobile doc as a blocker; that file belongs to another session.
- **Two figures in `WHY-AVEL-EXISTS.md` are not fully verified.** See that doc's *Sources*.

---

## The parallel-session problem

**`DATA-CONTRACTS-V2.md` in this repository is the canonical data model** (decided 2026-10-05). An earlier copy kept outside the repo drifted ahead of the doc set three times, and each reconciliation surfaced real conflicts. There is now one copy.

**Re-read it before any schema work.** Parallel sessions still edit it.

`scripts/check-docs.sh` now catches the mechanical half of this automatically. It does not catch semantic drift.

---

## What has to happen next

**One mission, end to end, measured.** Not the frontend, not more architecture. Every decision in `DECISIONS-V2.md` is a hypothesis until a real client project passes through the whole pipeline — manually in places if necessary — and produces a number.
