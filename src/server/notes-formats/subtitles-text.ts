/**
 * Subtitle files as text (owner, 2026-11-14).
 *
 * Lecture recordings and videos arrive as `.srt` or `.vtt`. The timestamps and
 * cue numbers carry nothing the extractor needs; the cue text does, in reading
 * order. Inline styling tags go too. Cues are separated by a blank line so
 * sentence boundaries survive.
 */

const TIMESTAMP = /^(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->/;

export function subtitlesToText(text: string): string {
	const cues: string[] = [];
	let current: string[] = [];
	const flush = () => {
		const cue = current.join(" ").replace(/\s+/g, " ").trim();
		if (cue) cues.push(cue);
		current = [];
	};
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") {
			flush();
			continue;
		}
		if (/^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
		if (TIMESTAMP.test(line)) continue;
		if (/^\d+$/.test(line) && current.length === 0) continue; // cue number
		current.push(line.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, ""));
	}
	flush();
	return cues.join("\n\n");
}
