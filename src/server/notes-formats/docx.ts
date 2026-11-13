/**
 * Word documents as text (owner, 2026-11-14).
 *
 * A `.docx` keeps its body in `word/document.xml`. The extractor downstream is
 * format-agnostic and only ever sees text, so this file's whole job is to turn
 * that XML into the closest readable plain text: one line per paragraph,
 * `#`-prefixed heading runs, `- ` for list paragraphs, ` | ` between table
 * cells. No styling, no images, no comments — a document with nothing but
 * pictures has no text and is refused upstream.
 */

const HEADING = /^Heading([1-6])$/;
const TOKEN =
	/<w:p\b[^>]*>|<\/w:p>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:pStyle\b[^>]*w:val="([^"]+)"[^>]*\/>|<w:numPr\b[^>]*>|<w:tc\b[^>]*>|<\/w:tc>/g;

const decodeEntities = (text: string): string =>
	text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&amp;/g, "&");

/** The body of `word/document.xml` as text; empty when there is none. */
export function docxDocumentText(xml: string): string {
	const body = xml.slice(xml.indexOf("<w:body>") + 8 || 0);
	const lines: string[] = [];
	let paragraph = "";
	let heading = 0;
	let listItem = false;
	let inCell = false;

	const flush = () => {
		const text = paragraph.replace(/[ \t]+$/g, "").trim();
		const prefix = heading > 0 ? `${"#".repeat(heading)} ` : listItem ? "- " : "";
		const line = `${prefix}${text}`;
		if (line.replace(/^[#\-\s]+/, "").length > 0) lines.push(inCell ? `${line} | ` : line);
		paragraph = "";
		heading = 0;
		listItem = false;
	};

	for (const match of body.matchAll(TOKEN)) {
		const [token, runText, style] = match;
		// Match whole tag names: "<w:tc>" also starts with "<w:t", and a plain
		// startsWith check swallowed every table cell as an empty text run.
		if (/^<w:pStyle\b/.test(token)) {
			const level = HEADING.exec(style ?? "");
			if (level) heading = Number(level[1]);
			else if ((style ?? "").toLowerCase() === "listparagraph") listItem = true;
		} else if (/^<w:numPr\b/.test(token)) {
			listItem = true;
		} else if (/^<w:t\b/.test(token)) {
			paragraph += decodeEntities(runText ?? "");
		} else if (/^<w:tab\b/.test(token)) {
			paragraph += "\t";
		} else if (/^<w:br\b/.test(token)) {
			paragraph += " ";
		} else if (/^<w:tc\b/.test(token)) {
			inCell = true;
		} else if (token === "</w:tc>") {
			flush();
			inCell = false;
		} else if (token === "</w:p>") {
			flush();
		}
	}
	flush();
	return lines.join("\n");
}
