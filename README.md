# avel-server

The server for the AVEL Command Center: the contract every client shares, the API and the database. The gate, the render and delivery are built here module by module.

**For what is built and what is not, read [`docs/STATE.md`](docs/STATE.md).** This README never states build status.

## Run it

Requires Node 22 or later and pnpm 10. The exact pnpm version is pinned in `package.json`, so `corepack enable` picks it up.

```bash
pnpm install
cp .env.example .env        # then fill in the auth values (below)
docker compose up -d        # local Postgres: avel_dev, avel_test and the avel_app role
pnpm db:migrate             # migrate avel_dev
pnpm db:seed                # the catalog: agents, presets, playbook
pnpm dev                    # http://localhost:8787/api/health
```

`pnpm dev` refuses to start until `.env` has `BETTER_AUTH_SECRET` (32+ characters), the GitHub OAuth app's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, and your numeric GitHub user id in `AVEL_OPERATOR_GITHUB_IDS`. `.env.example` explains each, and the rest are optional.

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
