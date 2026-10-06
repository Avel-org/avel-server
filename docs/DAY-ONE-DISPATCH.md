# Day One — Three Session Dispatch

Session 1 is foundations. It scaffolds, then dispatches 2 and 3.

**Sequencing:** Session 3 can start immediately — it writes files, not code. Session 2 waits about thirty minutes for the repo to exist. This is the provisioning-before-parallelism rule from Mission 002, applied to the frontend build.

Mounts are disjoint by design. No two sessions write the same path.

| Session | Owns | Blocked by |
|---|---|---|
| 1 — foundations | `src/routes/`, `src/components/`, `src/styles/`, root config | nothing |
| 2 — pure functions | `src/lib/git/`, `src/lib/blast/`, `tests/` | S1 scaffold only |
| 3 — golden fixture | `fixtures/golden/` | nothing |

---

## SESSION 1 — paste this first

```
You are the foundations session for the AVEL Command Center frontend build.

Read these before writing anything:
  1. CLAUDE.md              — the standing rules. Short. Non-negotiable.
  2. START-HERE.md          — routing
  3. docs/DAY-ONE-FRONTEND.md
  4. docs/STACK-AND-RESOURCES.md
  5. docs/ROUTES.md
  6. docs/patches/globals-patch.css

Then summarise back to me, in under 200 words:
  - what AVEL is
  - what the four gate stages are
  - what "the contract is the oracle" means for how the frontend gets its types
  - why TanStack Start is kept for avel-web now that credential resolution,
    the zip stream, and the webhook are avel-server endpoints

Do not start coding until I confirm that summary.

YOUR MOUNT — you may write only:
  package.json, tsconfig.json, vite.config.ts, .nvmrc, .gitignore
  src/routes/**
  src/components/**
  src/styles/**

You may NOT write:
  src/lib/git/**        — session 2 owns this
  src/lib/blast/**      — session 2 owns this
  fixtures/**           — session 3 owns this

A write outside your mount is a failure, not a shortcut. If you need
something outside it, stop and file a blocker: tell me what you need,
why, and what you did instead.

TODAY'S SCOPE — the foundation six, in order:
  1. contract client   — ts-rest + TanStack Query over avel-server/contract,
                         pinned to a commit. Typed hooks. computeCoherence
                         is imported from the contract, never written here.
  2. tokens            — apply docs/patches/globals-patch.css. .light goes on
                         the /app shell wrapper, never on <html>.
  3. primitives        — the <Surface> generic: loading, empty, error,
                         success. Four states or it is not done.
                         Content-shaped skeletons, never a spinner.
  4. error map         — error.code -> message + recovery. Exhaustive over
                         the union with a `never` check. Never parse message.
  5. app shell         — sidebar, top bar, .app-scroll on the main pane
  6. device boundary   — route metadata + guard

RULES THAT ARE NOT SUGGESTIONS:
  - Types are inferred from the contract, never hand-written. If a screen
    needs a shape the contract does not define, that is a contract change.
    File it. Do not invent a local interface.
  - data-testid on every interactive element, in the same commit as the
    component. Not later.
  - Verify before you assert. If you say a file exists, you read it.
  - Do the arithmetic. If you state a count, count it.

FIRST TASK, before the six:
  Scaffold the repo — pnpm create @tanstack/start, install deps per
  docs/STACK-AND-RESOURCES.md, pin the TanStack Start version, commit.
  Tell me when that is done. Session 2 is blocked on it.

NOT TODAY:
  No dashboard, no analytics, no /knowledge screen, no catalog, no
  playbooks, no settings, no auth provider beyond the gate.
```

---

## SESSION 3 — paste this immediately, in parallel

```
You are the golden fixture session for the AVEL Command Center.

Read:
  1. CLAUDE.md
  2. docs/GOLDEN-FIXTURE.md      — this is your entire spec
  3. docs/ROSTER-V2.md           — mount table and edge graph

YOUR MOUNT — you may write only:
  fixtures/golden/slice-1/**

Nothing else. Not src/, not package.json, not docs/. If you need
something outside this, file a blocker.

YOUR TASK:
  Hand-write the complete .avel/ package described in GOLDEN-FIXTURE.md.
  Real content, not placeholder. Two agents: transactions and nemi.

  This is the render specification. Whatever the renderer must produce,
  you are producing by hand first — so every field it reaches for is a
  field that must exist, and every field nothing touches was speculation.

DETERMINISM RULES — these are why the fixture exists:
  - No timestamps anywhere in the rendered bytes. No exported_at, no
    generated_on. Timestamps live in Postgres, not in the package.
  - No values generated at write time. Mission and agent IDs are stable
    inputs; anything freshly generated may not appear.
  - JSON object keys sorted lexicographically.
  - Arrays sorted by a declared stable key — agents by slug, skills by
    slug, gates by gate name.
  - LF line endings, trailing newline on every file, NFC normalisation.

WHEN THE TREE IS COMPLETE:
  Compute sha256 per file, fill manifest.json files[] sorted by path, then
  compute package_sha256 over the sorted list excluding manifest.json
  itself. Show me your work — I want to see the hashes.

REPORT AT THE END:
  Every field you had to invent because the spec did not name it. That
  list is the most valuable thing you will produce today — it is the gap
  between the data model as designed and the data model as needed.
```

---

## SESSION 2 — paste after Session 1 confirms the scaffold

```
You are the pure functions session for the AVEL Command Center.

Read:
  1. CLAUDE.md
  2. docs/BLAST-RADIUS.md        — your spec, sections "Reading the remote
                                   tree" and "Computing the diff"
  3. docs/DEV-TIPS.md            — the determinism trap list

YOUR MOUNT — you may write only:
  src/lib/git/**
  src/lib/blast/**
  tests/**
  vitest.config.ts

You may NOT touch src/routes, src/components, or package.json. Session 1 owns those. If you need a dependency added,
file a blocker — do not edit package.json yourself.

TASK 1 — gitBlobSha
  gitBlobSha(bytes: Buffer): string
  = sha1("blob " + byteLength + "\0" + content)

  VERIFY IT AGAINST REALITY, not against your expectation:
    echo -n "hello" > /tmp/t && git hash-object /tmp/t

  Test on at least ten real files including an empty file, a file with
  no trailing newline, and a file containing non-ASCII bytes.

  Expect this to fail first. It is almost always the header format or a
  trailing newline. When it does, that is your first SURPRISES.md entry.

TASK 2 — computeBlastRadius
  computeBlastRadius(rendered, remote, policy) -> BlastRadius

  Pure. No network, no clock, no filesystem. The gateway fetches; this
  function only compares.

  Classify: CREATE, OVERWRITE, UNCHANGED, PRESERVE.
  PRESERVE is a count and a list of top-level directories, never a list
  of paths. A client repo has thousands of untouched files and
  enumerating them buries the six that matter.

  Violations that must block, each its own code:
    PATH_OUTSIDE_ALLOWED, PATH_TRAVERSAL, SPECIAL_FILE_COLLISION,
    CASE_COLLISION, PROTECTED_PATH, OWNERSHIP_VIOLATION

  Normalise every path before comparing: POSIX separators, no leading
  slash, NFC. A path that changes under normalisation is itself a
  violation.

TESTS — fixtures only, no network:
  each classification, each violation code, empty remote tree,
  truncated tree, a path that differs only in case.

WHAT YOU ARE NOT DOING:
  No GitHub API calls. No schema. No UI. These are two pure functions
  and their tests. If you find yourself adding a dependency, stop.

REPORT AT THE END:
  Did gitBlobSha match git hash-object on the first attempt? If not,
  what was wrong? That answer goes in SURPRISES.md.
```

---

## What to check at the end of the day

**Session 1:** the shell renders in both themes, `<Surface>` requires all four states, and the error map fails the build if a code is unhandled.

**Session 2:** `gitBlobSha` matches `git hash-object` on ten real files. This is the only unambiguous pass/fail on the whole day.

**Session 3:** the fixture tree exists with real content and computed hashes, plus a list of every field that had to be invented.

**Then, and this is the point of running three:** compare session 3's invented-fields list against session 1's contract. Every field the fixture needed that the contract lacks is a real gap in the data model, discovered on day one instead of at module eight.

**One line in `SURPRISES.md` per session, minimum.** If a session reports nothing surprising, it was not paying attention.
