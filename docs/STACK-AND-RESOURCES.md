# Stack & Resources

Everything needed before and during the build. Split by when you actually need it, so nothing gets provisioned six weeks early.

Decision record: `DECISIONS-V2.md`. Tool list: `TECH-STACK.md`.

---

## Two repositories

The frontend framework and the repo split are decided in `DECISIONS-V2.md`. `avel-server` is Hono and owns the contract and the docs. `avel-web` is TanStack Start, with Tauri for desktop and mobile. Credential resolution, the zip stream and the webhook are `avel-server` endpoints.

**Pin the TanStack Start version. Read release notes before upgrading.**

---

## Day one — needed tomorrow

Everything here is free or already installed.

### Runtime
- [ ] **Node 22 LTS or 24 LTS** — pin in `.nvmrc`
- [ ] **pnpm** — `npm i -g pnpm`
- [ ] **Docker Desktop.** Day one, for local Postgres (`docker compose up -d`). Later also for the sandbox and testcontainers.

### Scaffold (avel-web only)
```bash
pnpm create @tanstack/start@latest avel-web
cd avel-web && pnpm install
```

### Core dependencies
```bash
# contract + validation
pnpm add @ts-rest/core @ts-rest/react-query zod

# data
pnpm add @tanstack/react-query

# ui
pnpm add tailwindcss @tailwindcss/vite lucide-react
pnpm add class-variance-authority clsx tailwind-merge

# the two pure functions
pnpm add -D @types/node
```

### Fonts
Already chosen and in use on the landing. Same four:

| Role | Face |
|---|---|
| Display | Space Grotesk 500/600/700 |
| Body | Inter |
| Mono | Geist Mono 400/500 |
| Emphasis | Fraunces italic 400/500 |

Self-host through `next/font` equivalent or Fontsource. Do not hotlink Google Fonts in the app shell — an internal tool should not depend on a third-party CDN to render.

### shadcn
```bash
pnpm dlx shadcn@latest init
```
Config already exists: `new-york` style, `neutral` base, CSS variables on, lucide icons. **Match the landing's `components.json` exactly** so components move between the two surfaces without translation.

### Tokens
- [ ] Apply `globals-patch.css`
- [ ] Confirm `.light` sits on the `/app` shell wrapper, never `<html>`
- [ ] Replace the `html, body` scrollbar block with the scoped version

---

## Week one — needed once something computes

### GitHub
- [ ] **A scratch organisation.** Not a personal repo. Every delivery path gets exercised here fifty times before a client repo is touched.
- [ ] **A fine-grained PAT**, contents read-only to start. Read-only is enough for the blast radius — the whole point is that it reads a tree and writes nothing.
- [ ] Put it in `.env`, never in client code, resolved only in `avel-server`.

### Test repos
Pick three public repositories with different shapes for the blast-radius fixtures:
- A small one (~50 files) for fast iteration
- A large one (5,000+ files) to hit the tree-truncation path
- One with symlinks or submodules to exercise the violation classes

---

## Week two to three — the backend appears

### Database
- [ ] **Neon** — free tier is genuinely enough. Branching per feature branch is the reason to pick it, and it is on the free plan.
- [ ] Two connection strings: **pooled for the app, direct for `drizzle-kit`.** This trips people.
- [ ] `main` and `dev` branches on day one so branching is habit rather than retrofit.

```bash
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit
```

- [ ] Enable **pgvector** immediately, unused. One line, free, and V2 retrieval then needs no migration.

### Server
```bash
pnpm add hono @hono/node-server
pnpm add better-auth       # Better Auth, GitHub provider (decided 2026-10-05; see TECH-STACK.md)
pnpm add octokit
pnpm add pg-boss           # jobs — uses the Postgres you already have
```

### Observability
```bash
pnpm add pino pino-pretty
```
Sentry comes later (decided 2026-10-05; see `TECH-STACK.md`). Its free tier is 5,000 errors a month.

---

## Week three onward — the gate

### Verification
```bash
pnpm add -D vitest @vitest/coverage-v8
pnpm add -D @playwright/test
pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner
pnpm add -D testcontainers
```

- [ ] **oasdiff** in CI — a GitHub Action, exit 1 on breaking change
- [ ] **Stryker config: `--incremental`, changed files only.** Full-project mutation is for the sprint ship, not every export. This was resolved; do not let it default.

### Storage
*Note 2026-10-05: R2 is deferred (`TECH-STACK.md`). Do not provision it yet. It moves to* Deferred *below.*

---

## Deferred — do not provision yet

| Resource | Trigger |
|---|---|
| **Daytona or E2B sandboxes** | The first paying client. $200 free credit on Daytona, no monthly floor. Local Docker is correct until then. |
| **Anthropic API key for Canon** | Canon is a form in V1. Only needed when intake becomes an agent. |
| **A domain for the app** | `avelco.dev/app` is fine. |
| **Vercel or Cloud Run** | Local until something is worth deploying. |
| **BullMQ / Redis** | pg-boss removes the reason. |
| **Cloudflare R2** | Deferred 2026-10-05; trigger not decided. 10 GB free and no egress fees when it returns. `pnpm add @aws-sdk/client-s3` (R2 is S3-compatible). |
| **Sentry** | Later; trigger not decided. Pino covers logging now. |

---

## Cost

| | Now | With one client |
|---|---|---|
| Neon | free | free |
| Sentry | later | free |
| R2 | deferred | deferred |
| GitHub | free | free |
| Sandbox | $0, local Docker | ~$4/mission, free credit first |
| **Infrastructure total** | **$0** | **~$5/month** |
| **Token spend** | — | **$50–200/mission** |

Infrastructure is noise. **Tokens are the whole bill**, which is why the cost log matters more than any provider decision on this page.

---

## Accounts to open

**Now:** GitHub scratch org. That is the only one.

**Week two:** Neon.

**Deferred:** Cloudflare R2 and Sentry (2026-10-05).

**When a client pays:** Daytona.

---

## The traps

**Two Neon connection strings.** Pooled for the app, direct for migrations. `drizzle-kit` will fail confusingly against the pooled string.

**Stryker defaults to the full project.** Set incremental on the first run or verification takes an hour and you will start routing around it.

**TanStack Start's API has moved between versions.** Pin it. Do not upgrade mid-build.

**Do not hotlink fonts in the app.** Self-host. An internal tool should not need a CDN to render text.

**Do not put the PAT anywhere the client bundle can reach.** `avel-server` only. This is the one-way door — free today, expensive after the first client repo is connected.

---

## Confirm before `pnpm create`

- [ ] TanStack Start version pinned in `avel-web/package.json`
