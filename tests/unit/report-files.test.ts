import { describe, expect, it } from "vitest";
import type { FileChange } from "../../src/rooms/checkpoint";
import { fileTypes } from "../../src/runner/report";

describe("fileTypes", () => {
	it("lists unique lowercase extensions, sorted, from every changed path", () => {
		const changes: FileChange[] = [
			{ kind: "modified", path: "src/a.TS" },
			{ kind: "added", path: "src/b.ts" },
			{ kind: "deleted", path: "docs/old.md" },
			{ kind: "renamed", from: "data/x.json", path: "data/x.yaml" },
			{ kind: "added", path: "pkg/archive.tar.gz" },
		];
		expect(fileTypes(changes)).toEqual(["gz", "json", "md", "ts", "yaml"]);
	});

	it("adds nothing for a name with no extension, a dotfile or a trailing dot", () => {
		const changes: FileChange[] = [
			{ kind: "added", path: "src/README" },
			{ kind: "added", path: ".env" },
			{ kind: "added", path: "src/.gitignore" },
			{ kind: "added", path: "src/odd." },
			{ kind: "added", path: "dir.d/Makefile" },
		];
		expect(fileTypes(changes)).toEqual([]);
	});
});
