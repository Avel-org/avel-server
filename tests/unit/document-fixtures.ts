/**
 * Real PDF and docx bytes built in code, so the extraction tests run on
 * files a reader would open and commit no binaries.
 */

/** A PDF whose pages each show one line of text; a page given null shows none. */
export function pdfOf(
	pages: ReadonlyArray<string | null>,
	options: { encrypted?: boolean } = {},
): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add("");
	const pagesId = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const line of pages) {
		const stream =
			line === null ? "" : `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
		const content = add(
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
		kids.push(
			add(
				`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
			),
		);
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
	objects[pagesId - 1] =
		`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	// The standard security handler with a user password: nothing here
	// matches /U, so a reader must ask for one.
	const encrypt = options.encrypted
		? add(
				`<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -4 >>`,
			)
		: null;

	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
	const id = `<${"01".repeat(16)}>`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /ID [${id} ${id}]${encrypt ? ` /Encrypt ${encrypt} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

/** A docx whose body holds these paragraphs. */
export function docxOf(
	paragraphs: readonly string[],
	options: { claimInflated?: number } = {},
): Uint8Array {
	const body = paragraphs
		.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
		.join("");
	return zipOf(
		{
			"[Content_Types].xml":
				'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			"_rels/.rels":
				'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
		},
		options,
	);
}

/**
 * A zip of stored (uncompressed) entries. claimInflated makes the central
 * directory state that size for its last entry, as a zip bomb's would.
 */
export function zipOf(
	files: Record<string, string>,
	options: { claimInflated?: number } = {},
): Uint8Array {
	const enc = new TextEncoder();
	const local: number[] = [];
	const central: number[] = [];
	const entries = Object.entries(files);
	entries.forEach(([name, text], i) => {
		const nameBytes = enc.encode(name);
		const data = enc.encode(text);
		const crc = crc32(data);
		const offset = local.length;
		const claimed =
			i === entries.length - 1 && options.claimInflated !== undefined
				? options.claimInflated
				: data.length;
		local.push(
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(data.length),
			...u32(data.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
			...data,
		);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(data.length),
			...u32(claimed),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...nameBytes,
		);
	});
	const end = [
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(entries.length),
		...u16(entries.length),
		...u32(central.length),
		...u32(local.length),
		...u16(0),
	];
	return new Uint8Array([...local, ...central, ...end]);
}

function u16(n: number): number[] {
	return [n & 0xff, (n >>> 8) & 0xff];
}

function u32(n: number): number[] {
	return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
