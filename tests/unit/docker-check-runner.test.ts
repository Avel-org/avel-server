import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
	CheckRunRequest,
	RunnableCheck,
} from "../../src/gateways/check-runner";
import { dockerCheckRunner } from "../../src/gateways/docker-check-runner";
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
});
