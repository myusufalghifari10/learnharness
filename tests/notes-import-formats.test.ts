/**
 * The import boundary's converters (owner, 2026-11-14).
 *
 * Every case here is a payload a real user has, or could plausibly have, in
 * their notes folder: a Word document with headings and a table, a deck whose
 * slide order lives in presentation.xml, a question-bank JSON, an exported HTML
 * page, a spreadsheet CSV with a comma inside a quoted cell, an RTF with a
 * skipped font table, subtitles, and a few files that must be refused rather
 * than half-read.
 *
 * The office fixtures are built as REAL zip archives in the test (deflate via
 * node:zlib), so the reader is exercised against the container format itself and
 * not a mock of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { docxDocumentText } from "../src/server/notes-formats/docx.ts";
import { htmlToText } from "../src/server/notes-formats/html-text.ts";
import { jsonToText, JsonTextError } from "../src/server/notes-formats/json-text.ts";
import { pptxText, slideText } from "../src/server/notes-formats/pptx.ts";
import { rtfToText } from "../src/server/notes-formats/rtf-text.ts";
import { subtitlesToText } from "../src/server/notes-formats/subtitles-text.ts";
import { tableToText } from "../src/server/notes-formats/table-text.ts";
import { convertNotes, MAX_NOTES_CHARS } from "../src/server/notes-formats/convert.ts";
import { IMPORT_ACCEPT, IMPORT_EXTENSIONS } from "../lib/notes-import-limits.ts";
import { readZipEntries, zipText } from "../src/server/notes-formats/zip.ts";

/** A minimal but spec-shaped archive: stored/deflate entries, central directory, EOCD. */
function buildZip(files: { name: string; data: string }[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const raw = Buffer.from(file.data, "utf8");
		const payload = deflateRawSync(raw);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(0, 10);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, payload);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(0, 12);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += local.length + name.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}

const DOCX_XML = `<w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Domain 1 — Design Secure Architectures</w:t></w:r></w:p>
<w:p><w:r><w:t>IAM policies grant </w:t></w:r><w:r><w:t>least privilege</w:t></w:r><w:r><w:t> by default.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Enable MFA on the root user</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Service</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Scope</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>EC2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Zonal</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t xml:space="preserve">A &amp; B &lt;scope&gt;</w:t></w:r></w:p>
</w:body></w:document>`;

describe("zip reader — the container the office formats live in", () => {
	it("returns every file entry, deflated or stored", () => {
		const entries = readZipEntries(buildZip([
			{ name: "word/document.xml", data: "<w:document>hello</w:document>" },
			{ name: "docProps/app.xml", data: "".padEnd(4000, "x") },
		]));
		assert.equal(entries.size, 2);
		assert.equal(zipText(entries, "word/document.xml"), "<w:document>hello</w:document>");
		assert.equal(zipText(entries, "docProps/app.xml")?.length, 4000);
		assert.equal(zipText(entries, "missing.xml"), undefined);
	});

	it("refuses a non-archive instead of guessing", () => {
		assert.throws(() => readZipEntries(new TextEncoder().encode("just text, not a zip file at all")));
	});
});

describe("docx — headings, paragraphs, lists and table cells", () => {
	it("keeps one line per paragraph and marks structure", () => {
		const text = docxDocumentText(DOCX_XML);
		assert.match(text, /^# Domain 1 — Design Secure Architectures$/m);
		assert.match(text, /^IAM policies grant least privilege by default\.$/m);
		assert.match(text, /^- Enable MFA on the root user$/m);
		assert.match(text, /^Service \| $/m, "table cells end with a separator");
		assert.match(text, /^Zonal \| $/m);
		assert.match(text, /^A & B <scope>$/m, "entities decode");
	});
});

describe("pptx — deck order comes from presentation.xml", () => {
	const slide2 = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second created, second shown</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	const slide1 = `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First created, shown last</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

	it("follows r:id order, not file numbering", () => {
		const presentation = `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`;
		const rels = `<Relationships><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId3" Target="slides/slide1.xml"/></Relationships>`;
		const text = pptxText(presentation, rels, new Map([
			["ppt/slides/slide1.xml", slide1],
			["ppt/slides/slide2.xml", slide2],
		]));
		assert.match(text, /## Slide 1\nSecond created, second shown/);
		assert.match(text, /## Slide 2\nFirst created, shown last/);
	});

	it("joins runs inside one paragraph and drops empty ones", () => {
		const xml = `<a:p><a:r><a:t>Amazon </a:t></a:r><a:r><a:t>S3</a:t></a:r></a:p><a:p><a:r><a:t>  </a:t></a:r></a:p>`;
		assert.equal(slideText(xml), "Amazon S3");
	});
});

describe("json — a question bank becomes labelled records", () => {
	it("renders array items as sections with nested options", () => {
		const text = jsonToText(JSON.stringify([
			{ id: "saa-001", text: "Which options encrypt at rest?", options: [{ id: "a", text: "SSE-S3" }, { id: "b", text: "TLS" }], answer: "a" },
			{ id: "saa-002", text: "Second question", answer: "b" },
		]));
		assert.match(text, /## 1\nid: saa-001\ntext: Which options encrypt at rest\?/);
		assert.match(text, /options:\n {2}-\n {4}id: a\n {4}text: SSE-S3/);
		assert.match(text, /answer: a/);
		assert.match(text, /## 2\nid: saa-002/);
	});

	it("survives null fields — the shape a real export actually has (bug 2026-11-14)", () => {
		// The owner's certsafari export carries "select": null in 34 of 35 records;
		// Object.entries(null) used to throw and the whole file was refused with
		// "Cannot convert undefined or null to object".
		const text = jsonToText(JSON.stringify([
			{ id: "saa-001", text: "Which service is regional?", select: null, options: [{ id: "a", text: "EC2" }, { id: "b", text: "S3" }], answer: "a" },
			{ id: "saa-002", text: "Nulls inside arrays", options: [null, { id: "a", text: "IAM" }], extra: null },
		]));
		assert.match(text, /## 1\nid: saa-001/);
		assert.match(text, /answer: a/);
		assert.match(text, /## 2\nid: saa-002/);
		assert.match(text, /text: IAM/);
		assert.doesNotMatch(text, /select:/, "a null field is omitted, not printed as null");
	});

	it("survives a null record and a null document", () => {
		assert.match(jsonToText(JSON.stringify([null, { id: "x" }])), /id: x/);
		assert.throws(() => jsonToText("null"), JsonTextError);
	});

	it("refuses broken JSON with a sentence, not a stack", () => {
		assert.throws(() => jsonToText("{ not json"), (error: unknown) => error instanceof JsonTextError && /Could not read this JSON file/.test(error.message));
	});
});

describe("html — prose survives, scripts do not", () => {
	it("keeps headings, list items and table cells, decodes entities", () => {
		const text = htmlToText(`<html><head><title>t</title><style>.a{}</style></head><body>
			<script>var x = 1;</script><h2>Encryption</h2><p>SSE-S3 &amp; SSE-KMS</p>
			<ul><li>at rest</li><li>in transit</li></ul>
			<table><tr><td>S3</td><td>Global</td></tr></table></body></html>`);
		assert.match(text, /Encryption/);
		assert.match(text, /SSE-S3 & SSE-KMS/);
		assert.match(text, /- at rest/);
		assert.match(text, /S3 \| Global/);
		assert.doesNotMatch(text, /var x|\.a\{/);
	});
});

describe("csv/tsv — quoted cells and a markdown table", () => {
	it("keeps a comma inside quotes in one cell", () => {
		const text = tableToText('service,scope\n"S3, Glacier",global\nEC2,regional\n', ",");
		assert.equal(text.split("\n")[0], "| service | scope |");
		assert.equal(text.split("\n")[1], "| --- | --- |");
		assert.match(text, /\| S3, Glacier \| global \|/);
		assert.match(text, /\| EC2 \| regional \|/);
	});

	it("splits on tabs for tsv", () => {
		const text = tableToText("term\tmeaning\nARN\tidentity\n", "\t");
		assert.match(text, /\| ARN \| identity \|/);
	});
});

describe("rtf — control words stripped, text kept", () => {
	it("skips the font table and keeps paragraphs and escapes", () => {
		const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Calibri;}}{\colortbl;\red0\green0\blue0;}\f0\pard Least privilege is the default.\par MFA \'93required\'94 on root.\par}`;
		const text = rtfToText(rtf);
		assert.match(text, /Least privilege is the default\./);
		assert.match(text, /MFA “required” on root\./);
		assert.doesNotMatch(text, /Calibri|\\pard|fonttbl/);
	});
});

describe("subtitles — cue text in reading order", () => {
	it("drops indexes and timestamps for srt and vtt", () => {
		const srt = "1\n00:00:01,000 --> 00:00:03,500\nAmazon S3 stores objects\n\n2\n00:00:04,000 --> 00:00:06,000\ninside a bucket region\n";
		assert.equal(subtitlesToText(srt), "Amazon S3 stores objects\n\ninside a bucket region");
		const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Lecturer>Buckets have a global name</v>\n";
		assert.equal(subtitlesToText(vtt), "Buckets have a global name");
	});
});

describe("convertNotes — one boundary, content first", () => {
	it("reads a docx even when the name lies", async () => {
		const bytes = buildZip([{ name: "word/document.xml", data: DOCX_XML }]);
		const result = await convertNotes(bytes, "notes.txt");
		assert.equal(result.kind, "notes");
		if (result.kind === "notes") assert.match(result.text, /least privilege/);
	});

	it("reads a pptx deck with its slide markers", async () => {
		const bytes = buildZip([
			{ name: "ppt/presentation.xml", data: `<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>` },
			{ name: "ppt/_rels/presentation.xml.rels", data: `<Relationship Id="rId2" Target="slides/slide1.xml"/>` },
			{ name: "ppt/slides/slide1.xml", data: `<a:p><a:r><a:t>Well-Architected pillars</a:t></a:r></a:p>` },
		]);
		const result = await convertNotes(bytes, "deck.pptx");
		assert.equal(result.kind, "notes");
		if (result.kind === "notes") assert.match(result.text, /## Slide 1\nWell-Architected pillars/);
	});

	it("refuses a spreadsheet, an empty file and a picture with plain sentences", async () => {
		const sheet = await convertNotes(buildZip([{ name: "xl/workbook.xml", data: "<workbook/>" }]), "grades.xlsx");
		assert.deepEqual(sheet, { kind: "refused", error: "Spreadsheets are not supported. Export the sheet as CSV instead." });
		const empty = await convertNotes(new Uint8Array(), "blank.txt");
		assert.equal(empty.kind, "refused");
		const picture = await convertNotes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "photo.jpg");
		assert.deepEqual(picture, { kind: "refused", error: "This file is not UTF-8 text. Re-save it as UTF-8 and try again." });
	});

	it("caps runaway text and says so", async () => {
		const huge = "a".repeat(MAX_NOTES_CHARS + 10);
		const result = await convertNotes(new TextEncoder().encode(huge), "huge.txt");
		assert.equal(result.kind, "notes");
		if (result.kind === "notes") {
			assert.equal(result.text.length, MAX_NOTES_CHARS);
			assert.match(result.notice ?? "", /Only the first 2,000,000 characters were read\./);
		}
	});
});

describe("the file picker cannot drift from the allowlist", () => {
	it("every accepted extension is one the queue will send", () => {
		for (const extension of IMPORT_ACCEPT.split(",")) {
			assert.match(extension, IMPORT_EXTENSIONS, `${extension} is offered but refused`);
		}
	});

	it("the formats this feature added are all offered", () => {
		for (const extension of [".json", ".docx", ".pptx", ".html", ".htm", ".csv", ".tsv", ".rtf", ".srt", ".vtt"]) {
			assert.ok(IMPORT_ACCEPT.includes(extension), `${extension} is missing from the picker`);
		}
	});
});
