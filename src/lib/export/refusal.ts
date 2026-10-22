/**
 * Why render, the package or the zip writer refused. Not in the contract:
 * no route reads these yet. Each refusal names the path it is about, where
 * there is one.
 */
export const EXPORT_REFUSALS = [
	/** A changed path is a symlink on either side of the diff. */
	"symlink",
	/** A changed path is a submodule (a gitlink) on either side of the diff. */
	"submodule",
	/** A path whose bytes are the same and whose mode changed. */
	"mode_only",
	/** A file mode other than 100644 or 100755. */
	"unsupported_mode",
	/** A path git holds as bytes that are not UTF-8. */
	"path_not_utf8",
	/** The integration commit itself wrote or deleted .avel/receipt.json. */
	"receipt_path_written",
	/** The integration commit rebuilt from its inputs is not the one recorded. */
	"integration_commit_moved",
	/** A zip entry path that could write outside the extraction directory. */
	"unsafe_path",
	/** Two zip entries with the same path. */
	"duplicate_path",
	/** More entries or bytes than a zip without zip64 can hold. */
	"zip_too_large",
] as const;

export type ExportRefusal = (typeof EXPORT_REFUSALS)[number];

export class ExportRefused extends Error {
	constructor(
		message: string,
		readonly details: { reason: ExportRefusal } & Record<string, unknown>,
	) {
		super(message);
		this.name = "ExportRefused";
	}
}

export const refuse = (
	message: string,
	details: { reason: ExportRefusal } & Record<string, unknown>,
) => new ExportRefused(message, details);
