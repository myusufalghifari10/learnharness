/**
 * HTML as text (owner, 2026-11-14).
 *
 * "Save page as" and Notion/Obsidian exports arrive as HTML. The extractor only
 * wants the prose, so scripts, styles and head content go first, block tags
 * become line breaks, list items keep their bullet, table cells keep a `|`, and
 * the remaining tags are dropped. Entities are decoded so `&amp;` does not
 * reach the model as literal punctuation.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decodeEntities = (text: string): string =>
	text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
		if (decimal) return String.fromCodePoint(Number(decimal));
		if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
		return ENTITIES[(named ?? "").toLowerCase()] ?? entity;
	});

export function htmlToText(html: string): string {
	const body = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|head|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(td|th)\b[^>]*>/gi, " | ")
		.replace(/<\/(td|th)>/gi, "")
		.replace(/<\/?(?:table|thead|tbody|tr|ul|ol|div|section|article|header|footer|nav|main|aside|figure|figcaption|blockquote|form|fieldset)\b[^>]*>/gi, "\n")
		.replace(/<br\b[^>]*\/?>/gi, "\n")
		.replace(/<\/(p|h[1-6]|li|pre|dl|dt|dd)>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(body)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}
