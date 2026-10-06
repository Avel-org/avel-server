# CounselOS: Where We Are

Last updated 2026-08-22.

Read this first if you are joining the project. It explains what CounselOS is, what state it is actually in, and what has to happen next.

## What CounselOS is

Case management software for small real estate law firms. It handles the work that eats an attorney's day but does not bill: tracking contract deadlines, chasing documents, logging client calls, and capturing time.

The main feature is deadline tracking. Real estate contracts are full of dates that depend on other dates. An option period ends X days after execution. A financing contingency runs Y business days from that. Get one wrong and the client loses a right they paid for. Missed deadlines are the biggest single cause of legal malpractice claims, so this is the part that has to be exactly right.

Some parts of the product use AI and some deliberately do not. Answering questions about a case file uses AI. Calculating a business-day deadline does not, because arithmetic should be correct every time rather than usually.

## How we build: slices

A **slice** is one feature built all the way through, from the database to the screen, with tests, in one go.

The alternative would be building all the database work, then all the API work, then all the screens. We do not do that, because you find out whether the pieces fit only at the very end.

A slice is finished when two tests pass:

1. An **API test** that hits the endpoint directly and checks the response.
2. A **browser test** (Playwright) that clicks through the actual screen like a user would.

Both green means the slice ships. Either red means it does not. There is no partial credit and no "it works on my machine."

**Slice 0 is the foundation slice.** It is the first one. Nothing else can start until it is finished.

## What state the project is actually in

Short version: the setup is done and the building has not started.

Here is what exists:

- The repository, dependencies, and dev environment
- The documentation and architecture decisions
- The agent configuration in `.team-5/`
- 15 commits

Here is what does not exist yet:

- **Database tables.** `apps/api/src/db/schema.ts` is empty. The README says so directly: the seed and reset commands are not wired because there is nothing to seed until the schema has tables.
- Slice 0
- Anything a user could look at

The 27-table schema is designed on paper. It has not been written into code or migrated into a database.

### Check this yourself

Do not trust a document over the actual repository. Run these:

```bash
# How many database tables exist? 0 means Slice 0 has not landed.
grep -c "pgTable" apps/api/src/db/schema.ts

# Are there any migrations?
ls apps/api/drizzle/

# Does the slice gate pass?
pnpm --filter web test:e2e

# What has actually been committed?
git log --oneline -20
```

The third one is the real answer. If there is no Slice 0 browser test, Slice 0 did not ship.

## Rules that already exist, and why

These are already decided. Follow them; do not relitigate them.

**Layering: controller, then service, then repository.** A controller handles the HTTP request and nothing else. A service holds the business logic. A repository talks to the database. A controller never queries the database directly, and a module imports another module's service, never its repository. ESLint enforces this and there is a startup check too.

*Why:* it means you can find any piece of logic by knowing what kind of thing it is. It also means the business logic can be tested without spinning up HTTP.

**Ports 5434 and 6381.** Not the Postgres and Redis defaults.

*Why:* if you have another project running on the default ports, a wrong connection string silently connects you to the wrong database. Non-default ports turn a silent data corruption bug into an obvious connection error.

**Every component gets a `data-testid` in the same commit that creates it.**

*Why:* browser tests need a stable way to find elements. If you add the test IDs later, you will add them wrong or not at all, and the tests will select on CSS classes that break the next time someone restyles a button.

**The AI never sends or confirms anything on its own.** A human approves every outbound action.

*Why:* Texas Bar Opinion 705. An attorney is professionally responsible for everything that leaves their office. This is a legal requirement, not a UX preference.

**Deterministic code where the answer must be exact.** Date math, document classification, and conflict checking are ordinary code, not AI.

*Why:* an AI that is right 97% of the time is unacceptable for a deadline calculation. Ordinary code is right 100% of the time. Use AI for judgment, not for arithmetic.

## The agents and what they are allowed to touch

The project is built by AI agents, each responsible for one part of the codebase. Each agent has a list of paths it is allowed to write to, and it cannot write anywhere else.

This is not a style guideline. It is enforced. If an agent writes outside its paths, that is a failure and the work does not ship.

*Why bother:* when several agents work at once, the most common way things break is two of them solving the same problem differently, or one quietly overwriting another's work. Giving each one a fixed area makes that impossible instead of merely discouraged.

**The roster lives in `agents/`, not here.** This document does not restate it. Seven folders: six named for the feature they own, plus `nemi/` for testing.

CounselOS uses a vertical cut, meaning one agent owns one feature all the way through: its database tables, its business logic, its endpoints, its screens. This is the correct shape for NestJS, which groups files by feature rather than by layer. See ROSTER-V2.md for why.

**Test agents cannot write source code.** Iyo and Nemi can only write test files. If an agent could edit the code it is testing, it could make any failing test pass by changing the code instead of fixing the bug. Removing the ability removes the temptation.

### Why one agent owns a whole feature

NestJS keeps everything for a feature in one folder:

```
apps/api/src/modules/deadlines/
  deadlines.controller.ts
  deadlines.service.ts
  deadlines.repository.ts
  deadlines.dto.ts
```

If you split that by layer, one agent owns the controller and another owns the service, in the same directory. Folder permissions cannot express that, because the folder is shared.

Giving the whole folder to one agent makes the boundary a directory again, which means it can be enforced by simply not mounting anything else.

The trade is that a feature agent writes backend and frontend code, which is more surface area per agent. That is the thing Slice 1 is meant to find out about.

## What Slice 0 needs

Slice 0 is foundation work, so most of the roster sits idle. Running an agent that has nothing to do produces output nobody reads.

Slice 0 has shipped. Slice 1 is the first run through the `agents/` roster, and it has never executed.

Sequencing for Slice 1, from `.team-5/status/merge-queue.md`:

- One agent runs dispatch to completion before any other starts. This is the first time an agent writes backend code and nobody knows yet what they get wrong with it.
- Transactions goes first. It has no queue, no storage, and no external APIs, so a failure is a process failure rather than pipeline complexity.
- Every agent's first backend module gets an adversarial security review in a fresh session before merge.

## What is blocking us

One thing, and everything else is downstream of it.

**`schema.ts` has no tables.** No tables means no migrations, nothing to seed, no repository to write, no endpoint to call, and no screen with data on it. Leonora goes first and nobody else can start.

Three smaller items to handle before the run starts:

1. **Copy Slice 0's definition of done into MISSION-001, word for word** from `docs/00-developer-guide.md`. Do not paraphrase it and do not change it partway through. If it does change, write down what changed and why.
2. **Add the three capture files to the repo root**: `SURPRISES.md`, `MISSION-001-COUNSELOS-SLICE-0.md`, `COST-LOG.md`.
3. **Compare `.team-5/` against the agent list above.** Where they disagree, `.team-5/` wins, because that is what actually runs. Note the differences.

## Why the capture files matter

You will be asked to write things down while the slice runs. It will feel like overhead. It is not.

**SURPRISES.md** gets one line every time an agent does something you did not expect, good or bad. Write it the moment it happens. If you try to reconstruct it afterward you will invent a tidier story than what occurred.

**MISSION-001** records what actually happened: which agents ran, which checks caught something, which ones you skipped when you were in a hurry, and whether anything shipped that looked finished but was not. That last question is the entire reason this system exists.

**COST-LOG.md** records tokens and spend per agent. This one cannot be reconstructed at all. An unlogged token is gone permanently, and without it there is no way to answer which agents are expensive or what a slice actually costs.

The whole agent setup — the roster, the phases, the path restrictions — is a set of educated guesses. Slice 0 is the first time any of it meets reality. If nobody writes down what happens, we learn nothing and the next slice repeats the same mistakes with more confidence.

## Next steps, in order

1. Run the four check commands and confirm where things actually stand.
2. Copy Slice 0's definition of done into MISSION-001.
3. Add the three capture files.
4. Compare `.team-5/` to the agent list here and note the differences.
5. Leonora writes the schema.
6. Run Slice 0 and capture as you go.
7. Fill in the verdict and feed it back into the project docs.

## A note on this document

The agent list and the path assignments here were worked out from the stack and the folder layout, not from reading `.team-5/` directly. If `.team-5/` says something different, `.team-5/` is correct and this document is the one that needs fixing.
