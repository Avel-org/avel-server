# Blast Radius & Pre-Flight

**Status: `[specced]`. Shapes and behaviour are decided. Build status is in `STATE.md`.**

*Owns: the pre-delivery preview — reading the target repo, diffing against the rendered package, and the dry-run path. Rationale for the decisions is inline here rather than in `DECISIONS-V2.md` because this document is the decision.*

*Related: `DATA-CONTRACTS-V2.md` (Export shape) · `CLIENT-CONTRACT-CONFORMANCE.md` (a separate gate, not this one).*

---

## The question this answers

> **If I press deliver, what exactly changes in my client's repository?**

Every file in the rendered package lands in one of four states relative to the target repo:

| State | Meaning |
|---|---|
| **CREATE** | Path does not exist remotely. New file. |
| **OVERWRITE** | Path exists remotely **and content differs**. Destructive. |
| **UNCHANGED** | Path exists remotely and content is byte-identical. No-op. |
| **PRESERVE** | Exists remotely, not in the package. Untouched. |

`UNCHANGED` is why this is a content diff and not a path diff. A re-export of an unmodified mission should report zero overwrites, not fourteen.

---

## The TOCTOU problem — read this before anything else

**Between preview and delivery, the client's repo can change.**

Preview says 3 overwrites. Ten minutes later you press deliver. Someone pushed in between; it is actually 5, one of them a file that did not exist when you looked.

This is a time-of-check/time-of-use bug sitting inside the screen whose entire job is making an irreversible action safe. **A preview that can silently go stale is worse than no preview** — it manufactures confidence.

### The guard

1. The preview records `base_commit_sha` — the SHA of the branch tip it was computed against.
2. At delivery, re-read the tip.
3. **If it moved, refuse.** Error `PREVIEW_STALE`, with both SHAs and what changed.
4. The operator re-previews. No auto-retry, no silent recompute.

**No exception for "the changed files don't overlap."** Overlap detection is a judgment call about someone else's repo, made by code that cannot see intent. Refuse and re-preview; it costs one API call.

---

## Reading the remote tree

### The API

GitHub Git Trees, recursive:

```
GET /repos/{owner}/{repo}/git/trees/{branch_sha}?recursive=1
```

Returns every path in the tree with a **blob SHA** per entry.

### Why blob SHAs make this cheap

A git blob SHA is:

```
sha1("blob " + <byte_length> + "\0" + <content>)
```

That is computable locally on rendered bytes. So:

```ts
function gitBlobSha(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
```

**One API call gives a complete content diff. No file is ever downloaded.** For a package of 20 files against a repo of 3,000, that is one request.

### Constraints

| Constraint | Handling |
|---|---|
| `truncated: true` on very large repos (~100k entries / 7MB) | Fall back to a **path-scoped** tree call on `.avel/` only. If that also truncates, fail with `TREE_TOO_LARGE`. |
| Rate limit | Cache the tree per `(repo, commit_sha)`. Same SHA = same tree, always. |
| Empty repository | No tree exists. Every file is CREATE. Not an error — see below. |
| Branch does not exist | Not an error for `github_pr` (branch will be created from default). Compare against the **base** branch. |
| Git LFS pointers | Blob SHA is the pointer's, not the content's. AVEL never writes LFS paths; flag as a violation if a package path collides with one. |
| Symlinks (mode `120000`) | A package path colliding with a symlink is a **violation**, not an overwrite. |
| Submodules (mode `160000`) | Same — violation. |
| Case-insensitive collisions (macOS/Windows clients) | `.avel/Agents/x.md` vs `.avel/agents/x.md` are distinct to git, one file to the client. Detect and flag as a violation. |

---

## Computing the diff

**Keep it pure.** Fetching is IO and belongs in the gateway. Diffing is a function.

```ts
computeBlastRadius(
  rendered: RenderedFile[],     // { path, bytes, blobSha }
  remote: RemoteTree,           // { commitSha, entries: Map<path, {sha, mode}> }
  policy: BlastRadiusPolicy,    // { allowedPathPrefixes, declaredWritablePaths }
): BlastRadius
```

No network, no database, no clock. Same render-vs-deliver split the architecture uses everywhere: pure core, IO at the edge.

### Do not enumerate PRESERVE

A client repo has thousands of untouched files. Listing them is noise that buries the three lines that matter.

```
PRESERVE   2,412 files untouched
           src/ · tests/ · package.json · .github/ · docs/
```

Count plus untouched top-level directories. That is the whole entry.

### Violations — the hard failures

A violation blocks delivery regardless of gate policy. This is `writable_paths` enforced at the **repo boundary** rather than the agent boundary.

| Code | Condition |
|---|---|
| `PATH_OUTSIDE_ALLOWED` | A rendered path falls outside `allowedPathPrefixes` (default: `.avel/`) |
| `PATH_TRAVERSAL` | Path contains `..`, is absolute, or normalizes outside the repo root |
| `SPECIAL_FILE_COLLISION` | Target is a symlink, submodule, or LFS pointer |
| `CASE_COLLISION` | Two rendered paths, or a rendered path and a remote path, differ only in case |
| `PROTECTED_PATH` | Target matches `.git/`, `.github/workflows/`, or a repo-policy denylist |
| `OWNERSHIP_VIOLATION` | An agent wrote outside its declared `writable_paths` (from `verification.ownership`) |

**Path normalization happens before every comparison.** POSIX separators, no leading slash, NFC Unicode normalization. A path that changes under normalization is itself a violation.

---

## The dry-run path

### Decision: a dry run is a real Export row

`dry_run: true`, terminal at a new `previewed` status. **It is never promoted.** The real export re-renders from scratch.

### Why re-rendering is not waste

**The render is deterministic. So the real export's package hash must equal its preview's,** compared under the same versioned hash definition. *Decided 2026-10-05: this compared `snapshot_sha256` before; it compares `package_sha256` (`DATA-CONTRACTS-V2.md`, `EXPORT-ENGINE.md` §13).*

If it does not, something nondeterministic leaked into the render path — an unsorted map, a timestamp, a locale-sensitive comparison — and it has been caught automatically, on this export, before delivery.

```
if (realExport.package_sha256 !== preview.package_sha256)
  → fail with DETERMINISM_VIOLATION, do not deliver
```

**This is a determinism gate obtained as a side effect of previewing.** It runs on every export, costs nothing beyond a render that was happening anyway, and it verifies the single architectural property everything else rests on. It is the cheapest high-value mechanism currently available to this project.

`preview_export_id` links the real export to the preview it was approved from. Delivery without a linked preview is refused for `github_push`; allowed with a warning for `github_pr`; irrelevant for `zip`.

---

## Lifecycle

```
pending → rendering → verifying → previewing → previewed | delivering → pr-open → done | closed | failed

dry run:   … → previewing → previewed                      (terminal)
real:      … → previewing → delivering → done              zip, github_push
           … → previewing → delivering → pr-open → done    github_pr, PR merged
                                                 → closed  github_pr, PR closed without merging
           any stage → failed
```

`previewing` and `delivering` are new. **Both paths run `previewing`**, so the pre-flight screen and the delivery path share one code path — the preview is not a separate simulation that can drift from reality.

**`pr-open` is not terminal.** The GitHub webhook moves it to `done` when the PR merges and to `closed` when the PR is closed without merging. Without `closed`, an abandoned PR would sit in `pr-open` forever. Decided 2026-10-05.

The value lists are exported from the contract as `EXPORT_STATUSES` (and `MISSION_STATUSES`) in `src/contract/shared/status.ts`; the database pgEnums are built from them. The shape is in `DATA-CONTRACTS-V2.md`, *Export*.

---

## Schema

Added to `Export`. *Decided 2026-10-05: these five fields and the `previewing`, `previewed` and `delivering` statuses are in the canonical Export shape in `DATA-CONTRACTS-V2.md`, which wins on any difference.* The `BlastRadius` type below is owned here.

```
dry_run              boolean, default false
preview_export_id    FK → Export, nullable        which preview this was approved from
base_commit_sha      text, nullable               the tip the diff was computed against
base_ref             text, nullable               branch name
blast_radius         jsonb, nullable              see below
```

```ts
type BlastRadius = {
  computedAt: string
  baseRef: string
  baseCommitSha: string
  target: { owner: string; repo: string; branch: string }

  create:    FileEntry[]
  overwrite: OverwriteEntry[]
  unchanged: FileEntry[]

  preserveSummary: {
    fileCount: number
    topLevelDirs: string[]
  }

  violations: Violation[]

  totals: { create: number; overwrite: number; unchanged: number; violations: number }
}

type FileEntry      = { path: string; bytes: number; blobSha: string }
type OverwriteEntry = FileEntry & {
  remoteBlobSha: string
  remoteLastModified?: string    // best-effort; one commits call, may be omitted
}
type Violation      = { code: ViolationCode; path: string; detail: string }
```

**`blast_radius` is a separate column, not a field inside `verification`.**

Verification asks *is the work good.* Blast radius asks *what does delivery do.* Different questions with different failure modes — merging them means the pre-flight screen cannot distinguish "tests failed" from "this would clobber a file," and those need different buttons.

---

## Contract

```ts
export const exportContract = c.router({
  preview: {
    method: 'POST',
    path: '/exports/preview',
    body: z.object({
      missionId: z.string().uuid(),
      idempotencyKey: z.string().uuid(),
      target: exportTargetKind,
      repoUrl: z.string().url().optional(),
      ref: z.string().optional(),
    }),
    responses: {
      201: exportSchema,           // dry_run: true, status: previewed
      404: errorEnvelope,          // REPO_NOT_FOUND
      403: errorEnvelope,          // REPO_NO_ACCESS · POLICY_FORBIDS_TARGET
      422: errorEnvelope,          // PRECONDITION_FAILED · BLAST_RADIUS_VIOLATION
      502: errorEnvelope,          // EXTERNAL_GITHUB · TREE_TOO_LARGE
    },
  },

  create: {
    method: 'POST',
    path: '/exports',
    body: z.object({
      missionId: z.string().uuid(),
      idempotencyKey: z.string().uuid(),
      previewExportId: z.string().uuid().optional(),   // required for github_push; refused with PREVIEW_REQUIRED
      target: exportTargetKind,
      repoUrl: z.string().url().optional(),
      gateOverride: gateOverrideSchema.optional(),
    }),
    responses: {
      201: exportSchema,
      409: errorEnvelope,          // IDEMPOTENCY_REPLAY · PREVIEW_STALE
      422: errorEnvelope,          // PRECONDITION_FAILED · BLAST_RADIUS_VIOLATION
                                   //   · DETERMINISM_VIOLATION · PREVIEW_REQUIRED
      502: errorEnvelope,
    },
  },
})
```

---

## Error cases

Every one of these needs a designed state in the pre-flight screen. The error-map is keyed on the code union in `src/contract/shared/errors.ts`. This table lists the screen state each code needs; it is not the source of the union.

| Code | Condition | Screen shows |
|---|---|---|
| `REPO_NOT_FOUND` | 404 from GitHub | Repo missing or renamed. Check the URL. Offer to switch to zip. |
| `REPO_NO_ACCESS` | 403 / token lacks scope | Which Connection was used, what scope it has, what it needs. |
| `CONNECTION_REVOKED` | `Connection.status !== 'active'` | Engagement closed. Link to Settings → Connections. |
| `POLICY_FORBIDS_TARGET` | `github_push` to default branch, `RepoPolicy` false | Blocked by policy, not by error. Offer PR instead. |
| `BRANCH_NOT_FOUND` | Explicit ref does not exist | For PR: not an error, compares against base. For push: error. |
| `EMPTY_REPOSITORY` | No commits | **Not an error.** All CREATE, `base_commit_sha: null`. Banner: "empty repo — everything is new." |
| `TREE_TOO_LARGE` | Truncated even path-scoped | Cannot compute safely. Zip only. |
| `BLAST_RADIUS_VIOLATION` | Any violation present | The violation list. Deliver disabled by state. Not overridable. |
| `PREVIEW_STALE` | `base_commit_sha` moved | Both SHAs, what changed, one button: re-preview. |
| `PREVIEW_REQUIRED` | `github_push` without `previewExportId` | Should be unreachable from the UI; a backend guard, not a user path. |
| `DETERMINISM_VIOLATION` | Real render hash ≠ preview hash | **Loud.** This is an architectural failure, not a user error. Both hashes, the differing paths, a link to file it. |
| `EXTERNAL_GITHUB` | 5xx, rate limit, timeout | Retryable. Show the reset time on rate limit. |

**`BLAST_RADIUS_VIOLATION` is not overridable by `gate_override`.** Gates concern work quality; violations concern writing where you were not permitted. A justification does not make a path traversal acceptable.

---

## The pre-flight screen

One surface, one scroll, one decision. The dry-run theater and the blast radius preview are **not two screens** — they answer the same question and splitting them means deciding with half the information visible.

```
┌─────────────────────────────────────────────┐
│  Meridian / app  →  avel/mission-4-sprint-2 │
│  base: a3f9c21 · read 40 seconds ago        │
├─────────────────────────────────────────────┤
│  1  PRECONDITIONS                           │
│     required_fields present    ✓            │
│     first-wave agents          ✓            │
├─────────────────────────────────────────────┤
│  2  GATES                                   │
│     phase1-close   mandatory   ✓            │
│     alignment      mandatory   ⚠ attested   │
│     qa             mandatory   ✓            │
├─────────────────────────────────────────────┤
│  3  VERIFICATION                            │
│     build ✓  tests 214/214 ✓                │
│     coverage +2.1% ✓  mutation 74% ✓        │
│     ownership ✓  conformance — unverified   │
├─────────────────────────────────────────────┤
│  4  BLAST RADIUS                            │
│     CREATE      14                          │
│     OVERWRITE    2  ⚠                       │
│       .avel/contracts/phase1.json           │
│         changed 2 hours ago  ⚠              │
│     UNCHANGED   11                          │
│     PRESERVE  2,412 files                   │
├─────────────────────────────────────────────┤
│           [ Deliver ]                       │
└─────────────────────────────────────────────┘
```

**Rules for this screen:**

- **Deliver is disabled by state, never by styling.** Any violation, any failed mandatory gate without an override, any stale preview → the button cannot be pressed.
- **The base SHA and read age are always visible.** Staleness is a first-class fact, not a surprise at submit.
- **Overwrites carry recency.** "Changed 2 hours ago" is the signal that matters; "changed 8 months ago" is noise.
- **Attested gates are marked.** `alignment ⚠ attested` — see `CLIENT-CONTRACT-CONFORMANCE.md`. An attestation rendered identically to a mechanical pass is the failure mode this project exists to prevent, appearing inside the product.
- **Mobile may approve a previously computed preview. Mobile may not initiate delivery.** Per the device boundary.

---

## Build order

1. `gitBlobSha()` + unit tests against known git objects *(verify with `git hash-object`)*
2. `computeBlastRadius()` pure function + fixture tests, no network
3. Gateway `readTree(repo, ref)` with record/replay fixtures
4. `Export.blast_radius` + `base_commit_sha` + `dry_run` columns
5. `export.preview` procedure, `previewing` status
6. The staleness re-check at delivery
7. The determinism comparison
8. Pre-flight screen against fixtures

Steps 1–2 need no GitHub access and no schema. They are pure functions with golden tests, and they are the correct first thing to write.

---

## Open

| Question | Blocking? |
|---|---|
| Does `remoteLastModified` justify the extra commits call per overwrite? | No — ship without, add if the recency signal proves useful |
| Preview TTL — should a preview older than N minutes require recompute even if the SHA has not moved? | No — the SHA check is sufficient |
| Should `zip` compute a blast radius at all? | **Resolved 2026-10-05:** a preview is not required for `zip` (`EXPORT-ENGINE.md` §7). |
| *Lifecycle* says both paths run `previewing`. The row above says zip skips it. Which holds? | **Resolved 2026-10-05:** a preview is not required for `zip`. Whether a zip export passes through the `previewing` status is not stated in the answer; settle it in module 11. |
| Which HTTP status carries `CONNECTION_REVOKED` and `BRANCH_NOT_FOUND`? Neither route lists one. Is `EMPTY_REPOSITORY` a code at all, given it is not an error? | Deferred to module 11 (2026-10-05) |
| Is an ownership breach a non-overridable violation (`OWNERSHIP_VIOLATION`) or a verification gate that `gate_override` can bypass (`verification.ownership`)? | **Resolved 2026-10-05:** never overridable. `COMMAND-CENTER.md` module 9. |
| The determinism comparison uses `snapshot_sha256`. `EXPORT-ENGINE.md` compares the package hash. Which hash is compared, and does a dry run freeze a snapshot? | **Resolved 2026-10-05:** the package hash, under a versioned hash definition. Whether a dry run freezes a snapshot was not answered; the comparison no longer needs one. |
| A path that changes under normalization is a violation. Which code does it carry? | Deferred to module 11 (2026-10-05) |
