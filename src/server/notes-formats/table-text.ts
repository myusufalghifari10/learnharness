/**
 * CSV/TSV as text (owner, 2026-11-14).
 *
 * A answered-question log or a vocabulary table is a table, and the extractor
 * reads a table best as Markdown: a header row, a rule, then one row per line.
 * Quoting follows RFC 4180 (`""` inside a quoted cell, embedded newlines kept)
 * because spreadsheet exports use it and a naive split mangles every cell that
 * contains a comma.
 */

/** Rows beyond this are cut: a 25 MB dump is not a note, it is a database. */
const MAX_ROWS = 20000;

export function tableToText(text: string, delimiter: "\t" | ","): string {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else quoted = false;
			} else cell += char;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === delimiter) {
			row.push(cell);
			cell = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") i++;
			row.push(cell);
			cell = "";
			rows.push(row);
			row = [];
			if (rows.length >= MAX_ROWS) break;
		} else cell += char;
	}
	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}
	const kept = rows.filter((cells) => cells.some((value) => value.trim().length > 0));
	if (kept.length === 0) return "";
	const clean = (value: string) => value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
	const [header, ...body] = kept;
	const lines = [`| ${(header ?? []).map(clean).join(" | ")} |`, `| ${(header ?? []).map(() => "---").join(" | ")} |`];
	for (const cells of body) lines.push(`| ${cells.map(clean).join(" | ")} |`);
	if (rows.length >= MAX_ROWS) lines.push(`\n… truncated at ${MAX_ROWS} rows.`);
	return lines.join("\n");
}
