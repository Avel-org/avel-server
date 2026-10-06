# Using Design Plugins in CounselOS

How to run the Design and Modern Web Guidance plugins without breaking the mount boundaries the agent system depends on.

Related: ROSTER-V2.md defines the boundaries. SANDBOX.md explains why they are mounts rather than rules.

## The problem these plugins create

Design plugins are horizontal. They want to look at tokens, components, tests, and markup across the whole codebase and change what they find.

Every agent in CounselOS is vertical. Atlas · transactions owns `modules/transactions/` and nothing else. Nemi owns test directories and cannot write source at all.

Run a design plugin inside a dispatch and it will write outside the mount. That fails the ownership check, and it fails it for a reason that is not really a violation — the plugin was doing its job and the job does not fit the shape.

**The rule:** design plugins produce findings, not edits.

That puts them in the same posture as Zane and Brennan. They read everything, they write to `findings/`, and a feature agent applies the changes inside its own mount.

## Install

Both plugins live in the catalog. Install from the card, or search for them in the plugin browser.

| Plugin | What it covers |
|---|---|
| Design | Critique, design system management, UX writing, accessibility audits, research synthesis, dev handoff |
| Modern Web Guidance | Current web best practices, so agents build against 2026 patterns rather than training-data averages |

After install they activate on the work. There is no command to memorize — describing the task is enough.

## The three ways to run them

### 1. Advisory session — the default

A session with no dispatch open, no branch, and no intent to edit source.

```
Open a session in the repo.
Ask for the audit or critique.
Write the output to findings/design/.
Close the session.
```

Nothing is modified. The findings file names files, lines, and recommended changes. A feature agent picks it up on its next dispatch and applies what falls inside its mount.

This is correct for accessibility audits, design system critiques, and anything that spans features.

### 2. Inside Fantem's mount — for token and primitive work

Fantem owns `apps/web/src/styles/` and `apps/web/src/components/ui/`. Design system work legitimately lives there.

A design plugin running in a Fantem dispatch can edit directly, because tokens and primitives are Fantem's territory. The ownership check passes because nothing is being violated.

Use this for the breakpoint token gap, spacing scales, type ramps, and base component behavior.

### 3. Inside a feature agent's mount — for one screen

Atlas · transactions owns its own UI. A design plugin running in a transactions dispatch can improve `components/features/transactions/` and stay inside the boundary.

Use this when the scope is genuinely one feature. Do not use it when the plugin starts recommending token changes, because tokens are Fantem's.

**The test:** if the recommendation touches more than the dispatching agent's mount, it becomes a finding rather than an edit.

## What to run first

Two bounded tasks with clear value.

**Breakpoint tokens.** Mission 002 lists this as the one gap the current token system does not close. Bounded, sits in Fantem's mount, and mode 2 applies directly.

**Accessibility audit of the Slice 1 transactions UI.** *Corrected 2026-10-05:* accessibility is a code role, an axe scan, not Nemi (`ROLES.md`). The scan is the only thing that covers it, so there is no redundancy on that discipline. A second independent read is worth more here than anywhere else in the system.

Run the audit as mode 1 and write to `findings/design/a11y-slice-1.md`. The axe scan is the primary; the plugin's output is the check on it.

## Wiring the output into the process

Findings from a plugin should look like findings from an agent, so the same handling applies.

```
findings/
  design/
    a11y-slice-1.md
    design-system-critique.md
    tokens-breakpoints.md
```

Each finding carries:

| Field | |
|---|---|
| Source | Which plugin, which session, what date |
| Files | Paths and line numbers |
| Severity | blocking · drift · cosmetic |
| Owner | Which agent's mount the fix falls in |
| Applied | Empty until a dispatch closes it |

The **Owner** field is what makes this work. A finding without an owner is a finding nobody will apply, and a finding assigned to the wrong mount produces an ownership violation on the next dispatch.

## What not to do

**Do not run a design plugin during an active feature dispatch on work outside that feature.** The plugin will find real problems in Fantem's tokens while the transactions agent is working, and applying them puts a write outside the mount.

**Do not let a plugin edit test files.** Phase C agents own tests, and they cannot write source for a reason. A design plugin editing both is the self-grading problem in a different costume.

**Do not treat plugin output as a gate.** These are advisory. The gates are the API test and the browser test, and neither of them cares what a design critique concluded. A plugin finding is input to a dispatch, never a pass or block.

**Do not run them concurrently with a dispatch that touches the same files.** Append-only conflicts already caused a manual merge on the decision log. The same shape applies to any shared file.

## Modern Web Guidance specifically

This one is different in kind. It is not producing findings, it is keeping the agent current on patterns.

Its value is highest **at dispatch time**, inside whichever agent is building UI, because the whole point is that the code being written uses current practice rather than a training-data average.

That does not cross a boundary. It changes how the agent writes within its own mount, which is exactly where you want it.

## Recording the decision

If these become part of the process rather than a one-off, they belong in the decision log with the mode each is used in. Otherwise the next session will re-derive the boundary question and possibly answer it differently.
