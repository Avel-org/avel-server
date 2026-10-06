# Developer Tips — Building AVEL

*Practical guidance for building a deterministic render/gate/deliver pipeline that operates on other people's repositories. Ordered by how much pain each one saves.*

*Owns: build practice. No status (`STATE.md`), no shapes (`DATA-CONTRACTS-V2.md`), no rationale (`DECISIONS-V2.md`).*

---

## 1. Build the export engine backwards

Don't write the renderer and see what comes out.

1. **Hand-write the exact `.avel/` package** you want for one real mission.
2. Commit it as a **golden fixture**.
3. Write code until output matches **byte-for-byte**.

You discover the render contract by producing it once manually — far cheaper than discovering it through four refactors.

The test comes free:

```ts
expect(render(mission)).toEqual(goldenBytes)
```

For a deterministic core, golden-file tests are the only test that proves the property you actually care about.

---

## 2. Determinism trap list

Every one of these has silently broken someone's reproducible build.

| Trap | Fix |
|---|---|
| `Object.keys()` / `JSON.stringify` key order — stable for string keys, **not** across integer-like keys | Sort explicitly before serializing |
| `fs.readdir()` returns OS-dependent order | Sort |
| `Array.prototype.sort()` with `localeCompare` is locale-sensitive | Explicit comparator, no locale |
| `new Date()`, `Date.now()`, `crypto.randomUUID()` below the render boundary | Inject from above; never call inside |
| `Map`/`Set` iteration is insertion-ordered — but insertion often comes from an unordered query | `ORDER BY` on **every** list read feeding a render |
| Template whitespace and trailing newlines differing by platform | Normalize line endings; assert final newline |

**The test:**

```bash
# same process, twice
render && render   # hashes must match

# fresh process
node render.js     # must match the above

# hostile environment
TZ=Asia/Tokyo LANG=tr_TR.UTF-8 node render.js
```

Turkish locale is the classic — it breaks case-insensitive comparison (`I` ≠ `i`). If you pass under `tr_TR`, you are probably clean.

---

## 3. Never touch a client repo until you've hit a throwaway one 50 times

Make a scratch GitHub org today.

- **Record/replay the GitHub API** (Polly.js, nock, or MSW) so the suite needs no network and no token.
- **Build `--dry-run` before `deliver()`.** Same code path minus the side effect. It's what the blast-radius screen needs anyway, so your first real push is your hundredth simulated one.
- **Test branch adoption on retry explicitly.** A retry that opens a second PR instead of adopting the existing branch is the case that bites in production.

Delivery paths to exercise before any client sees them: zip · PR open · PR retry/adopt · direct push · push to protected branch (must refuse) · webhook receipt · webhook replay.

---

## 4. Instrument cost on day one

Cheapest thing to add now, most annoying to retrofit. Cost is captured as required fields, not a habit: `RosterEntry.estimated_tokens` at dispatch, `CompletionReport.actual_tokens` and `model` at close. Shapes are in `DATA-CONTRACTS-V2.md`. Until the runner exists, `COST-LOG.md` is the manual record.

You cannot answer *"which agent is expensive"* later from data you never captured.

Same logic for raw agent I/O — full prompt, full response, agent file hash. Storage is nearly free; reconstruction is impossible.

---

## 5. Version agent files by content hash

Record `agent_version_sha256` on every dispatch. Its definition is in `DATA-CONTRACTS-V2.md`.

When mission 7 goes badly and mission 3 went well, that hash is how you attribute the difference. Without it, every retrospective is anecdote.

---

## 6. Job queue rules

- **The job holds an ID, never state.** All state in Postgres. A worker restart mid-verification resumes from the DB, not from the job payload.
- **Every job is idempotent.** It *will* run twice. Design for it rather than preventing it.
- **Persist status transitions as they happen**, not at the end. `pending → rendering → verifying` written to the DB is your only visibility when something hangs for forty minutes.

---

## 7. Do it manually first

Before writing the export engine, run **one mission end to end by hand**: a real client project, a paper checklist, files copied manually, verification run in a terminal, notes on what actually happened. Half a day.

You will learn:

- which gates you actually consult
- which ones you skip, and why
- how long verification really takes

All three are currently guesses. Automating a process you have never performed is how you end up with a well-built thing nobody uses.

---

## 8. Shard append-only files by writer

Append-only is the right property for an audit log and the worst possible merge shape. Every writer appends to the same place, so every concurrent writer conflicts.

Mission 002 hit this: main held decision-log rows 1 through 9 while the branch held 10 through 16. Nothing was lost, but the merge was manual.

Two fixes:

- **One file per writer per mission.** `decision-log/transactions-slice-1.md` rather than `decision-log.md`. Concatenate for reading. Conflicts become impossible rather than manual.
- **One writer at a time.** Works under a staggered dispatch and fails the moment concurrency arrives.

Take the first. The second is the current situation described as a policy.

## 9. Log cost at dispatch, not at close

The one measurement that cannot be reconstructed is the one most likely to be skipped, because it is the least interesting thing to do at the end of a run that just went well.

Make it a required field on the dispatch itself. A dispatch without an opened cost row does not dispatch. The number gets filled in at close, but the row exists from the start and its absence is visible while the work is still happening.

Reconstructing spend afterward is not possible. There is no log to go back to.

## 10. Two habits worth starting today

**Write the measurement before the feature.** Even a spreadsheet: mission · agents used · time to ship · defects found post-delivery · tokens spent. Ten rows beats any amount of architecture for telling you what to build next.

**Keep a `SURPRISES.md`.** Every time an agent does something you didn't predict, one line. That file becomes your anti-pattern library, your demo material, and eventually your KnowledgeEntry seed data — and unlike the vault, it costs nothing to start today.
