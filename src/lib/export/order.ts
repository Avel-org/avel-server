/**
 * Codepoint order, the order EXPORT-ENGINE.md §3 calls byCodepoint. It is
 * also the byte order of the strings' UTF-8, which is the order git sorts
 * paths in. Never locale order (docs/DEV-TIPS.md §2).
 *
 * This is not the plain `a < b` used elsewhere in src/: that compares UTF-16
 * code units, which puts a codepoint above U+FFFF (two surrogate units, from
 * 0xD800) before one in U+E000..U+FFFF. At the first unit that differs,
 * surrogates are moved above every other unit and the rest keep their order.
 */
export function byCodepoint(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return rank(x) - rank(y);
	}
	return a.length - b.length;
}

function rank(unit: number): number {
	if (unit >= 0xd800 && unit <= 0xdfff) return unit + 0x2000;
	if (unit >= 0xe000) return unit - 0x800;
	return unit;
}
