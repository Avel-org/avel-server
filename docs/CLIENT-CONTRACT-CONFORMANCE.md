# Client-Side Contract Conformance

**Status: `[unspecified]` — this document states the problem and the open decisions. It is not yet a spec.**

*This is the missing half of the top-priority fix. Until the questions below are answered, "machine-verified contract conformance" describes AVEL's own repo and nothing about client work.*

---

## The problem, stated precisely

Two different artifacts are being conflated.

| | AVEL's contract | The mission contract |
|---|---|---|
| **What** | `src/contract/` — ts-rest routes for the Command Center's own API | The interface the data agent locks in phase 1, that everyone builds against in phase 2 |
| **Where** | AVEL's repo | The **client's** repo |
| **Stack** | Fixed: TypeScript, ts-rest, Zod | **Whatever the client uses.** Not controlled. |
| **Diffed by** | `oasdiff` in AVEL's CI | **Nothing.** |
| **Frozen as** | `Export.contract_sha256` | — |
| **Answers** | "What tooling interface did this mission build against?" | "Did phase 2 conform to phase 1?" |

`contract_sha256` answers the first question exactly. The alignment gate — the one promoted to the top of the queue because inter-agent interface misalignment is a leading documented cause of multi-agent failure — is about the second.

**The alignment gate is still an attestation.** The data agent writes the contract; the state agent reads it and writes a file saying "this matches." Nothing verifies that claim. That is precisely the contradiction the empirical gate exists to prevent:

- Don't trust an agent when it says the tests pass ✅ *(closed — artifact + mutation score)*
- Do trust an agent when it says the contract matches ❌ *(open)*

---

## What has to be true for this to work

**1. Phase 1 must emit a machine-diffable artifact, not prose.**
The contract file the data agent writes today is markdown. Markdown cannot be diffed for breaking changes. Phase 1 must produce a structured artifact at a known path in the client repo.

**2. Phase 2 must be mechanically derivable.**
Something must extract the *actual* interface the built code exposes, in the client's stack, without an agent describing it.

**3. The diff must run in the verification job**, alongside build/tests/analysis/mutation, and land in `Export.verification.conformance`.

**4. There must be a defined behaviour when 1 or 2 is impossible** in a given client stack.

---

## Open decisions

### D1 — The artifact format
**Options:**

| Option | Emitted by phase 1 | Diffable by | Works when |
|---|---|---|---|
| **OpenAPI JSON** | Data agent writes an OpenAPI spec directly | `oasdiff` — already in the stack | Any HTTP API, any language |
| **Zod schemas as source** | Data agent writes `contract/` in the client repo, same pattern as AVEL | Custom differ, or generate OpenAPI then `oasdiff` | Client stack is TypeScript |
| **GraphQL SDL** | Data agent writes the schema | `graphql-inspector` | Client uses GraphQL |
| **Per-stack adapter** | Whatever fits | An adapter per ecosystem | Most flexible, most work |

**Recommendation to decide against:** OpenAPI JSON as the required artifact, with `oasdiff` reused. It is stack-agnostic, the tool is already a dependency, and it makes the client-side gate the same mechanism as AVEL's own. The Zod option is more ergonomic but only for TypeScript clients — which is a real constraint on who AVEL can serve.

### D2 — How phase 2's actual interface is extracted
This is the harder half. Options:

- **Generate from the implementation** — most frameworks can emit OpenAPI from routes (FastAPI, NestJS, Hono/ts-rest, Rails with rswag). Requires the phase-1 contract to mandate a framework capable of it.
- **Exercise it** — run the test suite against the running service and capture the observed surface. Weaker (only covers what's tested) but stack-agnostic.
- **Static extraction** — a parser per stack. Most accurate, most maintenance.

**Note:** whichever is chosen, the extraction must be run by the verification runner, **not by an agent that reports its result.** An agent generating the phase-2 spec and handing it over reintroduces the attestation one layer down.

### D3 — What counts as breaking
`oasdiff` has a default breaking-change set. Decide whether AVEL uses it as-is or adds rules — e.g. is adding a required response field breaking for AVEL's purposes? Whatever is chosen must be config under source control, not a per-mission setting. *(Same failure mode as the mutation threshold.)*

### D4 — Degradation
When a client stack cannot produce a diffable artifact:

- **(a)** The mission type cannot be `full-build` — conformance is a mandatory gate and the mission is refused.
- **(b)** The gate degrades to `warn` and the export carries a visible marker that conformance was unverified.
- **(c)** A manual conformance review is recorded as a `gate_override` with justification.

**(b) is the likely answer**, but it must be *visible* — an unverified conformance gate that looks like a passed one is worse than no gate.

### D5 — Where the artifact lives in the export
Proposed: `.avel/contracts/phase1.openapi.json`, frozen into the snapshot and hashed into `version_manifest` as `mission_contract_sha256` — distinct from `contract_sha256`, which is AVEL's own.

---

## Interim position, until this is built

**Say what is true.** The alignment gate is currently an attestation. It should be labelled `[attestation]` everywhere it appears — in `PRODUCT.md`, in the export, and in any client-facing material — and not counted among the mechanical gates.

An attestation honestly labelled is a known gap. An attestation described as verification is the exact failure this product exists to prevent, occurring inside the product.

---

## Blocking

This document blocks:
- The export engine's `verification.conformance` field shape
- Any claim that contract conformance is machine-verified
- The alignment gate becoming mechanical

It does **not** block the export engine generally — build, tests, analysis, coverage, mutation, and ownership can all ship first, with `conformance` nullable.
