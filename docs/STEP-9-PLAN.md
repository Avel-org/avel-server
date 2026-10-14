# Unit 6+7+8, step 9: the dispatch brief and the real harness

Approved by J on 2026-10-14. The real-model parts (9d, 9e) still wait on J's default model, its prices (input, output, cache read, cache write) and an OK for the ~$2 smoke run.

## J's decision

Every dispatch brief has the same four parts, and every requirement names a check outside the agent.

1. **Scope.** The module and its requirements from the approved plan. Canon's "what an expert would add" arrives later as operator-approved plan changes (module 14). The agent never widens its own brief at run time.
2. **Read.** The raw sources: repo paths at the room's commit, plus the client files the brief lists. Never Canon's summaries. Hashed with the brief.
3. **Method.** The stack and domain skills that apply.
4. **Done when.** One check per requirement that isn't the agent's word: a test, a command, a type check, or a file that must exist.

A requirement with no outside check is refused. The gate (module 9) runs the checks.

## How it maps onto Claude's own briefing

| Claude | AVEL |
|---|---|
| Project | Mission |
| Project instructions and knowledge | The brief and the files it lists |
| One chat | One dispatch |

## The brief

The server renders the brief from the plan. The renderer is pure and deterministic, and the brief is frozen when the dispatch starts.

- **Scope:** the module's name, its requirement texts and their acceptance criteria. No route lets an agent change a plan.
- **Read:** the module's `reads` paths at the room's commit, plus the approved intake's `sourceMd` as the client source. AVEL holds no other client files yet. No Canon text.
- **Method:** the stack and domain skills from `dispatchSkillSet`, listed by slug with one line each.
- **Done when:** each requirement's checks, written out.

The system prompt is the `claude_code` preset with the identity, then the brief, appended. The first user message reads: "Do module `<name>`. You're done when these checks pass: …. File your report when you finish or are blocked."

The Dispatch gains three fields:

- `briefMd`: the rendered brief.
- `briefSha256`: covers the rendered brief, including the blob shas of the Read files.
- `harnessVersion`: the SDK version. The preset's text isn't AVEL's to hash, so the version is recorded instead.

`agentVersionSha256` and `skillsSha256` are unchanged.

## Plan shape

These are plan additions, like `modules`, so `approvedBriefChanges` is untouched.

- `modules[].reads: string[]`: repo-relative paths or globs, at most 100.
- `brief.checks: [{ id, requirementId, kind, path?, command?, note }]`. `kind` comes from a closed list: `file_exists`, `test`, `typecheck` and `command`.

**checkPlan rule 5:**

- Every requirement has at least one check.
- Check ids are unique.
- Each `requirementId` exists.
- A `file_exists` check has a `path`; every other kind has a `command`.

Issues sit at `["brief","checks",i,…]` or `["brief","requirements",i]`. A failure blocks mission start through the existing `plan_check_failed`.

**New precondition reason `requirement_unchecked`:** dispatch create and dispatch start refuse when a `briefRef` requirement has no check. This catches missions that started before rule 5 existed. Details go in `details.issues`, and FE adds the copy the same day.

## Running the checks

Test, typecheck and command checks run the client's code, which needs the Docker running room that is on hold. Step 9 only carries the checks in the brief. Module 9, the gate, runs them and stores the results on the completion report. While the Docker room stays on hold, the gate runs only `file_exists` checks and marks the rest `not_run` (needs a running room). Real gating needs the hold lifted, and J decides when.

## The harness (Claude Agent SDK)

Checked against code.claude.com/docs/en/agent-sdk on 2026-10-14.

| Option | Value | Why |
|---|---|---|
| `cwd` | the dispatch's room | |
| `settingSources` | `[]` | `["project"]` would load CLAUDE.md from the room and every parent directory, and the room's `.claude/settings.json` with its hooks. A client repo's hooks would then run shell commands on the host, which breaks D2. Omitting the option now loads everything, including `~/.claude`. |
| `strictMcpConfig` | `true` | No connectors except AVEL's |
| `tools` | `[]` | Removes every built-in tool: Read, Write, Bash, Agent, Skill and the rest. The built-in Read could open any file on the host. |
| `mcpServers` | `{ avel: createSdkMcpServer(...) }` | In-process tools: `room_read`, `room_write`, `room_edit` and `room_list` (src/rooms/tools.ts, with its path, symlink and `.git` refusals), plus `skill_read`, `report` and `finding` |
| `allowedTools` | the `mcp__avel__*` names | `allowedTools` only auto-approves; `tools` is what restricts |
| `disallowedTools` | `["Agent", "Task"]` | The subagent tool is now `Agent`; `Task` is its alias. One dispatch is one agent. |
| `permissionMode` | `"dontAsk"` | Set explicitly, because the default may now be `auto` |
| `hooks.PreToolUse` | deny anything not `mcp__avel__*` | Defense in depth. Hooks run first, and a deny wins. |
| `systemPrompt` | `{ type: "preset", preset: "claude_code", append: identity + brief }` | |
| `maxTurns` | a backstop, recorded on the dispatch | |
| `maxBudgetUsd` | a backstop above the hard ceiling | It's a client-side estimate. The runner's ceilings are the real limit. |
| `abortController` | the runner's halt | |
| `env` | `PATH`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, `CLAUDE_CONFIG_DIR` set to a per-runner directory | `env` replaces `process.env`. The DB URL and `AVEL_RUNNER_CREDENTIAL` are never passed. |

- **CLAUDE.md:** AVEL never writes or loads one. A client repo's own CLAUDE.md is an ordinary file the agent may read if Read lists it.
- **Skills:** none are copied into the room. The system prompt lists each skill's slug, and `skill_read(slug)` returns its body on demand.
- **The dispatch token stays in the runner.** The in-process `report` and `finding` tools close over it, and the agent never sees it.
- **Usage:** a message's `output_tokens` is a placeholder while it streams. The runner counts from `message_delta` events (`includePartialMessages`), dedupes by message id, and reconciles against the result message.
- **Fallback (D1):** the Claude Code CLI, then `failed` with a system-filed report.

## Build order

There is one handoff and pin per step.

| Step | What | Needs |
|---|---|---|
| 9a | Contract: plan `reads` and `checks`, `requirement_unchecked`, and Dispatch `briefSha256`, `briefMd` and `harnessVersion`. Migration 0027. | FE copy the same day |
| 9b | checkPlan rule 5 and the dispatch refusal; seed missions get checks | J's OK for the avel_dev rebuild |
| 9c | The pure brief renderer and its hash, frozen at start | — |
| 9d | `AgentSdkHarness` behind the existing `Harness` interface, and the runner ticking in-process. FakeHarness stays the default and the test harness. | J's model and prices |
| 9e | Opt-in smoke run, ~$2 ceiling, logged in COST-LOG | J's OK |

Step 10, the docs, follows.

## Frontend work

- The plan editor gets "How it's checked" for each requirement, and Read paths for each module.
- The dispatch shows its brief.
- Copy for `requirement_unchecked`.
- Check results in the report view, once module 9 lands.
