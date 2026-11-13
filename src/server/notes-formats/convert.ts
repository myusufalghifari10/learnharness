/**
 * The import boundary: bytes in, extractor-ready text out (owner, 2026-11-14).
 *
 * One function, one result shape — `{ kind: "notes", text, notice? }` or
 * `{ kind: "refused", error }` — which is exactly what the import route already
 * consumed for PDF. Formats are recognised by CONTENT first (PDF magic bytes,
 * ZIP containers) and by name only for the plain-text family, so a renamed file
 * still reads correctly. Nothing here talks to a model: a bad file is refused
 * before any source record or model call exists.
 *
 * Refusals are user-facing sentences, never stack traces.
 */
import { convertPdf } from "../../agent/subagents/pdf-ops.ts";
import { joinPages } from "../../agent/subagents/pdf-markdown.ts";
import { docxDocumentText } from "./docx.ts";
import { htmlToText } from "./html-text.ts";
import { jsonToText } from "./json-text.ts";
import { pptxText } from "./pptx.ts";
import { rtfToText } from "./rtf-text.ts";
import { subtitlesToText } from "./subtitles-text.ts";
import { tableToText } from "./table-text.ts";
import { readZipEntries, zipText } from "./zip.ts";

export type NotesConversion = { kind: "notes"; text: string; notice?: string } | { kind: "refused"; error: string };

const MAX_PDF_PAGES = 1000;
/** ~2 MB of text is already far more than one extraction run should read. */
export const MAX_NOTES_CHARS = 2_000_000;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

const startsWith = (bytes: Uint8Array, magic: number[]): boolean =>
	bytes.byteLength >= magic.length && magic.every((byte, index) => bytes[index] === byte);

const extensionOf = (name: string): string => {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

async function pdfText(bytes: Uint8Array): Promise<NotesConversion> {
	const pdf = await convertPdf(bytes, MAX_PDF_PAGES);
	switch (pdf.kind) {
		case "unreadable":
			return { kind: "refused", error: "Could not open this PDF." };
		case "too-long":
			return { kind: "refused", error: "Too long. Max 1,000 pages." };
		case "converted": {
			const text = joinPages(pdf.pages);
			if (!text) return { kind: "refused", error: "OCR not supported yet." };
			const skipped = pdf.pages.filter((page) => page.kind === "image-only").length;
			const omission = skipped > 0 ? ` Skipped ${skipped} image-only ${skipped === 1 ? "page" : "pages"}; OCR is not supported.` : "";
			return { kind: "notes", text, notice: `Scanned pages may have errors.${omission}` };
		}
	}
}

function officeText(bytes: Uint8Array): NotesConversion {
	let entries: Map<string, Uint8Array>;
	try {
		entries = readZipEntries(bytes);
	} catch {
		return { kind: "refused", error: "Could not open this file. Is it a complete Word or PowerPoint document?" };
	}
	const document = zipText(entries, "word/document.xml");
	if (document !== undefined) {
		const text = docxDocumentText(document);
		return text.trim() ? { kind: "notes", text } : { kind: "refused", error: "This Word document has no text in it." };
	}
	if (entries.has("ppt/presentation.xml")) {
		const slides = new Map<string, string>();
		for (const [name, value] of entries) if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slides.set(name, new TextDecoder().decode(value));
		const text = pptxText(zipText(entries, "ppt/presentation.xml"), zipText(entries, "ppt/_rels/presentation.xml.rels"), slides);
		return text.trim() ? { kind: "notes", text } : { kind: "refused", error: "This PowerPoint file has no text in it." };
	}
	if (entries.has("xl/workbook.xml")) return { kind: "refused", error: "Spreadsheets are not supported. Export the sheet as CSV instead." };
	return { kind: "refused", error: "This file is not a Word or PowerPoint document." };
}

/** Strict UTF-8, or null: a picture renamed to .txt must not reach the model as
 *  a page of replacement characters. NUL is deliberately NOT rejected — that is
 *  a plain text byte, and the byte-boundary path already pins it as text. */
function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Convert one uploaded file. Throws never: every failure is a refusal. */
export async function convertNotes(bytes: Uint8Array, name: string): Promise<NotesConversion> {
	let converted: NotesConversion;
	if (startsWith(bytes, PDF_MAGIC)) converted = await pdfText(bytes);
	else if (startsWith(bytes, ZIP_MAGIC)) converted = officeText(bytes);
	else {
		const text = decodeUtf8(bytes);
		if (text === null) return { kind: "refused", error: "This file is not UTF-8 text. Re-save it as UTF-8 and try again." };
		const extension = extensionOf(name);
		try {
			switch (extension) {
				case "json":
					converted = { kind: "notes", text: jsonToText(text) };
					break;
				case "html":
				case "htm":
					converted = { kind: "notes", text: htmlToText(text) };
					break;
				case "csv":
					converted = { kind: "notes", text: tableToText(text, ",") };
					break;
				case "tsv":
					converted = { kind: "notes", text: tableToText(text, "\t") };
					break;
				case "rtf":
					converted = { kind: "notes", text: rtfToText(text) };
					break;
				case "srt":
				case "vtt":
					converted = { kind: "notes", text: subtitlesToText(text) };
					break;
				default:
					converted = { kind: "notes", text };
			}
		} catch (error) {
			return { kind: "refused", error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (converted.kind === "refused") return converted;
	if (!converted.text.trim()) return { kind: "refused", error: "This file has no text in it." };
	if (converted.text.length <= MAX_NOTES_CHARS) return converted;
	const notice = `Only the first ${MAX_NOTES_CHARS.toLocaleString("en-US")} characters were read.`;
	return { kind: "notes", text: converted.text.slice(0, MAX_NOTES_CHARS), notice: converted.notice ? `${converted.notice} ${notice}` : notice };
}
