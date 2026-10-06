# Day One — Command Center Frontend

Tomorrow's checklist. Ordered so nothing blocks on a decision you have not made.

The goal for day one is not a screen. It is **the foundation six**, plus one route rendering real data. Everything after that is fast; everything before it is what makes the rest fast.

---

## Before you open the editor

Three decisions. Ten minutes, and each one blocks work if you defer it.

**1. TanStack Start or plain Vite + TanStack Router.**
Open since the beginning. The route tree is identical either way, so it does not block the map — but it blocks `npm create`. A dense internal tool with no SEO requirement and no public surface probably does not need a meta-framework. Pick one and write it in the decision log.

**2. Where the frontend lives.**
Same repo as the backend, or its own. The contract is the artifact either way, but a split repo means `packages/contract` today rather than `src/contract` later.

**3. Mocks or a real backend.**
There is no backend. So: contract-derived mocks, and the contract is written first. This is the point of the contract being an artifact — you are not blocked, but you also have nothing verified until a mission runs.

---

## The foundation six

No product screen until all six exist. Skipping any of them means rewriting every screen that follows.

### 1 · Contract client
- [ ] `src/contract/` with the ts-rest router, or the mock equivalent if the backend is not started
- [ ] `shared/errors.ts` — the error code union, imported by both sides
- [ ] `shared/envelope.ts` — success and error shapes
- [ ] `shared/coherence.ts` — **`computeCoherence` lives here**, pure, imported by both sides
- [ ] ts-rest client wired to TanStack Query
- [ ] Typed hooks per route group

**Watch:** types are inferred, never hand-written. If a screen needs a shape the contract does not define, that is a contract change, not a local interface.

### 2 · Tokens
- [ ] Apply `globals-patch.css` — radius, elevation, state, z-scale, gate states, diff states
- [ ] Replace the `html, body` scrollbar block with the scoped version
- [ ] Confirm `.light` is on the `/app` shell wrapper, never on `<html>`
- [ ] `font-variant-numeric: tabular-nums` on the app root

**Verify:** toggle both themes and check the gate colours. If the light-mode semantics still read `#22c55e`, the patch did not land.

### 3 · Primitives and `<Surface>`
- [ ] `<Surface>` — the four-states generic: loading, empty, error, success
- [ ] Content-shaped skeletons, never a spinner
- [ ] Button variants: shadcn's names (default, secondary, outline, ghost, destructive, link), restyled
- [ ] Pill, tag, and status badge with the glyph shapes
- [ ] Input, select, and the density container

**The rule that matters:** four states or it is not done. Enforce it by making `<Surface>` require all four rather than by remembering.

### 4 · Error map
- [ ] One table: `error.code` → message + recovery action
- [ ] Exhaustive over the code union — a TypeScript `never` check so a new code fails the build
- [ ] Seed it from the twelve codes in `BLAST-RADIUS.md`

**Never parse `message`.** Codes are the contract; messages change freely.

### 5 · App shell
- [ ] Session gate — unauthenticated is rejected hard, not redirected softly
- [ ] Sidebar: grouped nav, workspace switcher, search with the `F` hint, account pinned bottom
- [ ] Top bar: live pill, right-aligned pill controls
- [ ] `.app-scroll` on the main pane so long lists get a real scrollbar

Reference: `avel-cc-shell.html`.

### 6 · Device boundary
- [ ] Route metadata: `{ device: 'capture' | 'construction' | 'approve' }`
- [ ] Guard component reading it
- [ ] Designed desktop-required screen — what it is, why, and a way to send yourself the link. Not a redirect, not a blank.

**The rule:** approving a gated export from mobile is fine. Initiating an irreversible one is not.

---

## Then one route, with real data

Not mocks. Real.

### `gitBlobSha` and `computeBlastRadius`
- [ ] `gitBlobSha(bytes)` = `sha1("blob " + length + "\0" + content)`
- [ ] Verify against `git hash-object` on ten real files
- [ ] `computeBlastRadius(rendered, remote, policy)` — pure, no network
- [ ] Fixture tests for create, overwrite, unchanged, preserve, and each violation class

These are pure functions. No GitHub, no schema, no gateway. A few hours.

### `/missions/:id/exports/new` — pre-flight
- [ ] Point it at a real public repository
- [ ] One Trees API call, blob SHAs computed locally
- [ ] Real create / overwrite / unchanged classification on screen

**This is the demo.** The actual mechanism, running in a browser, with no backend. Everything else on the route map can wait.

---

## Rules for the session

**Every component gets its `data-testid` in the same commit.** Adding them later means adding them wrong, and the browser gate ends up selecting on CSS classes that break the next restyle.

**Log cost at dispatch, not at close.** Three missions, zero rows. An unlogged token is gone permanently.

**Open `SURPRISES.md` before you start.** One line every time something does what you did not expect. Write it when it happens; reconstruction is fiction.

**Stay inside the mount.** If the dispatch forbids something you need, file a blocker with a documented workaround rather than routing around it.

---

## What not to do tomorrow

- **No dashboard, no analytics, no trend charts.** Two missions is not a trend.
- **No `/knowledge` screen.** Empty vault, no write path.
- **No catalog, playbooks, or settings.** They come after the pre-flight works.
- **No backend.** The contract plus mocks is the point.
- **No auth provider integration** beyond the session gate. Auth.js can wait a day.

---

## Done looks like

By end of day:

- The foundation six exist and the shell renders in both themes
- `gitBlobSha` matches `git hash-object` on real files
- The pre-flight screen shows a real file classification against a real repository
- One `SURPRISES.md` entry, because something will surprise you

If the shell is beautiful and nothing computes a real blast radius, the day did not land. The mechanism is the product.

---

## Open, and none of it blocks tomorrow

| Question | Needed by |
|---|---|
| TanStack Start vs Vite + Router | Before `npm create` |
| `MOBILE-PWA.md` does not exist | Before any offline capture work |
| `preset` route group missing from the contract | Before the loadout screen |
| Mutation threshold: global vs per-mission | Before the export engine |
| Client conformance D1/D2 | Before claiming the alignment gate is mechanical |
