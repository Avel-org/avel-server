# Sandbox

Status: specced. Tier 0 is buildable today at no cost. This document answers H1 through H3 in PRIOR-ART.md.

This document defines where agents execute, what they can reach, and how boundaries are enforced. The per-agent mount table is in ROSTER-V2.md.

## Why it is needed

Current sandbox status is in `STATE.md`.

The previous build ran agents as files in a private `avel-system` repository, symlinked into the client project, executing in Claude Code on the operator's machine. That meant:

- Every agent runs with the operator's full user privileges.
- The GitHub credential is present in that environment.
- Every client's code sits on one filesystem.
- Every rule in the roster is enforced only by the agent's willingness to comply.

The last point is the one that matters most, and it is not primarily a security finding.

## What the sandbox is actually for

The sandbox is not primarily a security feature. It is what turns the roster's boundaries from prose into physics.

ROSTER-V2.md establishes that a boundary is only real if it can be written as paths. This document is the other half: `writable_paths` is a mount, not a rule.

If Leon can only write to `components/`, then mount only `components/` as writable in Leon's environment. Leon does not choose not to touch the data layer. Leon cannot. The same applies to Kel and `services/`, to every phase C and D agent and source code, and to Blair and active-mission git.

One change makes every instruction in the roster an enforced invariant. It also produces `verification.ownership` for free, because a write outside the mount fails at the filesystem rather than at review time.

## The four rooms

A sandbox is a sealed room an agent works in. It can touch only what is put in the room. Everything else does not exist for it.

**Why it matters:** the roster is full of rules that say *never*. Builders never write tests. Reviewers never edit source. The runner never holds the credential. Without a sandbox, "never" means "asked not to." With one, the agent cannot.

Every agent gets a room from the roles it covers, not from its name. The room is **generated from `ROLES.md`**: what a role owns becomes writable, what it consumes becomes read-only, and everything else is absent. Maintained by hand, a room drifts from the catalog the same way the assignment tables did.

| Room | Who | Can write | Network | Credential |
|---|---|---|---|---|
| **Builder** | Foundation and build roles | Its own source paths | Package registry only | Never |
| **Checker** | Verify and review roles | Tests, or findings — never source | Registry for verify; none for review | Never |
| **Running** | Test runs, fuzzer, performance, accessibility | Nothing kept — discarded after each run | **Denied** | Never |
| **Delivery** | Delivery only | Nothing — it runs no code | GitHub only | **The only room that holds it** |

**The running room is the dangerous one.** Agents write code; the risk is in *running* it. A client's test suite, its dependencies, the app loaded for performance and accessibility checks — that is where unaudited code executes. It gets no network, no credential, and is thrown away after every run. If something malicious is inside, there is nothing to steal and nowhere to send it.

**Only the delivery room holds the credential.** Every other room is empty of anything worth taking. That single rule is worth more than any isolation technology.

Two special cases:

- **The fixture agent's room has the render absent, not read-only.** Its value is never having seen the render. A read-only mount still lets it look.
- **The incident agent may read production telemetry and never write to production.** Read-only, with a credential scoped to exactly what it reads. It is the one room that touches a live system, and a mistake there is not recoverable.

## Capabilities live inside rooms

A room sets the ceiling: what an agent's work may write, whether it has network, whether it could ever hold the credential. A **capability** grants specific tools within that ceiling — a headless browser, read access to the database, the package registry. The runner provides the granted tools and nothing else, so an ungranted tool is not present at all.

**A capability can never raise the ceiling.** No capability gives a judge write access to source, and none gives any room but delivery the credential. A code check rejects a capability attached to a role whose room cannot hold it. See `SKILLS.md`.

**Drive files reach a room only as copies** (specced 2026-10-06, built after the first mission). The runner copies the files a dispatch brief lists into the room before it starts. No room mounts the file store, so the one-way door between clients holds at the filesystem, not only in the API (`DATA-CONTRACTS-V2.md`, *File*).

## Pattern boundaries: the exit checkpoint

A mount works on whole directories. Some boundaries are patterns, not directories — most importantly, "not the test files," when test files sit in the same directory as the source:

```
modules/transactions/
  transactions.service.ts        builder writes this
  transactions.service.spec.ts   checker writes this
```

A mount cannot express "this directory except files ending in `.spec.ts`."

**So pattern boundaries are enforced at the exit instead.** An agent's work leaves its room through exactly one door: a patch or commit. That door checks every changed path against the agent's allowed patterns, suffixes included, and rejects anything outside them before it reaches the repository.

| Boundary | Enforced by |
|---|---|
| A directory — "you own `modules/transactions/`" | Mount. Cheap and absolute. |
| A pattern — "but not `*.spec.ts`" | Exit checkpoint on the changed-file list. Blocks before anything leaves. |

This is not the after-the-fact ownership check. Nothing reaches the repository until it clears the checkpoint.

**This is not the case the cut rule describes.** This document elsewhere says a boundary that cannot be mounted means the wrong cut was chosen. That was about cut boundaries, where choosing a different cut is the fix. Colocated tests are a framework convention that appears under every cut, so there is no better cut to switch to.

**Greenfield work can avoid the checkpoint entirely.** When AVEL chooses the layout — as it does for every template — put tests in their own directories, not beside the source. Then every boundary is a directory and every boundary is a mount. Choose the layout that makes enforcement cheap. Client repositories are laid out however the client laid them out, and those need the checkpoint.

## Sandbox providers are a plug

The rooms are defined by AVEL. What actually runs them is interchangeable, and agents should neither know nor care which is underneath.

| Provider | When |
|---|---|
| **Local Docker** | Now. Free, works today, sufficient for building AVEL's own templates. |
| **MIOSA** | Once a written agreement exists. Its SDK provides isolated sandboxes, snapshots and teardown, per-sandbox outbound allowlists, credential handling in which the sandbox never sees the raw key, and deploy-from-snapshot with a recorded source. That last pair maps directly onto the running room and the delivery room. |
| **Daytona, E2B, or similar** | Available through the same interface if either of the above stops fitting. |

**Three conditions on MIOSA specifically:**

1. **Written agreement first.** MIOSA is the operator's employer's product. Record in writing that the agency may use it, on what terms, and what happens if the employment ends.
2. **No single dependency.** Keep local Docker working alongside it. The agency's client work must not break if access to an employer's infrastructure ends.
3. **Confirm readiness before client work.** The SDK was very new when evaluated. Before it holds a client's code, confirm it is production-ready, what it costs, and how it behaves when unavailable.

Start MIOSA with the running room, since that is where real isolation matters most.

## Tools that send code to a third party

Some agent tools send source code to an outside API — for example, context-retrieval tools that pass eligible source to a hosted model for relevance scoring. Two consequences:

- **The builder room's network allowlist widens** to include that provider, which is a real reduction in isolation.
- **Client code leaves the machine.** For AVEL's own templates this is acceptable. For client work — and especially for regulated clients, who are the core market — it requires the client's explicit consent, and some will refuse.

**Rule:** a tool that sends source off-machine runs on internal work only until two things are true: it has been measured to lower cost per *shipped* slice without lowering the first-pass gate rate, and the client has agreed in writing. Cost per attempt is not the measure. A cheaper tool that solves fewer tasks produces rework the gate then has to reject.

## Two kinds of isolation

Conflating these is what makes a sandbox seem expensive.

| | Isolation for correctness | Isolation for security |
|---|---|---|
| Question | Can an agent write where it should not? | Can hostile code escape and steal credentials? |
| Threat | An agent ignoring an instruction | A malicious dependency in a client's tree |
| Sufficient | Mounts, worktrees, containers | VM-level isolation, or no secrets to steal |
| Cost | None | Modest, and only for one component |

Agent authoring sessions are not hostile code. An agent writing TypeScript is your own tooling operating on your own machine. Correctness isolation is enough.

The verification runner is different. It executes `npm install` and `npm test` against a client's dependency tree, which is third-party code you did not audit. That is the one component where the security question is real.

Even there, the decisive mitigation is not a VM. If the runner holds no credential and has no network egress, a container escape yields a container on your laptop with nothing worth taking. The credential boundary is worth more than the isolation technology, and it costs nothing.

## Tier 0: now, no cost, worktree and container

This is the right answer for a solo operator at AVEL's current stage. See STATE.md. It is not a compromise. It is correctly scoped.

| Scope | Environment |
|---|---|
| Per mission | One container with the client repo mounted |
| Per agent | One git worktree, only its declared paths writable. **Not optional** — see below. |
| Verification runner | A separate container with no credential and no egress except the package registry |

What this provides:

- Every roster boundary mechanically enforced
- Agents unable to overwrite each other's work
- Ownership violations detected at write time
- Per-mission isolation between clients
- The credential boundary in place from day one

What it does not provide: containers share a host kernel, so this is isolation for correctness rather than a guarantee against hostile code. On macOS and Windows, Docker Desktop already runs containers inside a virtual machine, so there is a hypervisor boundary between container and host. Tier 0 is stronger on those platforms than on Linux.

The worktree half is already solved by `treehouse`, which provides a pool, leases with per-acquisition identity, in-use detection, and safe teardown with per-risk opt-in flags. Adopt the design at minimum. See PRIOR-ART.md, question T3.

**The worktree is the load-bearing half, not the container.** Concurrent sessions in one checkout are the failure mode this tier exists to prevent, and it was demonstrated on the first day the roster ran three sessions at once. See the section below.

### As built 2026-10-13: worktree-only

`[built]` module 7, step 7. Tier 0 is worktree-only (J, 2026-10-13; `DECISIONS-V2.md`). The container half of the table above is deferred: no local Docker room and no remote sandbox is built.

- **One room per dispatch.** Start opens a git worktree, detached at the source's pinned commit, under `%LOCALAPPDATA%\avel\rooms\<dispatchId>` (`src/rooms/provider.ts`, behind a `RoomProvider` interface). The source is an internal mission's template clone, or a client mission's one approved intake's repository clone (`DECISIONS-V2.md`, *render and delivery*), under `AVEL_SOURCES_DIR`; Tier 0 never fetches, since the GitHub credential lives only in the delivery room. Unresolvable is `source_unavailable`; resolved but unbuildable is `room_unavailable`.
- **File tools only.** The agent gets read, write, edit and list inside the room (`src/rooms/tools.ts`), called by the runner on its behalf. No shell, no installs, no network tool. Paths are refused when absolute, when they contain `..` or `.git`, or when they resolve, through a symlink or junction, outside the room or into `.git` (a link inside the room that leads to `.git` is refused as `git_dir`, 2026-10-21). An 8.3 short name segment (`~` and digits ending the base name, like `GIT~1` or `PROGRA~1.TXT`) is refused as `path_invalid`. This was reproduced on NTFS on 2026-10-21: `GIT~1/config` opened `.git/config`. Before the refusal, the realpath check already caught that read as `git_dir`, because realpath expands the short name. The refusal makes it the first line of defence.
- **The tool's write check is `[attestation]`.** Write and edit refuse paths outside the entry's writable globs, but that is the tool checking itself, not a mount: nothing at the filesystem stops a write. The mechanism is the exit checkpoint (`src/rooms/checkpoint.ts`), which lists every path changed since the pinned commit, untracked and ignored files included, and refuses any outside the globs with `writes_outside_mount`.
- **Rooms outlive their dispatch.** A halted or failed dispatch keeps its worktree so the operator can inspect the work, until an explicit release removes it. Nothing calls release from a route yet, and no table records rooms. Each kept room stays registered in its source clone's `.git/worktrees` until it is released, so those registrations pile up in the clone. They are harmless, and `git worktree prune` runs on every release.
- **The agent works through those tools and nothing else** (`[built]` step 9d, 2026-10-14; `STEP-9-PLAN.md`). The real harness runs the Claude Agent SDK with its working directory in the room, every built-in tool removed, AVEL's eight tools (`room_read`, `room_list`, `room_write`, `room_edit`, `skill_read`, `run_checks`, `report`, `finding`) as the only ones present, and a hook that denies any other call. It loads no settings or CLAUDE.md files and cannot start subagents. Its environment holds the API key and the system basics only: no database URL, no runner credential, no GitHub token. `run_checks` (2026-10-23) runs no command in the room: it commits the room's files and the gate's check runner runs the brief's checks on that commit in a container. The install from the commit's lockfile runs with the network, and the checks run without it, so an agent can reach that networked install whenever it calls the tool (`STATE.md`).
- **That is a tool boundary, not an OS boundary.** The SDK's process runs on the host with the operator's user privileges. Nothing at the OS stops it from reaching the network or other files; what stops the agent is that it has no tool to ask for them. `[attestation]` until a container provider runs it.

## Mounts stop writes. They do not stop whole-tree commands.

Found on the first day of the frontend build, 2026-08-29. Three sessions ran concurrently in one working directory with declared mounts. Two incidents, one cause.

**What happened.** A session ran `git add -A`, which staged 22 files belonging to two other sessions, both mid-write. Later, the same session ran a formatter across a directory it did not own and undid it with a directory-wide `git checkout --`, which discarded another session's uncommitted work. Nothing was permanently lost, and only because the work was minutes old.

**Neither incident was a boundary violation.** Every individual write stayed inside the declared mount. That is what makes this a defect in the model rather than a lapse in discipline.

> A mount constrains *where a process writes*. It does not constrain *what a command reaches*.

Any command whose target is the tree rather than a path crosses every mount at once while remaining, file by file, entirely legal:

| Command | Reaches |
|---|---|
| `git add -A`, `git add .` | every changed file in the repository |
| `git checkout -- .`, `git restore .` | every tracked file under the path |
| `git clean`, `git stash` | untracked or all modified files |
| A formatter or linter with a directory argument | everything under it |
| A codemod, a find-and-replace across the repo | everything matched |
| `rm -rf` on a shared parent | everything below |

The earlier claim in this document — that per-agent mounts make the roster's boundaries mechanical rather than advisory — is true for writes and false for these. Both halves need stating.

### The cause is one working directory

Three sessions shared one checkout. Under that arrangement a mount is an agreement layered over shared files: it stops a session writing where it should not, and it cannot stop a command that operates on the whole checkout.

**A worktree per session removes the class entirely.** `git add -A` inside a worktree stages that worktree. A directory reset resets that worktree. The blast radius of a careless command becomes the session's own work, which is a recoverable mistake rather than someone else's loss.

This is what `treehouse` is for, and it is already named in the Tier 0 table. It was not used on day one.

### Two rules, and the second is the real one

**Name the files.** `git add path/to/file`, never `-A` or `.`. Point a formatter at files, not directories. This is discipline, it decays, and it is worth stating anyway.

**Give each session its own worktree.** This is the mechanism, and it is the only one of the two that survives a tired operator at 2am.

Adopt the second. The first is what you do until the second exists.

### Consequence for the ownership check

`verification.ownership` compares the changed-file list against declared globs. Under one shared checkout it cannot distinguish *this agent wrote outside its mount* from *this agent's whole-tree command swept up another agent's legal write*.

Both appear as an out-of-mount change attributed to whoever ran the command. Under one worktree per session, the second case cannot occur, and the check means what it claims to mean.

## Mounts and the choice of cut

An earlier version of this section reported that NestJS co-locates a module's controller and service, concluded that the layer boundary was a file-suffix pattern no mount could enforce, and proposed diff checking as a second enforcement path.

That was the right observation and the wrong conclusion. It is a decomposition problem, not an enforcement problem. See ROSTER-V2.md.

The correct reading:

> If a boundary cannot be mounted, the cut is wrong for that codebase.

A layer cut on a layer-organized codebase mounts cleanly. A feature cut on a feature-organized codebase mounts cleanly. The suffix problem only appears when a layer cut is forced onto a feature-organized framework, and the fix is to change the cut rather than to add a second enforcement mechanism.

This makes the mount the arbiter rather than a convenience. **If you find yourself needing diff enforcement to hold a boundary, you have chosen the wrong decomposition for the stack.** Read the client's directory structure and choose the cut whose boundary is a directory.

Diff enforcement at phase close remains useful as a backstop, since a mount cannot catch everything and `verification.ownership` needs the data regardless. It is not a substitute for choosing correctly.

## Tier 1: at the first paying client, roughly four dollars per mission

Move only the verification runner to a real VM sandbox. Agent sessions stay local.

Use ComputeSDK so the provider is not a lock-in. E2B publishes $0.0504 per vCPU-hour and $0.0162 per GiB-hour, so a 2-vCPU, 4 GiB sandbox costs about $0.166 per hour. Daytona matches those rates and starts with $200 of credit and no subscription floor. Northflank is cheaper at $0.01667 per vCPU-hour, billed per second.

| Workload | Estimate |
|---|---|
| One verification run: build, tests, changed-file mutation, about 20 minutes | $0.06 |
| One agent session, one hour | $0.17 |
| A full mission: about 15 agent sessions plus about 20 exports | $4 |

Watch the floor rather than the rate. E2B's Pro tier is $150 per month. Its free Hobby tier gives a one-time $100 credit with one-hour session limits and up to 20 concurrent sandboxes. For a solo operator, Daytona's $200 credit with no monthly floor is the better starting point, and free tiers cover Tier 1 entirely for the first several missions.

The number that matters: sandbox compute is negligible next to token spend. A multi-agent mission runs at roughly fifteen times a chat session's tokens at frontier rates, which costs tens to hundreds of dollars. The sandbox costs four. Keep the attention on tokens. See COST-LOG.md.

## Tier 2: multiple concurrent clients, everything remote

Agent sessions and runners both move remote. Per-client isolation is enforced by the provider, and per-client concurrency caps prevent one mission from starving another.

Trigger: two clients running simultaneously, or the first client whose contract carries security requirements you have to answer for in writing.

## Runner selection within a tier

Which runner a step uses is a separate question from which tier it runs at. Tier decides isolation level; runner selection decides which harness executes the step, chosen from the ordered fallback chain in `DECISIONS-V2.md`.

**Tool-heavy steps route to a programmatic-tool-calling-capable runner when available.** A step that reads a schema, greps a repository, or checks a permission matrix returns a large raw result and needs a small answer. Left unfiltered, the raw result re-enters context in full. A PTC-capable runner lets the agent filter inside the execution environment first, so only the answer crosses back — published figures on this pattern show reductions from roughly 170,000 tokens to about a dozen for the same task.

**This does not create a harness dependency.** It is one more entry in the same ordered fallback chain used for every other runner selection, and the chain degrades to the next option exactly as it would for any other unavailability. Multi-harness, multi-model, no lock-in is the same principle the sandbox already runs on.

**Classification is mechanical.** A Skill declares its input/output shape; whether it is tool-heavy follows from that declaration, not from a per-call decision.

**Every PTC-eligible step logs its token count before and after** in `COST-LOG.md`. This is the first concrete, cheap measurement available against the project's top financial risk, and it should not be adopted without being measured — an unmeasured optimization is a guess wearing a citation.

## The runner enforces budget, not the agent

Every dispatch carries two ceilings on its `Dispatch` row, copied from its `RosterEntry`'s defaults (`DATA-CONTRACTS-V2.md`; specced 2026-10-06, before which the ceilings sat on the `RosterEntry` itself). The runner counts tokens as the agent works. At the **soft ceiling**, 1.5× the estimate, it warns and records that the ceiling was crossed, and the work continues. At the **hard ceiling**, 3× the estimate, it halts the dispatch. It also halts the whole mission when attributed spend reaches `Mission.spend_ceiling_usd`, and any dispatch that passes a wall-clock limit. A halted dispatch closes with `status: 'halted'` and a reason.

The hard ceiling is deliberately loose. Runaway loops overshoot by an order of magnitude, not by a margin, so a loose hard stop catches all of them without killing a task that merely ran long. The multiples are `[hypothesis]` and get set from recorded data after roughly ten runs.

**This lives in the runner because it cannot live in the agent.** An agent told to watch its own budget is judging its own performance, and an agent stuck in a loop is by definition not judging well. The limit must sit outside the thing it limits — the same principle as the credential never entering the runner.

**Halting is not failure.** A halted dispatch is a finding about the estimate, the task, or the agent, and it is recorded as data. Three halts on the same role say the estimate is wrong or the role is struggling; the completion reports say which.

## The agent's API token never enters a room

`[specced]` 2026-10-06; `[built]` for the real harness 2026-10-14. Each dispatch has an access token for AVEL's own API (`DATA-CONTRACTS-V2.md`, *Dispatch*). It is held by the dispatch runner, outside every room. An agent's tools call the runner over a local channel, and the runner makes the API call with the token.

- **The room where agent-written code runs has no network,** so a token inside it could not reach the API anyway. Keeping it in the runner means no room needs an exception to reach the API.
- **Code an agent writes can never read the token,** because the token is not in any environment the agent's code executes in. This is the same principle as the GitHub credential living only in the delivery room.
- **The runner sees every call an agent makes,** so it can count and log them alongside tokens used.
- **The token dies with the dispatch.** Closing or halting the dispatch makes it resolve to nothing on the next request. Nothing has to be revoked separately.

*As built 2026-10-14:* the runner and the agent's session share one process, the server's. The `report` and `finding` tools close over the token and call the server's own routes in process (`src/runner/agent-tools.ts`), so the token is never in the model's context, the session's environment or the room.

This is a different credential from the GitHub token. The agent token reaches only AVEL's API, under the agent's allowed actions, and the dispatch runner may hold it. The GitHub credential reaches client repositories, and only the delivery room holds it.

## What must not wait for Tier 1

Three things cost nothing today and are expensive to retrofit. These are one-way doors.

**The runner never holds the credential.** Render and verify in one process, deliver from another. `Connection.credential_ref` already names where the token lives rather than storing it. Make that a deployment topology boundary rather than a convention. The gateway resolves the token, and the gateway is not the runner.

**Egress is denied by default in the runner.** Allowlist the package registry and deny everything else. Most supply-chain payloads need to reach the network, so this defeats the common case for almost nothing. In Docker, use `--network=none` for the test phase, or a bridge with an egress filter during install.

**Per-agent writable mounts.** This is the point of the whole document. It costs nothing at Tier 0 and it is what makes ROSTER-V2.md true rather than aspirational.

## Answers to PRIOR-ART.md H1 through H5

**H1. Where does the verification runner execute?** At Tier 0, a local container with no credential and no egress. At Tier 1, a remote VM sandbox through ComputeSDK, with the provider chosen on free-tier terms rather than benchmark rank. Answered.

**H2. Is egress denied by default with a registry allowlist?** Yes, from Tier 0. Non-negotiable and free. Answered.

**H3. Is it architecturally guaranteed that the runner never accesses the credential?** Yes. Different process, different environment, no shared secret store. Enforced by deployment topology rather than by code review. Answered.

**H4. Cost per export at realistic client-repo size?** Estimated above. Needs a real number from CounselOS Slice 0. Log it in COST-LOG.md.

**H5. Does pg-boss still win once verification runs remotely?** Open. Deferred until a Tier 1 run produces real timings.

## Build order

1. Credential and egress boundary. Free, a one-way door, do it first.
2. **Per-agent worktree** with declared mounts. This is what makes ROSTER-V2.md real, and it is what stops a whole-tree command from crossing a boundary that every individual write respected.
3. Ownership violation detection at write time, feeding `verification.ownership`.
4. Measure one CounselOS slice and put the number in COST-LOG.md.
5. Then decide Tier 1.

Steps 1 and 2 need no provider account, no spend, and no architectural commitment.

## Open questions

| Question | Blocking |
|---|---|
| Concrete mount globs per agent for the CounselOS stack | Yes. Blocks step 2. |
| One container image per phase, or one image for all agents? | Before step 2. |
| Where do worktrees live, and what prunes them? | **Now.** Blocking any further concurrent session work. `treehouse` has the answer. |
| Does the ownership check distinguish an out-of-mount write from a swept-up file? | Resolved by worktrees — under one checkout it cannot. |
| H4: real cost per export | After Slice 0. |
| H5: pg-boss versus an external durable runtime | After a Tier 1 run. |
