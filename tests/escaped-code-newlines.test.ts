/**
 * The flattened-document repair (2026-11-11, deepseek-flash observed case).
 *
 * A model that double-escapes its own line breaks delivers a whole quiz
 * question on ONE line: ```python\ndef hitung(n):\n    total = 0\n…```. Markdown
 * reads that as a single inline-code span, the learner sees an unreadable
 * string of backslashes, and the code block never appears. unflattenEscapedDocument
 * reopens it, display-only, behind an evidence gate so ordinary prose and real
 * code examples are never rewritten.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unflattenEscapedDocument } from "../src/core/content-reader.ts";
import { repairMathForDisplay } from "../src/core/math-delims.ts";

/** The exact shape the app received: one physical line, fences and breaks
 *  written as literal two-character `\n` sequences. */
const flattened =
	"Kamu bilang pernah belajar sedikit lalu lupa. Saya tidak mau menebak seberapa dalam lubangnya.\\n\\n" +
	"Apa yang dicetak program ini?\\n\\n" +
	"```python\\ndef hitung(n):\\n    total = 0\\n    i = 1\\n    while i < n:\\n        total += i\\n        i += 1\\n    return total\\n\\nprint(hitung(4))\\n```";

const literalBreaks = (text: string) => (text.match(/\\n/g) ?? []).length;
const realBreaks = (text: string) => (text.match(/\n/g) ?? []).length;

describe("unflattenEscapedDocument: the double-escaped document", () => {
	it("reopens the fence and every line of the real observed question", () => {
		const fixed = unflattenEscapedDocument(flattened);
		assert.equal(literalBreaks(fixed), 0, "no literal backslash-n survives");
		assert.ok(realBreaks(fixed) >= 10, "the breaks became real newlines");
		assert.ok(fixed.includes("\n```python\n"), "the fence now opens at a line start");
		assert.ok(fixed.includes("\n        total += i\n"), "code indentation lands on its own line");
		assert.ok(fixed.includes("\nprint(hitung(4))\n```"), "the closing fence is a line of its own");
		// Prose is untouched character for character.
		assert.ok(fixed.startsWith("Kamu bilang pernah belajar sedikit lalu lupa."));
		assert.ok(fixed.includes("Apa yang dicetak program ini?"));
	});

	it("is the same text repairMathForDisplay hands to the renderer", () => {
		const viaRepair = repairMathForDisplay(flattened);
		assert.equal(literalBreaks(viaRepair), 0);
		assert.ok(viaRepair.includes("\n```python\n"));
	});

	it("leaves a document that already has real newlines alone (identity)", () => {
		const normal = "Apa outputnya?\n\n```python\nprint(1)\n```";
		assert.equal(unflattenEscapedDocument(normal), normal);
	});

	it("leaves a single-line sentence with ONE escape token alone", () => {
		const sentence = "Gunakan \\n untuk menulis newline di Python.";
		assert.equal(unflattenEscapedDocument(sentence), sentence);
	});

	it("never rewrites real TeX commands that start with n", () => {
		const tex = "Nilai $\\nu$ turun, $\\nabla f$ tetap.\\n\\n```python\\nprint(1)\\n```";
		const fixed = unflattenEscapedDocument(tex);
		assert.ok(fixed.includes("$\\nu$"), "\\nu is a TeX identity, not a line break");
		assert.ok(fixed.includes("$\\nabla f$"));
		assert.ok(fixed.includes("\n```python\n"), "the real escapes still decode");
	});

	it("keeps a Windows path in one piece", () => {
		const path = "Berkas ada di C:\\new\\notes.txt, baca dulu.\\n\\n```python\\nprint(1)\\n```";
		const fixed = unflattenEscapedDocument(path);
		assert.ok(fixed.includes("C:\\new\\notes.txt"), "C:\\new is a path, not a line break");
	});

	it("decodes a code line that ends in `n:` (the drive-letter false positive)", () => {
		// `while i < n:\n        total` — the old path guard read `n:\` as a drive.
		const fixed = unflattenEscapedDocument(flattened);
		assert.ok(fixed.includes("while i < n:\n        total += i"), "the body stayed a new line, not `\\n…`");
	});
});
