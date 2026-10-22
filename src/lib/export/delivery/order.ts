/**
 * Unicode codepoint order, never locale order (EXPORT-ENGINE.md §3). Code-unit
 * order (`a < b`) differs from it in one place: a surrogate pair (a codepoint
 * above U+FFFF) sorts below U+E000..U+FFFF by code unit and above them by
 * codepoint. This compares by codepoint.
 */
export function byCodepoint(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x === y) continue;
		const xs = x >= 0xd800 && x <= 0xdfff;
		const ys = y >= 0xd800 && y <= 0xdfff;
		if (xs !== ys) return xs ? 1 : -1;
		return x < y ? -1 : 1;
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
