import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
	CheckRunRequest,
	RunnableCheck,
} from "../../src/gateways/check-runner";
import {
	dockerCheckRunner,
	PINNED_PNPM,
	tailOf,
	unpack,
} from "../../src/gateways/docker-check-runner";
import { sequentialIds } from "../../src/lib/ids";
import { makeRepo, removeDir, tempDir } from "./git-fixtures";

// Runs real containers, so it needs Docker and a pinned image. Opt in with
// AVEL_DOCKER_TEST_IMAGE=node@sha256:... (a Node image with sh, timeout and
// tar); without it the suite skips. CI does not set it.
const IMAGE = process.env.AVEL_DOCKER_TEST_IMAGE;

vi.setConfig({ testTimeout: 120_000 });

const base = tempDir("docker-runner");
afterAll(() => removeDir(base));

let n = 0;
const check = (command: string, kind: RunnableCheck["kind"] = "command") =>
	({
		id: `CK${++n}`,
		requirementId: "R1",
		kind,
		command,
	}) as RunnableCheck;

function repo(files: Record<string, string>, next?: Record<string, string>) {
	const dir = path.join(base, `repo-${++n}`);
	return { dir, commits: makeRepo(dir, files, next) };
}

const runner = (over: { checkTimeoutMs?: number } = {}) =>
	dockerCheckRunner({ image: IMAGE as string, ids: sequentialIds(), ...over });

const request = (
	dir: string,
	commitSha: string,
	checks: RunnableCheck[],
): CheckRunRequest => ({ source: dir, commitSha, checks });

const leftover = () =>
	execFileSync(
		"docker",
		["ps", "-a", "--filter", "name=avel-check-", "--format", "{{.Names}}"],
		{ windowsHide: true },
	)
		.toString()
		.trim();

describe("tailOf", () => {
	it("keeps the last bytes, holds at most twice the cap, and never splits a character", () => {
		const t = tailOf(1024);
		let most = 0;
		for (let i = 0; i < 5000; i++) {
			t.push(Buffer.from("é".repeat(700)));
			most = Math.max(most, t.held());
		}
		t.push("END");
		expect(most).toBeLessThanOrEqual(2048);
		const text = t.text();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		expect(text.endsWith("END")).toBe(true);
		expect(text.replace(/END$/, "").replace(/é/g, "")).toBe("");
	});
});

describe("dockerCheckRunner", () => {
	it("refuses an image that is not pinned by digest", () => {
		expect(() =>
			dockerCheckRunner({ image: "node:24", ids: sequentialIds() }),
		).toThrow(/not pinned by digest/);
	});
});

describe.skipIf(!IMAGE)("dockerCheckRunner on Docker", () => {
	it("passes exit 0 and fails any other exit, in the order asked, and names its image", async () => {
		const r = repo({ "src/a.ts": "export const a = 1;\n" });
		const run = runner();
		expect(run.id).toBe(`docker:${IMAGE}`);
		const results = await run.run(
			request(r.dir, r.commits[0] as string, [
				check("test -f src/a.ts", "test"),
				check("echo boom; exit 3"),
				check("true", "typecheck"),
			]),
		);
		expect(results.map((x) => [x.outcome, x.exitCode])).toEqual([
			["pass", 0],
			["fail", 3],
			["pass", 0],
		]);
		expect(results[1]?.output).toContain("boom");
		expect(leftover()).toBe("");
	});

	it("runs on the commit asked for, never the working tree or another commit", async () => {
		const r = repo({ "a.txt": "one\n" }, { "a.txt": "two\n" });
		const [first] = await runner().run(
			request(r.dir, r.commits[0] as string, [check("grep -qx one a.txt")]),
		);
		expect(first?.outcome).toBe("pass");
		const [second] = await runner().run(
			request(r.dir, r.commits[1] as string, [check("grep -qx one a.txt")]),
		);
		expect(second?.outcome).toBe("fail");
	});

	it("gives a check no network", async () => {
		const r = repo({ "a.txt": "a\n" });
		const [res] = await runner().run(
			request(r.dir, r.commits[0] as string, [
				check(
					`node -e "require('http').get('http://1.1.1.1',()=>process.exit(0)).on('error',()=>process.exit(7))"`,
				),
			]),
		);
		expect([res?.outcome, res?.exitCode]).toEqual(["fail", 7]);
	});

	it("gives a check none of the host's environment, as the node user with an empty capability bounding set", async () => {
		process.env.AVEL_RUNNER_SECRET_PROBE = "s3cret";
		try {
			const r = repo({ "a.txt": "a\n" });
			const results = await runner().run(
				request(r.dir, r.commits[0] as string, [
					check('test -z "$AVEL_RUNNER_SECRET_PROBE"'),
					check('test "$(id -u)" = 1000'),
					check("grep -q '^CapBnd:\\s*0*$' /proc/self/status"),
				]),
			);
			expect(results.map((x) => x.outcome)).toEqual(["pass", "pass", "pass"]);
		} finally {
			delete process.env.AVEL_RUNNER_SECRET_PROBE;
		}
	});

	it("makes a check that runs past its limit an error, and goes on to the next", async () => {
		const r = repo({ "a.txt": "a\n" });
		const results = await runner({ checkTimeoutMs: 2_000 }).run(
			request(r.dir, r.commits[0] as string, [
				check("sleep 30"),
				check("true"),
			]),
		);
		expect(results.map((x) => [x.outcome, x.exitCode])).toEqual([
			["error", null],
			["pass", 0],
		]);
	});

	it("starts every run from a new container", async () => {
		const r = repo({ "a.txt": "a\n" });
		const sha = r.commits[0] as string;
		await runner().run(request(r.dir, sha, [check("touch /tmp/home/leak")]));
		const [res] = await runner().run(
			request(r.dir, sha, [check("test ! -e /tmp/home/leak")]),
		);
		expect(res?.outcome).toBe("pass");
		expect(leftover()).toBe("");
	});

	it("installs from a lockfile, and errors every check when package.json has none", async () => {
		const pkg = '{"name":"probe","version":"1.0.0","private":true}\n';
		const lock = `${JSON.stringify(
			{
				name: "probe",
				version: "1.0.0",
				lockfileVersion: 3,
				requires: true,
				packages: { "": { name: "probe", version: "1.0.0" } },
			},
			null,
			2,
		)}\n`;
		const locked = repo({ "package.json": pkg, "package-lock.json": lock });
		const [ok] = await runner().run(
			request(locked.dir, locked.commits[0] as string, [
				check("test -d node_modules || test -f package-lock.json"),
			]),
		);
		expect(ok?.outcome).toBe("pass");

		const unlocked = repo({ "package.json": pkg });
		const results = await runner().run(
			request(unlocked.dir, unlocked.commits[0] as string, [
				check("true"),
				check("true"),
			]),
		);
		expect(results.map((x) => x.outcome)).toEqual(["error", "error"]);
		expect(results[0]?.output).toMatch(/no lockfile/);
	});

	it("installs a pnpm project with the pinned pnpm, never the one its packageManager names", async () => {
		const pkg = `${JSON.stringify({
			name: "probe",
			version: "1.0.0",
			private: true,
			// A version the install would download and check against a hash
			// it cannot match: following it fails the install.
			packageManager: `pnpm@9.15.0+sha512.${"0".repeat(128)}`,
		})}\n`;
		const lock =
			"lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";
		const r = repo({ "package.json": pkg, "pnpm-lock.yaml": lock });
		const [res] = await runner().run(
			request(r.dir, r.commits[0] as string, [
				// From HOME, so the check's own pnpm does not read the commit's packageManager.
				check("cd /tmp/home && .avel-pm/node_modules/.bin/pnpm --version"),
			]),
		);
		expect([res?.outcome, res?.output.trim()]).toEqual(["pass", PINNED_PNPM]);
	});

	it("keeps only the end of a check's output, however much it prints", async () => {
		const r = repo({ "a.txt": "a\n" });
		const run = dockerCheckRunner({
			image: IMAGE as string,
			ids: sequentialIds(),
			outputBytes: 1024,
		});
		const [res] = await run.run(
			request(r.dir, r.commits[0] as string, [
				check(
					`node -e "for (let i = 0; i < 2000; i++) process.stdout.write('x'.repeat(4096)); process.stdout.write('END')"`,
				),
			]),
		);
		expect(res?.outcome).toBe("pass");
		expect(Buffer.byteLength(res?.output ?? "")).toBeLessThanOrEqual(1024);
		expect(res?.output.endsWith("END")).toBe(true);
	});

	it("stops starting checks once told to, and leaves the rest as errors", async () => {
		const r = repo({ "a.txt": "a\n" });
		let started = 0;
		const results = await runner().run({
			...request(r.dir, r.commits[0] as string, [
				check("true"),
				check("true"),
				check("true"),
			]),
			onProgress: async (_done, current) => {
				if (current !== null) started++;
			},
			shouldStop: () => started >= 1,
		});
		expect(results.map((x) => x.outcome)).toEqual(["pass", "error", "error"]);
		expect(results[1]?.output).toBe(
			"Not run: the run was stopped before this check started",
		);
	});

	it("rejects, never crashes, when tar exits while git archive is still writing", async () => {
		// 8 MiB is more than a pipe holds, so git is mid-write when the
		// exec into a container that does not exist gives up.
		const r = repo({ "big.bin": "x".repeat(8 * 1024 * 1024) });
		await expect(
			unpack(
				r.dir,
				r.commits[0] as string,
				"avel-check-no-such-container",
				60_000,
			),
		).rejects.toThrow(/Unpacking/);
	});

	it("sweeps the containers a stopped run left behind", async () => {
		execFileSync(
			"docker",
			["create", "--name", "avel-check-left-behind", IMAGE as string, "true"],
			{ windowsHide: true },
		);
		expect(leftover()).toBe("avel-check-left-behind");
		await runner().sweep?.();
		expect(leftover()).toBe("");
	});
});
