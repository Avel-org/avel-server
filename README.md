# avel-server

The server for the AVEL Command Center: the contract every client shares, the API, and the database — and, as modules are built, the gate, the render, and delivery.

**For what is built and what is not, read [`docs/STATE.md`](docs/STATE.md).** This README never states build status.

## Run it

Requires Node 22 or later and pnpm 10. The exact pnpm version is pinned in `package.json`, so `corepack enable` picks it up.

```bash
pnpm install
cp .env.example .env
docker compose up -d        # local Postgres
pnpm dev                    # http://localhost:8787/api/health
```

## Check it

```bash
pnpm check
```

Runs exactly what CI runs: the doc check, the determinism check, types, lint, and tests. Database tests run when `DATABASE_URL` is set and skip cleanly when it isn't.

## Before your first change

Read [`CLAUDE.md`](CLAUDE.md) — it is short, and it is the rules. Then [`START-HERE.md`](START-HERE.md) says which two or three docs your task needs.

Three rules that apply from the first line of code:

- **Time comes from `src/lib/clock.ts`, identifiers from `src/lib/ids.ts`.** The determinism check fails the build otherwise.
- **Tests live in `tests/`,** never beside the source they test.
- **A check is proven by watching it fail.** Before trusting a new test or script, break what it guards and see it go red.

The docs live in this repository and nowhere else. `avel-web` links here rather than keeping a copy.
