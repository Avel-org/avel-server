# Golden Fixture

The hand-written `.avel/` package the renderer must reproduce byte-for-byte.

*Decided 2026-10-05: the fixture is rebuilt in module 10 from an internal `template-booking` mission, not from client CounselOS data, and written by Fenn without seeing the render. The CounselOS slice below is the previous design, kept until the rebuild replaces it. See `DECISIONS-V2.md`.*

This document is the render specification. Everything the renderer needs to know is here, because everything the renderer produces is here. Write this by hand first, commit it, then write code until `render(mission)` matches it exactly.

## Who owns it over time

The `fixture` role — a `model` role whose mount reads the render specification and writes `fixtures/golden/`, and can never see render source or render output. See `ROLES.md`.

**The fixture updates only in response to a specification change, never in response to a render change.** When the golden test fails:

- **The specification did not change** — it is a regression. Fix the render and leave the fixture alone.
- **The specification changed** — the `fixture` role rewrites the fixture from the new specification, without seeing the render.

An intended behaviour change must therefore be declared in the specification before the render is allowed to produce it.

Regenerating the fixture from the renderer would make the golden test compare the renderer against itself. That passes forever and proves nothing.

## Why hand-write it

You discover the data model by producing the output once. Every field the renderer reaches for is a field that must exist; every field it never touches was speculation.

The test comes free:

```ts
expect(render(fixtureMission)).toEqual(goldenBytes)
```

And the determinism check comes free with it: the package hash is compared against a pinned digest committed beside the fixture, in one process, in fresh processes, and under `TZ=Asia/Tokyo LANG=tr_TR`. Comparing two renders against each other cannot catch a change that moves both. See `EXPORT-ENGINE.md` §3.

## What the fixture must exercise

Small enough to hand-write, complete enough that the contract is fully discovered rather than partially.

| Must include | So that |
|---|---|
| Two agents in different phases | Phase ordering and per-agent rendering both matter |
| One feature agent and one horizontal agent | Both naming conventions and both mount shapes are exercised |
| A skill of each type | The `knowledge` / `capability` render branch is covered |
| A playbook with both gate policies | `mandatory` and `warn` both render |
| One declared edge | The edge graph is not theoretical |
| An append-only mount | The composition-root finding from Mission 002 is encoded |
| A phase-1 contract artifact | The conformance gate has something to diff against |

**Recommended agents: `transactions` and `nemi`.** Real, from CounselOS, minimal, and they sit at opposite ends of the cut — one owns a feature, one owns nothing and tests everything.

## The tree

```
.avel/
├── MISSION.md                      human entry point — read this first
├── manifest.json                   machine-readable, content-addressed
├── mission/
│   ├── brief.md
│   └── playbook.md
├── roster/
│   ├── roster.json                 mounts · phases · edges, machine-readable
│   ├── transactions/
│   │   ├── identity.md
│   │   ├── depth.md
│   │   └── skills/
│   │       ├── nestjs-module.md          type: knowledge
│   │       └── drizzle-migrate.md        type: capability
│   └── nemi/
│       ├── identity.md
│       ├── depth.md
│       └── skills/
│           └── playwright-gate.md        type: knowledge
├── contract/
│   └── phase1.openapi.json         what phase 2 gets diffed against
├── conventions/
│   ├── layering.md
│   ├── testing.md
│   └── naming.md
└── process/
    ├── dispatch/_TEMPLATE.md
    ├── reports/_TEMPLATE.md
    ├── findings/_TEMPLATE.md
    └── log/decision-log.md
```

**Not in the package:** `evidence/`. That is produced by the gate at verification time, not by the render. The renderer must never create it, or the two will disagree.

## The determinism rules this encodes

These are the constraints that make the fixture reproducible, and getting them wrong is the most likely source of a failing hash.

**No clock anywhere in rendered bytes.** No `exported_at`, no `generated_on`, no timestamps in file headers. Timestamps live in `version_manifest` in Postgres, which is queryable and is not part of the package.

**No randomness.** No UUIDs generated at render time. Mission and agent IDs are stable inputs, so they may appear; anything freshly generated may not.

**Sorted everything.** JSON object keys sorted by codepoint (`byCodepoint`). Arrays sorted by a declared stable key — agents by slug, skills by slug, gates by gate name. Directory listings sorted before iteration, because `fs.readdir` order is OS-dependent.

**Normalized text.** LF line endings, trailing newline on every file, NFC Unicode normalization, no locale-sensitive comparison anywhere. Sort with an explicit comparator, never `localeCompare`.

## MISSION.md

The human entry point. An agent opening the package reads this first and needs no external context afterward.

```markdown
# Mission: CounselOS Slice 1 — Transactions

**Client:** Meridian Law
**Type:** full-build
**Sprint:** 1
**Cut:** vertical (derived — feature-organized codebase)

## What ships

One vertical slice: the transactions module, backend through UI,
gated by both an API test and a browser test.

## Definition of done

Both gates green:
- `pnpm --filter api test:e2e`
- `pnpm --filter web test:e2e`

Neither is optional. One red means no ship.

## Who is running

| Phase | Agent | Owns |
|---|---|---|
| B | transactions | The transactions feature, every layer |
| C | nemi | Frontend tests and the accessibility audit |

Foundations for this mission is the operator, unless a dispatch names someone else.

## Where things go

- Read `conventions/` before writing any code.
- Write completion reports to `process/reports/`.
- File blockers rather than absorbing them silently.
- Log every decision in `process/log/decision-log.md`.

## What is forbidden

Writing outside your declared mount. See `roster/roster.json`.
This is enforced, not advised.
```

## manifest.json

Machine-readable, content-addressed, no timestamps.

```json
{
  "avel_version": "1",
  "mission_id": "00000000-0000-4000-8000-000000000001",
  "sprint": 1,
  "cut": "vertical",
  "cut_source": "derived",
  "files": [
    { "path": "MISSION.md", "sha256": "..." },
    { "path": "contract/phase1.openapi.json", "sha256": "..." },
    { "path": "roster/roster.json", "sha256": "..." }
  ],
  "gate": {
    "mutation_floor": 60,
    "coverage_delta_min": 0,
    "config_sha256": "..."
  },
  "package_sha256": "..."
}
```

`files` is sorted by path. `package_sha256` is computed over the sorted file list and their hashes, excluding `manifest.json` itself.

`gate.config_sha256` is the hash of the versioned gate config, so "what bar did this mission ship against" stays answerable later. The floor is global and versioned, never per-mission.

## roster/roster.json

The mount table, machine-readable. This is what the sandbox reads to build mounts and what the ownership check compares the diff against.

```json
{
  "cut": "vertical",
  "phases": ["A", "B", "C", "D"],
  "agents": [
    {
      "slug": "nemi",
      "phase": "C",
      "kind": "horizontal",
      "writable": [
        "apps/web/e2e/**",
        "apps/web/src/**/*.test.tsx"
      ],
      "append_only": [
        ".avel/process/findings/**",
        ".avel/process/reports/**",
        ".avel/process/log/decision-log.md"
      ],
      "readonly": ["**"]
    },
    {
      "slug": "transactions",
      "phase": "B",
      "kind": "feature",
      "writable": [
        "apps/api/src/modules/transactions/**",
        "apps/web/src/app/transactions/**",
        "apps/web/src/components/features/transactions/**"
      ],
      "append_only": [
        "apps/api/src/app.module.ts",
        ".avel/process/findings/**",
        ".avel/process/reports/**",
        ".avel/process/log/decision-log.md"
      ],
      "readonly": [
        "packages/shared/**",
        ".avel/contract/**",
        ".avel/conventions/**"
      ]
    }
  ],
  "edges": [
    {
      "from": "operator",
      "artifact": ".avel/contract/phase1.openapi.json",
      "to": ["transactions"]
    },
    {
      "from": "transactions",
      "artifact": "apps/api/src/modules/transactions/*.dto.ts",
      "to": ["nemi"]
    }
  ]
}
```

Agents sorted by slug. Globs sorted within each array.

**`append_only` is the Mission 002 finding encoded.** The composition root belongs to no feature and every feature must register in it. Omit it and the first agent cannot load its own module. `process/reports/` and the decision log are the same shape — every agent is required to write there.

## mission/playbook.md

Process for this mission type, not this mission.

```markdown
# Playbook: full-build

## Waves
A → B → C → D

## Gates

| Gate | Policy |
|---|---|
| phase1-close | mandatory |
| alignment | mandatory |
| qa | mandatory |
| security | warn |
| acceptance | mandatory |

Gate policy is mandatory or warn only. Shipping past a red mandatory gate
requires a written override that is rendered into the delivery
and visible to the client.

## Deliverable
pr

## Required fields
brief · contract · roster · conventions

## Hard block
The mission must contain at least one active agent in the earliest
wave this playbook declares.
```

## conventions/layering.md

The stack rules an agent needs before writing anything. These come from the client project, not from AVEL.

```markdown
# Layering

controller → service → repository

A controller handles the HTTP request and nothing else.
A service holds business logic.
A repository talks to the database.

A controller never queries the database directly.
A module imports another module's service, never its repository.

Enforced by ESLint and a bootstrap guard. Violations fail the build.
```

`testing.md` and `naming.md` follow the same shape: short, imperative, and specific to the client's codebase.

## Agent files

Two per agent, each capped at 1200 tokens, enforced on the generator's output (800 until 2026-10-13). `identity.md` is always loaded; `depth.md` is reached for when the agent hits something uncommon.

```markdown
# transactions

You own the transactions feature end to end: schema, service,
controller, guards, state, and components.

## Mount

Writable:
  apps/api/src/modules/transactions/**
  apps/web/src/app/transactions/**
  apps/web/src/components/features/transactions/**

Append-only:
  apps/api/src/app.module.ts

A write outside this set fails the ownership check and the mission
does not ship. This is enforced by the filesystem, not by your
judgment.

## Never

- Write another feature's module
- Modify shared packages — file a blocker instead
- Edit tests you did not author

## Blockers

If the dispatch forbids something you need, file it in
process/findings/ with a documented workaround. Do not absorb
it silently and do not route around the boundary.
```

**Note what that last section encodes.** Three operator errors in Mission 002 surfaced as filed blockers rather than silent workarounds, and that was the instructed behavior working the first time it was tested. It belongs in every identity file.

## Building it

1. Create the tree by hand. Real content, not lorem.
2. Normalize: LF endings, trailing newlines, sorted JSON keys.
3. Compute `sha256` per file, fill `manifest.json`, compute `package_sha256`.
4. Commit as `fixtures/golden/slice-1/`.
5. Write `render(mission) → Map<path, Buffer>` until it matches.

```ts
const golden = loadFixture('fixtures/golden/slice-1')
const out = render(fixtureMission)

expect([...out.keys()].sort()).toEqual([...golden.keys()].sort())
for (const [path, bytes] of golden) {
  expect(out.get(path)).toEqual(bytes)   // byte-for-byte
}
```

Then the determinism harness, which pins a digest:

```ts
expect(packageHash(render(m))).toBe(PINNED_PACKAGE_SHA256)
// PINNED_PACKAGE_SHA256 is committed beside the fixture.
// Run the same assertion in a fresh process, and under TZ=Asia/Tokyo LANG=tr_TR.
```

## What this fixture will teach you

The point of writing it by hand is that the render contract stops being a guess.

Fields the renderer reaches for are fields `Mission`, `RosterEntry`, `Skill`, and `Playbook` must carry. Fields nothing touches are fields the schema does not need. That is how the data layer gets built over something that works rather than over a document.

Expect at least one surprise. Mission 002 found four in a process that had been designed for weeks.

---

## Golden fixtures for templates

Everything above specifies the golden fixture for AVEL's own render: the exact package the renderer must reproduce. A template built by AVEL needs the same thing applied to behaviour — **scripted scenarios with exact expected results, written from the specification by an author who has never seen the application.**

### What Fenn produces

```
fixtures/golden/
  seed.json          starting state — for booking: providers, opening hours, existing bookings
  clock.json         the fixed "now" for every run
  scenarios/
    001-book-open-slot.json
    002-double-book-rejected.json
    003-cancel-frees-slot.json
    004-outside-opening-hours.json
    005-daylight-saving-gap.json
    006-two-requests-same-slot.json
  README.md          which acceptance criterion each scenario covers
```

Each scenario states what it covers, the starting state, the requests, and the expected responses and final state:

```json
{
  "covers": ["AC-3"],
  "given":  "seed.json",
  "when":   [ { "POST": "/bookings", "body": { "slot": "..." } } ],
  "then":   { "responses": [ { "status": 409 } ], "state": { "bookings": 1 } }
}
```

**`covers` connects to `spec-check`,** which can then confirm every acceptance criterion is backed by a test or a golden scenario.

### Design rules

**Remove nondeterminism rather than ignoring it.** Applications are full of values that change on every run: the current time, generated identifiers, timestamps. Excluding those fields from comparison would make any bug inside them invisible. Instead the application runs against the fixed clock in `clock.json` and a predictable identifier generator in test mode, so every response compares exactly — the same principle as the byte-exact render.

**Include the cases that quietly break.** For a booking domain that means daylight saving: on a spring-forward day one hour does not exist, and on a fall-back day one hour occurs twice. Every domain has equivalents. They are the scenarios nobody writes a test for, which is exactly why the fixture carries them.

**State races as outcomes, not orders.** Two simultaneous requests for one slot have no fixed order. The expected result is one success and one rejection in either order, and exactly one booking in the final state.

**Keep it small.** Ten to fifteen scenarios covering the obligations and the edge cases. Property tests provide breadth. The fixture provides exactness where it matters most.

### Why it is not redundant with the tests

| | Tests — Nemi, Iyo | Golden fixture — Fenn |
|---|---|---|
| Can see the application code | Yes, read-only | **Never** — absent from the room |
| Can be shaped by what the code does | Yes, even unintentionally | **No** |
| Checked by | Mutation score | The specification |

A tester who has read the code can write a test that confirms what the code does rather than what it should do. That is F2: wrong code with a matching wrong test, which mutation testing cannot catch. Fenn cannot make that mistake, because he has never seen the code.

**The template golden fixture is therefore an executable defence against F2.** Until it existed, the only defence was `spec-judgment` — a judgment. This one is mechanical.

### Who runs it

A code role in the running room replays every scenario against the live application, with the fixed clock and seeded identifiers, and compares every response and the final state. No model takes part in the comparison.

### When it changes

Only when the specification changes, never when the application changes. If a scenario fails and the specification did not change, the application is wrong. If the specification changed, Fenn rewrites the affected scenarios from the new specification — still without seeing the application.
