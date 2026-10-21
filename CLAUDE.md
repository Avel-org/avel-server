# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Standing rules for any agent working on AVEL. Read this before anything else.

Everything below comes from a mistake that actually happened on this project. None of it is hypothetical.

---

## Commands

pnpm 10 (pinned in `package.json`, so `corepack enable` picks it up). Node 22 or later; `.nvmrc` and CI use 24.

```bash
pnpm install
cp .env.example .env              # DATABASE_URL, PORT=8787, and the auth vars (see below)
docker compose up -d              # Postgres 17 + pgvector; avel_dev and avel_test
pnpm db:migrate                   # migrate avel_dev (reads .env)
pnpm db:seed                      # deterministic dev data; refuses any database not ending in _dev
pnpm dev                          # tsx watch; http://localhost:8787/api/health

pnpm check                        # exactly what CI runs, in CI's order:
                                  # docs:check, determinism:check, typecheck, lint, test
pnpm test                         # vitest run
pnpm vitest run tests/unit/health.test.ts      # one file
pnpm vitest run -t "fixedClock"                # tests whose name matches
pnpm lint                         # biome check .  (tabs; organize imports on)
pnpm format                       # biome format --write .
pnpm db:generate                  # drizzle-kit generate, from src/db/schema into drizzle/
pnpm db:migrate                   # drizzle-kit migrate, against DATABASE_URL
```

- Database tests use `describe.skipIf(!process.env.DATABASE_URL)` and skip cleanly without one. To run them locally, point them at the test database: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/avel_test pnpm check`. CI runs the same `pgvector/pgvector:pg17` image as a service.
- `pnpm dev` refuses to start without `BETTER_AUTH_SECRET` (32+ chars), `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `AVEL_OPERATOR_GITHUB_IDS` (numeric GitHub user ids, never logins). `BETTER_AUTH_URL` is the **app** origin (`http://localhost:3000` in dev), because avel-web proxies `/api/**` here and the session cookie must be first-party to the app; the GitHub callback is `http://localhost:3000/api/auth/callback/github`. `AVEL_WEB_ORIGINS` is the exact-match CORS list for Tauri origins only.
- **Dev preview:** `AVEL_DEV_PREVIEW=1` in `.env` lets GET and HEAD under `/api/*` through with no session, so the UI can be viewed on seeded data without a GitHub OAuth App. Writes still need a real sign-in, and no user row is invented. It refuses to start unless `NODE_ENV` isn't production, the database name ends in `_dev`, and `BETTER_AUTH_URL` is localhost. With the GitHub vars missing, it starts with sign-in switched off. Every response carries `x-avel-preview: 1`, and `/api/health` reports `preview`. Restart `pnpm dev` after editing `.env`; tsx does not watch it.
- **Dispatch rooms:** `AVEL_SOURCES_DIR` holds the local clones that dispatch rooms are made from (`templates/<slug>`, `repos/<owner>/<repo>`). When it is unset, every dispatch start refuses `source_unavailable`. Rooms are git worktrees under `%LOCALAPPDATA%\avel\rooms\<dispatchId>`, kept after the dispatch closes until something releases them.
- `tests/db/global-setup.ts` migrates `DATABASE_URL` once (under an advisory lock) before any test file runs, so tests work against an empty database, which is what CI starts with.
- `scripts/db-init/` runs only when the `pgdata` volume is first created. `docker compose down -v` wipes both databases and re-runs it.
- The two `check` scripts are bash; on Windows run them from Git Bash. `docs:check` embeds Python that must open docs with `encoding="utf-8"`. Without it, Windows reads them in the locale encoding, the `—` in the `ROLES.md` family headings stops matching, and section 8 reports a false merge-rule failure.
- Migrations are forward-only, one per change. Never edit an applied one. `drizzle-kit` needs Neon's direct (unpooled) connection string, not the pooled one.

## Architecture

This repo is the server half of a two-repo system: `avel-server` and `avel-web`. There is no third repo. Desktop and mobile are Tauri targets inside `avel-web`.

**The contract is the public surface.** `src/contract/index.ts` is a ts-rest router of Zod shapes. It is exported as `avel-server/contract` (`package.json` `exports`). `avel-web` consumes it **live** through `link:../../avel-server/avel-server`, so any change under `src/contract/` reaches avel-web's typecheck immediately. Before changing an existing shape, an error code, or a status list, message the avel-web lead session ("Main FE Session") first, and say so in the first sentence of your response (rule 2). Value lists a client renders (`MISSION_STATUSES`, `EXPORT_STATUSES` in `src/contract/shared/status.ts`) are defined once in the contract, and the database pgEnums are built from them. Route groups arrive with the module that uses them, never ahead of it.

**Request path.** `src/index.ts` builds the app with `systemClock` and `randomIds` and serves it with `@hono/node-server`. `src/app.ts` `createApp(deps)` builds a ts-rest router from the contract and mounts it on Hono at `/api/*` via `fetchRequestHandler`. Middleware order: the dev preview header (only while `AVEL_DEV_PREVIEW` is on), CORS (`AVEL_WEB_ORIGINS` only), request id, the body cap (`src/middleware/body-limit.ts`: 2 MiB, 400 `VALIDATION_FAILED`; the Drive's upload route keeps its own cap), `requireOperator` inside `resolveCaller` (every `/api/*` except `/api/health` and `/api/auth/*`: 401 without a session, 403 if not on the allowlist, and 401 comes before 404 so routes can't be enumerated), the trusted-Origin check on `/api/auth/*`, Better Auth at `/api/auth/*`, then ts-rest. Handlers live in `src/routes/` (`clients.ts`, `engagements.ts` show the pattern) and use `src/routes/shared.ts`: keyset cursors (`created_at desc, id desc`), `toPage`, and a `toWire` mapping from snake_case rows to the camelCase wire. Every mutation and its `logActivity` row (`src/db/activity.ts`, which only accepts a `Tx`) run in one `withTx`. Every list and get uses `live()`. ts-rest `responseValidation` is on, so a handler returning an off-contract body is a 500.

**Every JSON response is an envelope.** Success is `{ success: true, data, meta? }`; failure is `{ success: false, error: { code, message, details?, requestId } }`. Codes are one closed union in `src/contract/shared/errors.ts`. To fail, throw `ApiError(code, message)` from `src/middleware/errors.ts`; its `statusFor` record is keyed on the union, so a new code does not compile until it has a status. Shape mismatches are 400 `VALIDATION_FAILED`; state failures are 422. Unknown routes and wrong methods are 404 `NOT_FOUND`. An unexpected throw is 500 `INTERNAL` with no message or stack sent to the client. `src/middleware/request-id.ts` assigns every request an id from the injected `IdGenerator` and returns it as `x-request-id`. Auth middleware goes after the request id and before the router (marked in `src/app.ts`). Lists use cursor pagination from `src/contract/shared/pagination.ts`.

**Dependencies are passed in, never reached for.** `AppDeps` is `{ clock, ids, logger, auth, db }`, all required. `db` is a function returning an `Executor`: `getDb` in production, an open test transaction in tests. `logger` is pino from `src/lib/logger.ts` (it redacts auth headers). `auth` comes from `createAuth` in `src/auth/`. Unit tests build the app through `tests/unit/support.ts`; API tests use `withApi` in `tests/api/support.ts`, which runs the whole app on one rolled-back transaction and drives the real OAuth sign-in. Each `withApi` call gets its own random 8-hex id prefix (`ns`) and its own allowlisted operator, because test files run in parallel against one database and identical uncommitted primary keys made them block each other. Assert on `harness.ns` and `harness.operator`, never on literal ids. `tests/unit/server.test.ts` also goes through a real socket, because `app.request()` once hid a bug that made every real request answer 500. Add new dependencies (gateways) to `AppDeps` the same way.

**Determinism is enforced by the build.** `scripts/check-determinism.sh` fails on `Date.now(`, `new Date()`, `Math.random(` or `randomUUID(` anywhere in `src/` except `src/lib/clock.ts` and `src/lib/ids.ts`. Take a `Clock` or an `IdGenerator`. Tests use `fixedClock(iso)` and `sequentialIds()`, which yields valid UUIDs (`00000000-0000-4000-8000-000000000001`, ...) so they fit uuid columns. `docs/DEV-TIPS.md` §2 lists the traps the script cannot see: key order, `readdir` order, locale sorting, unordered queries.

**Database.** `src/db/client.ts` `getDb()` connects on first call, never at import. That lazy connection is what lets database tests skip instead of crash. Keep it that way. `closeDb()` resets it for `afterAll`. The schema lives at `src/db/schema/index.ts` and is built from `docs/DATA-CONTRACTS-V2.md` in that doc's migration order. Tables derive Zod schemas via `drizzle-zod`, so one definition serves the table, the contract, and runtime validation. Columns come from `src/db/schema/columns.ts`: a uuid `id` and `created_at`/`updated_at` with **no database defaults**, so the insert type forces an id from `IdGenerator` and times from the clock (`stamp(clock)` on insert, `touch(clock)` on update, `remove(clock)` for soft delete). Every list query filters with `live(table)`. Mutations and their ActivityLog row share one transaction through `withTx` in `src/db/tx.ts`. Column names are explicit snake_case. `drizzle/0000` enables pgvector. Two traps found the hard way. Inside a raw `sql` select-list, Drizzle renders columns unqualified, so a correlated subquery silently binds to the inner table (a client's engagement count always read 0); qualify the identifiers explicitly, and note that `live(t)` cannot be used there. A CHECK like `btrim(x) <> ''` passes when `x` is NULL, because Postgres treats a NULL CHECK as a pass; guard nullable operands with `IS NOT NULL`. A JavaScript `Date` interpolated into a Drizzle `sql` template reaches postgres-js untyped and errors; bind the ISO string and cast it (`${iso}::timestamptz`). drizzle-kit generates a new NOT NULL column as a single `ADD COLUMN ... NOT NULL`, which fails on any table that already has rows; rewrite the unapplied migration to add nullable, backfill, then `SET NOT NULL`, and test it against a database migrated to the previous step with rows in it (`tests/db/export-status-backfill.test.ts`). `ALTER TYPE ... ADD VALUE` runs inside the migration batch's transaction, so no migration in the same batch may use the new value. Better Auth stamps its own timestamps from its own clock, a recorded exception to the determinism rule (`docs/STATE.md`). Do not copy tables from the previous build at `github.com/Javaris500/avelcc`. It is a reference to read, never a source.

**Tests live in `tests/`**, never beside source. `vitest.config.ts` only collects `tests/**/*.test.ts`. `tests/unit/` needs nothing; `tests/db/` and `tests/api/` need `DATABASE_URL`.

**Where the rest is going.** The server grows module by module per `docs/COMMAND-CENTER.md` (modules 0 to 14: intake through gate, render, and delivery). The tool list is in `docs/TECH-STACK.md`; current build state is in `docs/STATE.md` only. `START-HERE.md` maps each kind of task to the two or three docs it needs. Load those, not all of `docs/`.

---

## The thesis, in one line

**AI produces work that looks finished but isn't.** Not wrong answers — missing layers. The model builds exactly what was asked and nothing that was assumed.

Every rule here is a defense against that, including the rules about your own behaviour.

---

## The six rules

### 1 · Verify before you assert

**What happened:** an agent wrote four "check your state" commands pointing at `apps/api/src/db/schema.ts`. That path did not exist. Every command errored, and an errored `grep -c` returns output that reads exactly like "zero tables." A confident, wrong status report was produced and acted on.

**The rule:** before stating a fact about this codebase, read the thing. Not the doc about the thing — the thing.

- Before quoting a file path, `ls` it
- Before quoting a count, count it
- Before saying a doc is current, check its date against the code
- If a tool fails, say the tool failed. Do not interpret an error as a result.

**When you cannot verify, say so.** "I could not read X, so this is from the doc, which may be stale" is a good answer. A confident guess is not.

### 2 · Extend the system, never redefine it

**What happened:** asked to improve the palette, an agent invented a new surface token and silently changed the meaning of existing ones. The brand tokens the landing page depends on were altered without anyone being told.

**The rule:** existing tokens, entity names, and conventions are load-bearing. Add alongside them.

- If something needs a different value, ask whether it needs a different **role** instead. Often the value is right and it is being used at the wrong level.
- If you change a shared definition, say so in the first sentence of your response.
- Never rename or drop a token, entity, or convention that another surface consumes.

### 3 · Report before fixing

If a doc disagrees with the code, or two docs disagree with each other, **write down what you found and stop.**

A doc someone relies on, silently rewritten, is a regression even when the rewrite is better. Where two sources conflict and the canonical one is silent, that is a question for the operator, not a judgment call.

Exception: obvious typos and broken links. Fix those.

### 4 · Do the arithmetic

**What happened, three times:** a roster claimed nineteen agents across teams holding eighteen. A doc said fifteen agents while listing fourteen. A total of twenty-six was stated where the parts summed to twenty-five.

**The rule:** when a document states a count, count the items. When it states a total, add the parts. Both, every time, before you rely on either.

### 5 · Delete the references, not just the thing

**What happened:** an agent was removed from the roster and became a function. Three references to it survived — an edge in the communication graph, a phase count, and a status table in another file.

**The rule:** removing something means grepping for its name across the whole doc set and fixing every hit. Deleting the definition is half the job.

### 6 · Prove a check by watching it fail

**What happened, five times:** a determinism test compared two runs that a locale change moved equally, so it proved nothing on Windows. A roster check counted a role as assigned if its name appeared anywhere, so a row whose agent was `—` passed. A merge-rule check found each template by where the next one began, so the last template was never checked at all. Three database tests said "skip if there is no database" and then connected before the skip applied, so they crashed instead of skipping. And a doc check kept enforcing a decision that had been reversed, passing only because the new wording avoided its phrases.

**The rule:** a check is not proven by passing. It is proven by failing when it should. Before trusting any test, gate, or script, break the thing it guards — one defect at a time — and watch it go red.

- Write the failing case first, or break the code deliberately after
- When a decision changes, find the checks that encoded the old one
- A check that has never failed has never been shown to check anything

---

## Boundaries

**Stay inside your mount.** Every agent has declared writable paths, enforced as filesystem mounts. A write outside them fails the ownership check and the mission does not ship.

**File blockers, do not absorb them.** If a dispatch forbids something you need, write it down with a documented workaround. Do not route around the boundary quietly.

Mission 002 filed three blockers and absorbed zero. That is how it was discovered that all three failures were the operator's, not the agent's. Silent workarounds would have hidden that.

**Testers never modify code under test.** Enforced by the mount, not by discipline. An agent that can edit the code it is testing can make any failing test pass by changing the code instead of fixing the bug.

---

## Evidence

**A green test suite means the code ran.** It does not mean the tests checked anything. A test with no assertions passes every time.

**Never trust a report over an artifact.** If something claims the tests pass, run them. If a doc says the schema is empty, open the schema.

**Security is a layer, not a feature.** Nobody will ask you to add access control. Add it anyway, and assume a model will not.

---

## Writing

- Plain declarative sentences. The project voice is the landing page: *"Built with intent." "Scope doesn't drift if the plan is signed off."*
- No em-dash asides, no "not X but Y" constructions, no marketing adjectives
- Mono for anything a machine produced — hashes, paths, slugs, counts. Sans for prose. Never mixed.
- Every claim carries its status: `[built]` `[specced]` `[hypothesis]` `[attestation]` `[unspecified]`

`[attestation]` matters most. It marks anything enforced by a claim rather than a mechanism, and it is this project's recurring failure mode.

---

## Doc ownership

**One fact, one owner.** A fact restated in two documents will drift. This has happened three times on this project, twice within a single writing pass.

| Fact | Lives in |
|---|---|
| Build status, counts, gaps | `STATE.md` only |
| Rationale, trades, rejected ideas | `DECISIONS-V2.md` |
| Entity shapes, contract structure | `DATA-CONTRACTS-V2.md` |
| Tool list | `TECH-STACK.md` |
| Agents, cuts, mounts, edges | `ROSTER-V2.md` |

Everything else links. Do not restate.

**A README never states build status.** It links to `STATE.md`. The previous repository's README said "no backend, no database and no export engine" over 41,000 lines of code that contradicted all three — the first thing any person or agent would read, and it was backwards.

Run `scripts/check-docs.sh docs` before committing doc changes. It catches stale terminology and status leaks, checks roster counts, and warns on missing `*.md` references. **It does not check other arithmetic, references to non-markdown files, or references outside `docs/`.** Those are rules 4 and 5, and they are yours.

---

## Before you propose anything

Read `DECISIONS-V2.md`. Several ideas in it were considered and rejected with reasons, and a fresh session will otherwise re-propose them.

Things that are settled and should not be reopened:

- The core is deterministic. No inference in the render, freeze, gate, or delivery path.
- The block decision is a function, not an agent.
- The cut is derived from the repository's directory structure, not chosen.
- Gates are `mandatory` or `warn`. There is no skippable.
- The mutation floor is global and versioned, never per-mission.
- `RepoPolicy` defaults false. Safe by absence.

---

## The honest status

What has and has not run is in `STATE.md`.

**Every design claim in these documents is a hypothesis until measured.** Write like it. If you find yourself asserting that something works, check whether anything has ever run it.
