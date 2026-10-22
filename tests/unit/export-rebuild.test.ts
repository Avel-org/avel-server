import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	type ClosedDispatch,
	ExportRefused,
	rebuildIntegrationCommit,
} from "../../src/lib/export";
import { planIntegration } from "../../src/lib/gate/integration";
import {
	buildIntegrationCommit,
	dispatchChanges,
	dispatchRef,
	IntegrationRefused,
} from "../../src/rooms/snapshot";
import { commitEntries, plumbRepo, textFiles } from "./export-fixtures";
import { gitIn, removeDir, tempDir } from "./git-fixtures";

// Rebuilding the gate's integration commit from its inputs and comparing it
// with the recorded sha. Every commit is made by plumbing at a fixed date,
// so the shas are the same on every machine.

vi.setConfig({ testTimeout: 60_000 });

const base = tempDir("export-rebuild");
afterAll(() => removeDir(base));

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const T1 = "2026-10-19T09:00:00.000Z";
const T2 = "2026-10-19T10:30:00.000Z";

/**
 * The integration commit of setup()'s two dispatches, as buildIntegrationCommit
 * made it when this test was written. If it moves, buildIntegrationCommit's
 * output moved and every recorded gate run's commit would stop rebuilding.
 */
const RECORDED = "534b593e4ebfe236bd734eb956c3e8cd3810eacf";

let n = 0;
function setup() {
	const dir = plumbRepo(path.join(base, `repo-${++n}`));
	const files = { "a.txt": "a\n", "d.txt": "d\n", "keep.txt": "k\n" };
	const baseSha = commitEntries(dir, textFiles(dir, files));
	const shaA = commitEntries(
		dir,
		textFiles(dir, { "a.txt": "a2\n", "keep.txt": "k\n" }),
		baseSha,
	);
	const shaB = commitEntries(
		dir,
		textFiles(dir, { ...files, "b/new.txt": "new\n" }),
		baseSha,
	);
	// A failed dispatch that also changed a.txt: excluded, so no conflict.
	const shaC = commitEntries(
		dir,
		textFiles(dir, { ...files, "a.txt": "c\n" }),
		baseSha,
	);
	for (const [id, sha] of [
		[A, shaA],
		[B, shaB],
		[C, shaC],
	] as const) {
		gitIn(dir, "update-ref", dispatchRef(id), sha);
	}
	const dispatches: ClosedDispatch[] = [
		{ id: B, status: "complete", closedAt: T2, resultCommitSha: shaB },
		{ id: A, status: "complete", closedAt: T1, resultCommitSha: shaA },
		{ id: C, status: "failed", closedAt: T1, resultCommitSha: shaC },
	];
	return { dir, baseSha, shaA, shaB, dispatches };
}

async function refused(p: Promise<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(ExportRefused);
		return (err as ExportRefused).details;
	}
	throw new Error("expected a refusal");
}

describe("rebuildIntegrationCommit", () => {
	it("rebuilds the recorded sha, which is what the gate's own steps make", async () => {
		const s = setup();
		// The gate's steps, written out as src/routes/gate.ts runs them.
		const plan = planIntegration({
			baseSha: s.baseSha,
			dispatches: await Promise.all(
				s.dispatches.map(async (d) => ({
					id: d.id,
					status: d.status,
					closedAt: d.closedAt,
					changes: d.resultCommitSha
						? await dispatchChanges(s.dir, s.baseSha, d.resultCommitSha)
						: [],
				})),
			),
		});
		const judged = (await buildIntegrationCommit(s.dir, plan)).sha;
		expect(judged).toBe(RECORDED);

		expect(
			await rebuildIntegrationCommit({
				source: s.dir,
				baseSha: s.baseSha,
				dispatches: s.dispatches,
				recordedSha: RECORDED,
			}),
		).toEqual({ sha: RECORDED });
		expect(gitIn(s.dir, "show", `${RECORDED}:a.txt`)).toBe("a2");
		expect(gitIn(s.dir, "show", `${RECORDED}:b/new.txt`)).toBe("new");
	});

	it("refuses, naming both shas, when a recorded input moved", async () => {
		const s = setup();
		const later = s.dispatches.map((d) =>
			d.id === B ? { ...d, closedAt: "2026-10-19T11:00:00.000Z" } : d,
		);
		const details = (await refused(
			rebuildIntegrationCommit({
				source: s.dir,
				baseSha: s.baseSha,
				dispatches: later,
				recordedSha: RECORDED,
			}),
		)) as Record<string, unknown>;
		expect(details.reason).toBe("integration_commit_moved");
		expect(details.recorded).toBe(RECORDED);
		expect(details.rebuilt).toMatch(/^[0-9a-f]{40}$/);
		expect(details.rebuilt).not.toBe(RECORDED);
	});

	it("refuses when a dispatch's commit is no longer the one it was", async () => {
		const s = setup();
		const other = commitEntries(
			s.dir,
			textFiles(s.dir, { "a.txt": "a3\n", "keep.txt": "k\n" }),
			s.baseSha,
		);
		gitIn(s.dir, "update-ref", dispatchRef(A), other);
		const moved = s.dispatches.map((d) =>
			d.id === A ? { ...d, resultCommitSha: other } : d,
		);
		expect(
			await refused(
				rebuildIntegrationCommit({
					source: s.dir,
					baseSha: s.baseSha,
					dispatches: moved,
					recordedSha: RECORDED,
				}),
			),
		).toMatchObject({ reason: "integration_commit_moved", recorded: RECORDED });
	});

	it("passes a plan that no longer builds through as buildIntegrationCommit refuses it", async () => {
		const s = setup();
		const conflicting = s.dispatches.map((d) =>
			d.id === C ? { ...d, status: "complete" as const } : d,
		);
		const err = await rebuildIntegrationCommit({
			source: s.dir,
			baseSha: s.baseSha,
			dispatches: conflicting,
			recordedSha: RECORDED,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(IntegrationRefused);
		expect((err as IntegrationRefused).details.reason).toBe(
			"integration_conflict",
		);
	});

	it("refuses a recorded sha that is not a full sha", async () => {
		const s = setup();
		await expect(
			rebuildIntegrationCommit({
				source: s.dir,
				baseSha: s.baseSha,
				dispatches: s.dispatches,
				recordedSha: "HEAD",
			}),
		).rejects.toThrow(/recorded/);
	});
});
