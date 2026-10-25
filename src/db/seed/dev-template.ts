import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MANIFEST_PATH } from "../../gateways/template-source";
import { type RepoRead, readRepo } from "../../lib/repo-read";
import { SnapshotBuilder } from "../../lib/repo-read/snapshot";
import {
	DEV_BOOKING_SHA,
	DEV_GATE_READY_REF,
	DEV_TEMPLATE_READS,
} from "../../lib/templates";
import { git, gitOk } from "../../rooms/git";

/**
 * The dev stand-in for template-booking: a small repository built the same
 * way on every machine, so its commit is DEV_BOOKING_SHA and the seeded
 * missions' template_version names a commit a clone really holds. Fixed
 * author, committer and dates; no signing, which would change the sha. It is
 * a fixture to dispatch against, not the real template (TEMPLATE-BOOKING.md),
 * which has not been built.
 */

const BOOKING = DEV_TEMPLATE_READS["template-booking"];

const COMMIT_ENV = {
	GIT_AUTHOR_NAME: "AVEL dev fixture",
	GIT_AUTHOR_EMAIL: "dev-fixture@avel.invalid",
	GIT_AUTHOR_DATE: "2026-10-21T00:00:00Z",
	GIT_COMMITTER_NAME: "AVEL dev fixture",
	GIT_COMMITTER_EMAIL: "dev-fixture@avel.invalid",
	GIT_COMMITTER_DATE: "2026-10-21T00:00:00Z",
};

/** The fixture's files, path to bytes, in the layout TEMPLATE-BOOKING.md proposes. */
export function devTemplateBookingFiles(): Record<string, Uint8Array> {
	const text = (s: string) => new TextEncoder().encode(s);
	const files: Record<string, string> = {
		[MANIFEST_PATH]: `${JSON.stringify(BOOKING?.manifest, null, "\t")}\n`,
		".gitignore": "node_modules/\n.next/\n",
		"README.md":
			"# template-booking (dev fixture)\n\nA stand-in for the Booking template, so dispatch rooms have a real commit to open on avel_dev. Not the template itself.\n",
		"package.json": `${JSON.stringify(
			{
				name: "template-booking",
				private: true,
				type: "module",
				scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
			},
			null,
			"\t",
		)}\n`,
		"tsconfig.json": `${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2023",
					module: "ESNext",
					moduleResolution: "Bundler",
					strict: true,
					jsx: "preserve",
					noEmit: true,
				},
				include: ["src", "tests"],
			},
			null,
			"\t",
		)}\n`,
		"src/app/layout.tsx":
			"export default function RootLayout({ children }: { children: unknown }) {\n\treturn children;\n}\n",
		"src/lib/clock.ts":
			"/** Time comes from here, never from the system clock directly. */\nexport type Clock = { now: () => Date };\n",
		"src/features/scheduling/index.ts":
			"/** Slots, availability and bookings. */\nexport {};\n",
		"src/features/notifications/index.ts":
			"/** Confirmation and reminder messages. */\nexport {};\n",
		"src/features/accounts/index.ts":
			"/** The owner's sign-in. */\nexport {};\n",
		"tests/unit/.gitkeep": "",
		"fixtures/golden/.gitkeep": "",
	};
	const out: Record<string, Uint8Array> = {};
	for (const [p, s] of Object.entries(files)) out[p] = text(s);
	const cover = BOOKING?.manifest.cover?.path;
	if (cover) {
		out[cover] = new Uint8Array(
			readFileSync(
				new URL("../../lib/dev-covers/template-booking.png", import.meta.url),
			),
		);
	}
	return out;
}

let read: RepoRead | undefined;

/**
 * The repository read of the fixture at DEV_BOOKING_SHA: readRepo over the
 * fixture's own files, so a seeded intake's derived cut, evidence,
 * conventions and boundaries are what a read of a clone of it derives.
 */
export function devTemplateBookingRead(): RepoRead {
	if (!read) {
		const builder = new SnapshotBuilder();
		const files = devTemplateBookingFiles();
		for (const p of Object.keys(files).sort()) {
			builder.add(p, files[p] as Uint8Array);
		}
		read = readRepo(builder.build(DEV_BOOKING_SHA));
	}
	return read;
}

/** The gate-ready commit's one change: a file inside Atlas's scheduling mount. */
export const DEV_GATE_READY_PATH = "src/features/scheduling/slots.ts";
const DEV_GATE_READY_FILE = `/** The open slots of one day, in start order. */
export function openSlots(slots: readonly { start: string; booked: boolean }[]) {
	return slots.filter((s) => !s.booked).map((s) => s.start).sort();
}
`;

/**
 * Writes the gate-ready commit (DEV_GATE_READY_SHA) on DEV_BOOKING_SHA under
 * DEV_GATE_READY_REF, through a scratch index, so the clone's HEAD, index
 * and working tree are untouched. Does nothing when the ref is already set,
 * or when the clone does not hold DEV_BOOKING_SHA.
 */
async function buildDevGateReady(dir: string): Promise<void> {
	if (
		await gitOk(["rev-parse", "--verify", DEV_GATE_READY_REF], { cwd: dir })
	) {
		return;
	}
	if (
		!(await gitOk(["cat-file", "-e", `${DEV_BOOKING_SHA}^{commit}`], {
			cwd: dir,
		}))
	) {
		return;
	}
	const scratch = await mkdtemp(path.join(tmpdir(), "avel-gate-ready-"));
	try {
		const file = path.join(scratch, "slots.ts");
		await writeFile(file, DEV_GATE_READY_FILE);
		const env = {
			...process.env,
			...COMMIT_ENV,
			GIT_INDEX_FILE: path.join(scratch, "index"),
		};
		const blob = (await git(["hash-object", "-w", file], { cwd: dir })).trim();
		await git(["read-tree", DEV_BOOKING_SHA], { cwd: dir, env });
		await git(
			[
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${blob},${DEV_GATE_READY_PATH}`,
			],
			{ cwd: dir, env },
		);
		const tree = (await git(["write-tree"], { cwd: dir, env })).trim();
		const sha = (
			await git(
				[
					"-c",
					"commit.gpgsign=false",
					"commit-tree",
					tree,
					"-p",
					DEV_BOOKING_SHA,
					"-m",
					"Open slots, in start order",
				],
				{ cwd: dir, env },
			)
		).trim();
		await git(["update-ref", DEV_GATE_READY_REF, sha], { cwd: dir });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * Builds the fixture at `dir` and returns its head. A directory already at
 * that head is left alone, but for the gate-ready ref, which is added when
 * missing; anything else there is refused, never overwritten.
 */
export async function buildDevTemplateBooking(dir: string): Promise<string> {
	if (existsSync(dir)) {
		if (await gitOk(["rev-parse", "--verify", "HEAD"], { cwd: dir })) {
			await buildDevGateReady(dir);
			return (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
		}
		throw new Error(`${dir} exists and is not a git repository; move it first`);
	}
	await mkdir(dir, { recursive: true });
	// Sorted, so the index is written in one order on every machine.
	const files = devTemplateBookingFiles();
	for (const p of Object.keys(files).sort()) {
		const file = path.join(dir, ...p.split("/"));
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, files[p] as Uint8Array);
	}
	await git(["init", "-q", "-b", "main"], { cwd: dir });
	await git(["add", "-A"], { cwd: dir });
	await git(
		[
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"-m",
			"template-booking dev fixture",
		],
		{ cwd: dir, env: { ...process.env, ...COMMIT_ENV } },
	);
	await buildDevGateReady(dir);
	return (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
}
