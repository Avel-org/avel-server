# AVEL Command Center

**The mission compiler for AI software development.** Assemble a team of specialist AI agents, equip them for the job, and export a mission package that can't ship work it hasn't proven.

*This document owns the external pitch. It states no schema, no stack, and no build status. For status see `STATE.md`; for shapes see `DATA-CONTRACTS-V2.md`; for tools see `TECH-STACK.md`.*

---

## Status, first

Build status, module by module, is in `STATE.md`. No other document states it.

Two independent architecture reviews reached the same verdict: the design is aimed at real, documented problems and is ahead of its evidence. That is the honest position, and it is stated here rather than at the bottom because everything below should be read against it.

---

## The problem

AI writes a lot of code now. The bottleneck moved.

Industry measurement of AI-assisted teams reports a consistent shape: substantially more pull requests merged, materially longer review time per change, and larger diffs — with comparative studies finding higher defect rates in AI-authored changes than human ones. Developer surveys through 2025 showed near-universal daily AI use alongside a minority reporting high trust in the output. `[hypothesis — see Sources; figures pending citation]`

That gap between *usage* and *trust* is the whole problem. It has a specific shape:

> **AI produces work that looks finished but isn't.** Plausible, confident, subtly broken. It compiles. The tests pass. The demo works. And something is wrong in a way nobody notices until it matters.

It gets worse when you point multiple agents at the same codebase. Published analysis of multi-agent system failures across production frameworks found high failure rates, and identified the dominant causes as **bad specification** and **agents misunderstanding each other** rather than model capability. The conclusion is the important part: better models won't fix this. It's an architecture problem. `[hypothesis — see Sources]`

And agents game verification. Documented cases include a frontier model modifying its own evaluator to report success, with the behavior persisting or increasing under instruction not to. An AI saying "the tests pass" is not evidence that the tests pass. `[hypothesis — see Sources]`

---

## What the Command Center is

A TypeScript server and a web client, built for web, desktop and mobile, where you build a mission and export it.

**You assemble a squad.** Specialist agents, each with one job and hard boundaries: a builder that can't write its own tests, a tester that can't touch source, a reviewer that can only write findings. The work is defined as roles; agents are assigned the roles a project needs. `[specced]`

**You equip them.** A **skill** is either *knowledge* the agent reads or a *capability* — a tool the agent's sandbox actually provides, so an ungranted tool simply isn't there. Skills attach to roles, projects, and domains rather than to individual agents, and only reviewed skills can be attached. See `SKILLS.md`. **Knowledge entries** are what previous missions learned. Each agent's identity is generated from the roles it covers, never hand-written, so it cannot drift from the role catalog. `[specced]`

**You export.** The Command Center renders the mission into a package and delivers it — as a downloadable zip, a pull request, or a direct commit. Then the agents run in Claude Code, and the work comes back through the same gates it left by. `[specced]`

The agents work in **waves with gates between them**. Nothing builds until the contracts are locked. Nothing advances on a failed gate. And nothing ships on an agent's word. `[specced]`

---

## The core mechanism: measured, not trusted

The one thing that most defines this product:

**An export won't deliver unless the build is green, the tests pass, static analysis is clean, coverage hasn't regressed, and the test suite survives mutation — all read from a result artifact produced by a real runner, never from an agent's claim that it works.** `[specced]`

The mutation requirement is the part that matters most. A suite that executes code without asserting anything passes an ordinary green check. Mutation testing alters the source and fails if the suite doesn't notice — and it does not care which agent wrote the tests, which is exactly why it works where a rule about roles would not.

Everything else — the deterministic render, the frozen snapshot, the version manifest, the idempotency key — exists so that the artifact you verified is the artifact that shipped, reproducibly, every time.

Applied to a domain where the thing you're supervising will confidently tell you it succeeded when it didn't, that discipline stops being bureaucracy and starts being the point.

---

## Who it's for

**Primarily: an expert operator running an AI development agency.** Someone who ships client software with AI agents, cares that the output is actually good rather than merely plausible, and is tired of being the only quality gate. The Command Center is the cockpit for that person — it holds the roster, the rules, the sequencing, and the proof.

**Secondarily: small teams running file-driven agents** who've hit the wall where three agents produce three reasonable-but-incompatible answers, and who want structure rather than more prompting.

**Not for:** anyone who wants a chatbot that writes code. That already exists, it's good, and this isn't competing with it. This is for the layer above — the part that decides *which* agents, with *what* rules, in *what* order, and whether the result is allowed out the door.

---

## Why it works this way

**The core is deterministic, permanently.** No AI inference runs inside the render, the freeze, the gates, or the delivery. That's not a limitation to be fixed later — it's the design. Nondeterminism belongs in the agents; certainty belongs in the platform.

The honest scope of that guarantee: determinism buys **reproducibility and auditability** — the same inputs render the same bytes, and what was verified is what shipped. It does not by itself make the output correct. The gates do that work; determinism makes the gates trustworthy.

**Boundaries are structural, not advisory.** An agent doesn't avoid fetching data because it was asked nicely; the seam makes it someone else's job. The approve button isn't styled disabled, it's disabled by state. Rules you have to remember get forgotten. Rules built into shapes don't.

**Contracts come first.** Interfaces lock before parallel work starts. Every seam between two agents is an explicit contract, which is what makes a violation *detectable* — you can't catch a mistake nobody defined as a mistake. `[specced — the client-side half is unbuilt; see CLIENT-CONTRACT-CONFORMANCE.md]`

**Every mission should teach the next one.** The design is for agents to write structured records that feed back into a knowledge vault. **This is deliberately unbuilt.** Memory systems have the field's worst documented failure modes — a poisoned entry is inherited by every agent after it — and building retrieval against an empty vault optimizes nothing. Write-back waits until roughly ten real missions exist. `[hypothesis]`

---

## What it isn't

- **Not a model.** It doesn't do inference. It packages and gates work done by Claude Code.
- **Not "25 AI agents."** <!--allow-stale--> A catalog of roles, assigned to a small set of named model agents per project, plus one human operator and a set of code functions. Counts are in `STATE.md`. The code functions stay code permanently. Replacing a provably correct function with a probably correct one is not an upgrade.
- **Not a general orchestration framework.** LangGraph, CrewAI, and the OpenAI Agents SDK own that space, and they run inference. This is the authoring, sequencing, and gating layer above the runtime.
- **Not proven.** See the top.

---

## The bet

AI can build real software today. What it can't do is **know when it's wrong**.

So this isn't an attempt to build a smarter agent. It's the structure that catches the wrongness before it ships — and the discipline that never confuses being told something works with knowing that it does.

---

## Sources

**This section is incomplete and blocks external use of this document.**

Every statistic in "The problem" is currently uncited. In a document whose thesis is *measured, not trusted*, going to prospective clients, an uncited number is the single most attackable thing in it. Fill these in with primary sources and exact figures, or delete the numbers and keep the qualitative claim.

| Claim | Likely source to verify | Status |
|---|---|---|
| PR volume ↑, review time ↑, diff size ↑ under AI assistance | Code-analytics research on AI-assisted repositories (e.g. GitClear code-quality reports; DORA / Faros AI engineering-metrics reports) | ⬜ unverified |
| Higher defect rate in AI-authored PRs vs. human | Comparative defect studies | ⬜ unverified |
| ~90% daily AI use vs. minority high trust | Stack Overflow Developer Survey; DORA State of AI-assisted Development | ⬜ unverified |
| Multi-agent failure rates across production frameworks; causes are specification and inter-agent misunderstanding | The multi-agent failure taxonomy work (MAST / "Why Do Multi-Agent LLM Systems Fail?") | ⬜ unverified |
| Model patching its own evaluator; behavior persisting under instruction | Frontier-lab reward-hacking / specification-gaming evaluations | ⬜ unverified |

**Rule:** no figure returns to the body text without a link and a date. Approximations ("roughly twice") are fine; unsourced approximations are not.
