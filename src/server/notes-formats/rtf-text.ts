/**
 * RTF as text (owner, 2026-11-14).
 *
 * Old Word files and "export as RTF" are plain ASCII with control words. The
 * conversion keeps only the printable runs: destinations (fonts, colours, styles,
 * info, pictures) are skipped wholesale, paragraph/line/tab controls become
 * whitespace, `\'hh` bytes decode as cp1252 and `\uN` as Unicode. RTF has no
 * tables worth reconstructing here, so cells simply run together.
 */

/** Destinations whose whole group must be skipped, not merely unwrapped. */
const SKIPPED_DESTINATIONS = new Set([
	"fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer", "headerl", "headerr",
	"footerl", "footerr", "footnote", "annotation", "listtable", "listoverridetable", "rsidtbl", "generator",
	"themedata", "colorschememapping", "datastore", "latentstyles", "xmlnstbl",
]);

const CP1252: Record<number, string> = {
	0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
	0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•",
	0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

export function rtfToText(rtf: string): string {
	if (!rtf.trimStart().startsWith("{\\rtf")) return "";
	let out = "";
	let depth = 0;
	let skipping = false;
	let pendingSkipDepth = -1;

	for (let i = 0; i < rtf.length; i++) {
		const char = rtf[i]!;
		if (char === "{") {
			depth++;
			// `{\*\destination …}` marks a group to drop entirely.
			const starred = rtf.startsWith("{\\*", i);
			if (!skipping) {
				const word = starred ? rtf.slice(i + 3).match(/^\\?([a-z]+)/i)?.[1] : rtf.slice(i + 1).match(/^\\?([a-z]+)/i)?.[1];
				if (starred || (word && SKIPPED_DESTINATIONS.has(word.toLowerCase()))) {
					skipping = true;
					pendingSkipDepth = depth;
				}
			}
			continue;
		}
		if (char === "}") {
			if (skipping && depth === pendingSkipDepth) {
				skipping = false;
				pendingSkipDepth = -1;
			}
			depth--;
			continue;
		}
		if (char === "\\") {
			const control = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i));
			if (control) {
				const word = (control[1] ?? "").toLowerCase();
				i += control[0].length - 1;
				if (skipping) continue;
				if (word === "par" || word === "line" || word === "row") out += "\n";
				else if (word === "tab") out += "\t";
				else if (word === "u" && control[2]) {
					const code = Number(control[2]);
					out += String.fromCodePoint(code < 0 ? code + 65536 : code);
					i += 1; // skip the substitution character that follows
				}
				continue;
			}
			const hex = /^\\'([0-9a-f]{2})/i.exec(rtf.slice(i));
			if (hex) {
				const byte = Number.parseInt(hex[1]!, 16);
				i += hex[0].length - 1;
				if (!skipping) out += CP1252[byte] ?? String.fromCharCode(byte);
				continue;
			}
			const escaped = rtf[i + 1];
			i++;
			if (!skipping && (escaped === "\\" || escaped === "{" || escaped === "}")) out += escaped;
			continue;
		}
		if (!skipping && char !== "\r") out += char;
	}

	return out
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
