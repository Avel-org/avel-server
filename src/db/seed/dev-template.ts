import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_PATH } from "../../gateways/template-source";
import { DEV_TEMPLATE_READS } from "../../lib/templates";
import { git, gitOk } from "../../rooms/git";

/**
 * The dev stand-in for template-booking: a small repository built the same
 * way on every machine, so its commit is DEV_BOOKING_SHA and a mission
 * pinned to it names a commit a clone really holds. Fixed
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

/**
 * Builds the fixture at `dir` and returns its head. A directory already
 * holding a repository is left alone; anything else there is refused, never
 * overwritten.
 */
export async function buildDevTemplateBooking(dir: string): Promise<string> {
	if (existsSync(dir)) {
		if (await gitOk(["rev-parse", "--verify", "HEAD"], { cwd: dir })) {
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
	return (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
}
