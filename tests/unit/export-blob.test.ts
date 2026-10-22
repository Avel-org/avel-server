import { afterAll, describe, expect, it } from "vitest";
import { byCodepoint, gitBlobSha } from "../../src/lib/export";
import { plumbRepo, writeBlob } from "./export-fixtures";
import { removeDir, tempDir } from "./git-fixtures";

const dir = plumbRepo(tempDir("export-blob"));
afterAll(() => removeDir(dir));

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

describe("gitBlobSha", () => {
	const inputs: [string, Uint8Array][] = [
		["empty", new Uint8Array()],
		["text", bytes("hello\n")],
		["CRLF", bytes("one\r\ntwo\r\n")],
		["non-ASCII", bytes("héllo 日本 😀\n")],
		["every byte", Uint8Array.from({ length: 256 }, (_, i) => i)],
		["NUL and high bytes", Uint8Array.from([0, 0xff, 0, 0x80, 0x0d, 0x0a])],
	];
	for (const [label, input] of inputs) {
		it(`equals git hash-object for ${label} bytes`, () => {
			expect(gitBlobSha(input)).toBe(writeBlob(dir, input));
		});
	}

	it("gives git's well-known sha for the empty blob", () => {
		expect(gitBlobSha(new Uint8Array())).toBe(
			"e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
		);
	});
});

describe("byCodepoint", () => {
	it("orders by codepoint, which is not UTF-16 order above U+FFFF", () => {
		// U+FFFD is one unit (0xFFFD); U+1F600 is two, starting 0xD83D.
		expect(byCodepoint("�", "😀")).toBeLessThan(0);
		expect(byCodepoint("😀", "�")).toBeGreaterThan(0);
		expect("😀" < "�").toBe(true);
	});

	it("puts a prefix first and gives 0 only for equal strings", () => {
		expect(byCodepoint("a", "a/b")).toBeLessThan(0);
		expect(byCodepoint("a/b", "a")).toBeGreaterThan(0);
		expect(byCodepoint("src/x", "src/x")).toBe(0);
		expect(byCodepoint("I", "i")).toBeLessThan(0);
		expect(byCodepoint("Z", "a")).toBeLessThan(0);
	});

	it("sorts as the strings' UTF-8 bytes sort", () => {
		const words = [
			"b",
			"a",
			"ä",
			"Z",
			"😀",
			"�",
			"",
			"퟿",
			"日本",
			"a/b",
			"a-b",
			"a.b",
			"",
			"𝄞",
			"Ilk",
			"ilk",
			"ı",
		];
		const ours = [...words].sort(byCodepoint);
		const utf8 = [...words].sort((a, b) =>
			Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
		);
		expect(ours).toEqual(utf8);
	});
});
