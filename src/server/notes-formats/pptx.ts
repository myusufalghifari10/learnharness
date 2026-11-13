/**
 * PowerPoint decks as text (owner, 2026-11-14).
 *
 * A `.pptx` stores each slide as `ppt/slides/slideN.xml`, but N is creation
 * order, not deck order — the running order lives in `ppt/presentation.xml`
 * (`<p:sldId r:id="rId…">`) resolved through `ppt/_rels/presentation.xml.rels`.
 * Slides are emitted in THAT order with a `## Slide N` marker, because a deck's
 * meaning is the sequence of its slides.
 */

const SLIDE_ID = /<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/>/g;
const RELATION = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
const REPLACEMENT = /&lt;|&gt;|&quot;|&apos;|&#\d+;|&#x[0-9a-f]+;|&amp;/gi;

const decodeEntities = (text: string): string =>
	text.replace(REPLACEMENT, (entity) => {
		switch (entity.toLowerCase()) {
			case "&lt;":
				return "<";
			case "&gt;":
				return ">";
			case "&quot;":
				return '"';
			case "&apos;":
				return "'";
			case "&amp;":
				return "&";
			default: {
				const code = entity.startsWith("&#x") || entity.startsWith("&#X") ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
				return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
			}
		}
	});

/** One slide part as text: one line per drawing paragraph, runs joined. */
export function slideText(xml: string): string {
	const lines: string[] = [];
	for (const paragraph of xml.split(/<a:p\b/).slice(1)) {
		const runs = [...paragraph.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((run) => decodeEntities(run[1] ?? ""));
		const line = runs.join("").trim();
		if (line) lines.push(line);
	}
	return lines.join("\n");
}

/** Slide part paths in deck order, falling back to file order when rels are absent. */
export function slideOrder(presentationXml: string | undefined, relsXml: string | undefined, parts: string[]): string[] {
	const targets = new Map<string, string>();
	for (const relation of (relsXml ?? "").matchAll(RELATION)) {
		const id = relation[1] ?? "";
		const target = relation[2] ?? "";
		if (!id || !target) continue;
		const part = target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\//, "")}`;
		targets.set(id, part);
	}
	const ordered: string[] = [];
	for (const slide of (presentationXml ?? "").matchAll(SLIDE_ID)) {
		const part = targets.get(slide[1] ?? "");
		if (part && parts.includes(part) && !ordered.includes(part)) ordered.push(part);
	}
	const rest = parts.filter((part) => !ordered.includes(part));
	return [...ordered, ...rest];
}

/** The whole deck as text, in running order. */
export function pptxText(presentationXml: string | undefined, relsXml: string | undefined, slideParts: Map<string, string>): string {
	const order = slideOrder(presentationXml, relsXml, [...slideParts.keys()]);
	const blocks: string[] = [];
	order.forEach((part, index) => {
		const text = slideText(slideParts.get(part) ?? "");
		if (text) blocks.push(`## Slide ${index + 1}\n${text}`);
	});
	return blocks.join("\n\n");
}
