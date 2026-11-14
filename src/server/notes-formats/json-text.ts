/**
 * JSON as text (owner, 2026-11-14).
 *
 * A question bank exported as JSON (the learner's own case: an array of 65
 * records with id/text/options/answer) is unreadable to the extractor as a raw
 * dump — one enormous line with braces and escapes. So records are rendered as
 * labelled lines instead: array items become `## 1`, `## 2` sections, object
 * keys become `key: value`, and nested arrays become bullet lists. Same
 * content, in the shape a reader would otherwise write by hand.
 */

/** Deeper than this and the record is summarised instead of exploded. */
const MAX_DEPTH = 6;
/** A record with more keys/items than this is a table, not a note. */
const MAX_ITEMS = 5000;

export class JsonTextError extends Error {}

const scalar = (value: unknown): string | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value.trim().replace(/\s*\n\s*/g, " ");
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
};

function render(value: unknown, depth: number, indent: string): string[] {
	// `typeof null === "object"`, and a real bank (the owner's certsafari export,
	// 2026-11-14) carries `"select": null` in 34 of 35 records: without this
	// line Object.entries(null) throws and the whole file is refused.
	if (value === null || value === undefined) return [];
	if (depth > MAX_DEPTH) {
		const flat = scalar(value);
		return flat === null ? [] : [`${indent}${flat}`];
	}
	if (Array.isArray(value)) {
		const lines: string[] = [];
		value.slice(0, MAX_ITEMS).forEach((item, index) => {
			const flat = scalar(item);
			if (flat !== null) lines.push(`${indent}- ${flat}`);
			else {
				const nested = render(item, depth + 1, `${indent}  `);
				if (nested.length > 0) lines.push(`${indent}-`, ...nested);
			}
			if (index === MAX_ITEMS - 1 && value.length > MAX_ITEMS) lines.push(`${indent}- … ${value.length - MAX_ITEMS} more items`);
		});
		return lines;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		const lines: string[] = [];
		for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
			const flat = scalar(item);
			if (flat !== null) lines.push(`${indent}${key}: ${flat}`);
			else {
				const nested = render(item, depth + 1, `${indent}  `);
				if (nested.length > 0) lines.push(`${indent}${key}:`, ...nested);
			}
		}
		if (entries.length > MAX_ITEMS) lines.push(`${indent}… ${entries.length - MAX_ITEMS} more keys`);
		return lines;
	}
	const flat = scalar(value);
	return flat === null ? [] : [`${indent}${flat}`];
}

/** Throws JsonTextError when the text is not JSON at all. */
export function jsonToText(text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new JsonTextError(`Could not read this JSON file. ${error instanceof Error ? error.message : ""}`.trim());
	}
	if (Array.isArray(parsed)) {
		const blocks: string[] = [];
		parsed.slice(0, MAX_ITEMS).forEach((item, index) => {
			const body = render(item, 1, "");
			if (body.length > 0) blocks.push(`## ${index + 1}\n${body.join("\n")}`);
		});
		if (parsed.length > MAX_ITEMS) blocks.push(`## … ${parsed.length - MAX_ITEMS} more records`);
		return blocks.join("\n\n");
	}
	const body = render(parsed, 0, "");
	if (body.length === 0) throw new JsonTextError("This JSON file has no text in it.");
	return body.join("\n");
}
