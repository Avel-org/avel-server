# Building avel-web

How the Command Center's frontend is built: its layout, conventions, data layer, checks, and what makes a screen done. Build status lives in `STATE.md`.

This document owns how avel-web is built. It links rather than restates:

| For | Read |
|---|---|
| Every route, the sidebar, device classes, screen notes, and the build order | `ROUTES.md` |
| How shadcn/ui components are used and restyled | `SHADCN-PRINCIPLES.md` |
| The pre-flight screen, fully specified | `BLAST-RADIUS.md` |
| Token values | `patches/globals-patch.css` |
| The data every screen shows | `DATA-CONTRACTS-V2.md` |
| What each module of the product does | `COMMAND-CENTER.md` |

---

## What avel-web is

One web app that is also the desktop and mobile apps. Desktop and mobile are Tauri builds of the same source, not separate codebases.

**The server enforces; the client renders.** avel-web decides what to show on each surface. avel-server decides what each surface is allowed to do — a phone can approve but never initiate a delivery, whatever the interface displays. A rule that only hides a button is not a rule.

## From design to code

Every screen passes through the same four steps, in order:

1. **The design system** in Claude Design holds every token, component, block, and pattern.
2. **The frontend breakdown** specifies each route: purpose, device class, layout, data, components, states, interactions, and motion.
3. **A screen Design** in Claude Design combines one route's brief with the design system.
4. **Code** in avel-web implements that Design using components that already exist in the design system.

A component exists in the design system before it exists in code. If a screen needs something the system lacks, it is added to the system first — never invented in a screen, and never invented in code. Component names in code match the design system's names, which match their shadcn equivalents where one exists.

## Repository layout

```
src/
  routes/            one file per route; flat dot names map to paths
                     (catalog.skills.tsx → /catalog/skills)
  shell/             nav.ts — the sidebar's single definition — plus the
                     sidebar and the page frame
  components/ui/     shadcn primitives, restyled; added by the shadcn CLI
                     with the first screen that needs each one
  components/avel/   AVEL composites — GateRow, VerdictStamp, HashPair,
                     BlastRadiusTable, AgentChip, ProposalCard, and the rest
  lib/               the API client, query keys, the error map, formatting
  styles/app.css     the only place token values are defined
tests/               every test; never beside the source it tests
scripts/             checks CI runs
```

Tests live in `tests/`, so every boundary in this repository is a directory. That is what lets an agent's sandbox enforce "builders never write tests" with a mount rather than a checkpoint. See `SANDBOX.md`.

---

## Routes

### Adding a route

1. Create the file in `src/routes/`, named for its path
2. If it belongs in the sidebar, add it to `src/shell/nav.ts` — nowhere else
3. Declare its device class (below)
4. Build all four states through `<Surface>` (below)
5. Run `pnpm check`. The navigation test fails if a sidebar link has no route or a route has no link, reading paths from the router generator's own output.

### Device class on every route

Each route declares its class from `ROUTES.md` — `capture`, `construction`, or `approve` — through TanStack Router's `staticData`:

```tsx
export const Route = createFileRoute("/missions/$id/exports/new")({
	staticData: { device: "construction" },
	component: PreflightPage,
});
```

A construction route rendered on a phone shows the device-boundary notice instead of the screen. A test asserts every route declares a class, so a new route cannot forget.

### The route tree is being reconciled

`ROUTES.md`'s route tree predates its own sidebar section. The sidebar section is current; the tree is reconciled by the frontend breakdown. Until then, trust the sidebar.

---

## Data

**The contract comes from avel-server**, as a dependency pinned to a commit. A contract change reaches avel-web only when the pin moves, deliberately.

**ts-rest's client with TanStack Query.** Query keys are defined once in `src/lib/`, never written inline, so invalidation stays correct as screens multiply.

**The server is authoritative.** The client holds no business rules. Where a screen needs the same logic the server runs — the roster's coherence check is the example — that logic is a pure function exported by the contract and imported by both sides. One implementation, no drift, no round trip.

**Mocks** are typed from the contract and live only in development and tests. A screen may be built against them before its endpoint exists. It is not done until it has run against the real endpoint.

**Errors** come from a closed vocabulary exported by the contract. `src/lib/error-map.ts` is keyed on that union, so a new error code fails the build until it has copy. Error copy is written for the operator deciding what to do next: what happened, and how to fix it.

## Four states, on every screen

Every screen that shows data renders through `<Surface>`, which requires all four:

```tsx
<Surface
	query={missions}
	loading={<MissionListSkeleton />}
	empty={<NoMissionsYet />}
	error={ErrorState}
>
	{(data) => <MissionList missions={data} />}
</Surface>
```

- **Loading** — a skeleton shaped like the content it replaces, never a spinner alone
- **Empty** — designed, in the brand's voice, inviting the next action
- **Error** — mapped from the error code: what happened, and how to fix it
- **Success** — the screen

`<Surface>` makes a missing state a type error rather than a forgotten case.

---

## Styling and components

Follow `SHADCN-PRINCIPLES.md` for everything about components. Three rules matter from the first line:

- **Tokens only.** Colors, radii, shadows, durations, and fonts come from tokens defined in `src/styles/app.css`. No raw color values in components.
- **Bring in the full token set by applying `globals-patch.css`**, never by retyping values. Its light-mode colors are measured for contrast; retyped values lose that.
- **`@theme static` stays.** Tailwind v4 silently drops theme tokens no utility class uses. AVEL reads tokens through plain `var()`, which Tailwind cannot see, so without `static` the previous build shipped correct in light mode and wrong in dark — with a green build. `scripts/check-tokens.mjs` fails the build if any token goes missing.

### Motion

Use only the motion tokens: micro 120ms, state 200ms, enter 320ms, easing `cubic-bezier(0.2, 0.7, 0.3, 1)`. Nothing bouncy.

- Motion answers an action or explains a change of state. Decoration is not a reason.
- At most one orchestrated moment per screen.
- Every state change must read with `prefers-reduced-motion` — the change is still visible; only the movement goes.
- CSS transitions first. Add an animation library only when a sequence genuinely needs one, and record why.

### Accessibility

The floor, on every screen:

- Text contrast of at least 4.5:1; 3:1 for large text and interface glyphs
- Visible keyboard focus, in the accent color
- Color never carries meaning alone — every gate state has a glyph and a label
- Landmarks and a skip link; a live region announcing results that change, such as a gate resolving
- An automated accessibility scan on every page in the browser tests

**One router behavior to know.** TanStack Router marks every active `Link` with `aria-current="page"`, after any props you pass, so it cannot be overridden. Two links to the same place — a wordmark and a Home link — make a screen reader announce two current pages. Link to a destination once.

---

## Testing

- **Vitest** for pure functions and structural rules, such as the navigation test
- **Playwright with axe** for browser flows and accessibility, added with the first interactive screen
- Every check is proven by watching it fail before it is trusted. `CLAUDE.md`, rule 6.

## What CI runs

`pnpm check` runs exactly what CI runs:

1. Type check, after the route tree is generated
2. Lint and format, plus `scripts/check-raw-colors.mjs`, which rejects any raw colour outside `src/styles/`
3. Tests
4. A production build
5. The token check against that build

## Desktop and mobile

Tauri builds of this same app. Platform detection on the client decides only what to render; the server enforces what each surface may do.

Offline capture on mobile is specified as a requirement in `ROUTES.md` but has no design document yet, so it waits.

---

## A screen is done when

- It uses only components that exist in the design system
- It declares its device class, and a phone sees the right thing on a construction route
- All four states are built through `<Surface>`
- It has run against its real endpoint, not only mocks
- Its keyboard path works, focus is visible, and the accessibility scan is clean
- Its motion uses only the tokens and reads with reduced motion
- `pnpm check` passes

## Lessons from the first build

| What happened | What prevents it now |
|---|---|
| A CSS comment describing a bug contained the characters that close a comment. The rest of the file became noise the browser silently ignored, with a green build. | Lint runs on CSS, and any visual change is checked in a real browser, not only by a passing build |
| Tailwind dropped every gate, diff, radius, and motion token from dark mode only | `@theme static` and `scripts/check-tokens.mjs` |
| 469 tests and no CI, so they ran only when someone remembered | CI on every push, from the first commit |

## Open questions

| Question | Blocking |
|---|---|
| The test asserting every route declares a device class | Before the first route beyond the sidebar's |
| Whether any animation library is needed at all | Before the first orchestrated motion moment |
| The offline-capture design for mobile | Before any offline work |
