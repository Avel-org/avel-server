# AVEL Command Center — Tech Stack

*This document owns **the tool list**: what is used, at what layer, in one line each. It carries no rationale — every "why" lives in `DECISIONS-V2.md`. Shapes are in `DATA-CONTRACTS-V2.md`; status is in `STATE.md`.*

*Stale markers: tRPC · Supabase · `bytea` snapshots.*

---

## The stack

| Layer | Choice | One line |
|---|---|---|
| Language | TypeScript, end to end | — |
| API contract | **ts-rest** | Emits a real OpenAPI artifact; the previous choice emitted none. |
| HTTP server | **Hono** on `@hono/node-server` | ts-rest's fetch handler (`@ts-rest/serverless`) mounts on a Hono route. |
| Runner | tsx | Runs `pnpm dev` and `pnpm start`. No build step. |
| Validation | Zod | The contract's shapes, checked at runtime on requests and responses. |
| ORM | Drizzle | Tables in `src/db/schema/`; insert types come from `$inferInsert`. |
| Database | **Neon (Postgres)** | DB branching per feature branch; scale-to-zero. |
| DB driver | postgres.js | Through `drizzle-orm/postgres-js`. |
| Local database | Docker, `pgvector/pgvector:pg17` | `avel_dev` and `avel_test`. CI runs the same image. |
| Auth | **Better Auth**, GitHub provider | Identity only, single-user, no role seam. Mounted at `/api/auth/*`; GitHub-id allowlist in an env var, checked in the sign-in hook. |
| GitHub | Octokit, behind a gateway interface | Credential resolved from `Connection.credential_ref`. |
| Frontend | **TanStack Start** (`avel-web`) | Routing and UI. Server work lives in `avel-server`. |
| Desktop and mobile | **Tauri** (`avel-web`) | Build targets of the web client. |
| Jobs | **pg-boss** | Verification outlives a request; uses the Postgres already present. |
| Testing | Vitest · Playwright · **Stryker** | Stryker supplies the mutation score the gate reads. |
| Contract diffing | **oasdiff** in CI | Exit 1 on a breaking change to AVEL's own API. |
| Document text | **unpdf** (pdf.js) · **mammoth** | The text of an uploaded PDF or Word file, for Canon. |
| Observability | **Pino** | ActivityLog records business events; this is operational logging. |
| Tooling | **Biome** | Lint and format. `pnpm lint` runs in CI and blocks. |

---

## Operational notes

**Neon — two connection strings.** Pooled for the application; **direct/unpooled for `drizzle-kit`**. This trips people.

**Neon — day one.** Enable `pgvector` (unused) and create `main` + `dev` branches immediately, so branching is habit rather than retrofit.

**R2 — from the start.** <!--allow-stale--> *Superseded 2026-10-05: R2 is deferred; see* Deliberately deferred *below. The history note that follows is kept as written.* *Previously this document deferred object storage and specified Postgres `bytea` first. That contradicted the schema, which carries `snapshot_key` and no `bytea` column. Resolved 2026-08-17 in favour of R2; see `DECISIONS-V2.md`.* The `version_manifest` stays in Postgres and queryable — only rendered bytes go to R2.

**Stryker scope.** Changed files per export, full project at sprint ship. See `DECISIONS-V2.md`.

**ts-rest — scope.** The contract artifact and `oasdiff` govern **AVEL's own API**. The phase1↔phase2 gate operates on a different artifact in the client's repo; see `CLIENT-CONTRACT-CONFORMANCE.md`.

---

## Changes recorded 2026-10-05

Decided before the first mission, after which the stack is frozen until one mission runs end to end (`DECISIONS-V2.md`, *Decided 2026-10-05: module 0*):

- **Auth.js → Better Auth** with the GitHub provider. <!--allow-stale-->
- **R2 deferred.**
- **Pino now, Sentry later.**

---

## Deliberately deferred

| Deferred | Until |
|---|---|
| pgvector *usage* | The knowledge vault has contents. Extension enabled day one; nothing built against it. |
| Redis | pg-boss removes the reason. Revisit only on genuine throughput need. |
| BullMQ | Same. |
| **Cloudflare R2** (object storage for frozen export bytes) | Deferred 2026-10-05, before the first mission. *Decided 2026-10-06:* R2 is the production backend of one blob gateway that holds export snapshots and Drive files; local disk serves dev and tests (`DECISIONS-V2.md`, *the Drive*). It returns when module 10 freezes the first snapshot. `snapshot_key` stays in the schema. |
| **Sentry** | Later. Pino is the logging now. Deferred 2026-10-05; the trigger is not decided. |

---

## What this stack buys

| Principle | What enforces it |
|---|---|
| AVEL's own contract is verifiable, not attested | ts-rest → OpenAPI → oasdiff in CI |
| Verification survives weak tests | Stryker mutation score + coverage delta |
| Agents stay in their lane | `writable_paths` ownership check at render |
| Reproducibility | Frozen bytes (storage deferred) + version manifest (Postgres) + contract hash |
| Deterministic core | No inference anywhere in this stack — by design |
| Migration-heavy work stays cheap | Neon branching |
| Long verification survives failure | pg-boss |
| Doc consistency | `scripts/check-docs.sh` in CI |
| The gate stays small | Four stages, fixed. No AI review stage — by rule, not by preference. |
| A tool outage doesn't route people around the gate | Ordered runner fallback chain |

**Not yet enforced by anything in this table:** client-side phase1↔phase2 conformance, cost ceilings, acceptance-criteria coverage, and diffing of AVEL's own contract (no OpenAPI emitter and no oasdiff step exist in CI yet). Those remain intentions.
