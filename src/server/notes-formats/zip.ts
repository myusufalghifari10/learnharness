/**
 * The ZIP container reader the office formats need (owner, 2026-11-14).
 *
 * `.docx` and `.pptx` are ZIP archives of XML parts; nothing else about them is
 * new. Node ships zlib but no container reader, and the container is ~90 lines
 * of spec: end-of-central-directory, one central entry per file, one local
 * header before each payload. Written here instead of pulling a dependency, and
 * kept to what Word/PowerPoint actually emit: stored and deflate entries, no
 * zip64 (a refusal, never a wrong read), no encryption.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATE = 8;
const ZIP64 = 0xffffffff;

export class ZipError extends Error {}

/** Every file entry in the archive, keyed by its in-archive path. */
export function readZipEntries(data: Uint8Array): Map<string, Uint8Array> {
	if (data.byteLength < EOCD_MIN) throw new ZipError("not a zip archive");
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let eocd = -1;
	for (let i = data.byteLength - EOCD_MIN; i >= Math.max(0, data.byteLength - EOCD_MIN - MAX_COMMENT); i--) {
		if (view.getUint32(i, true) === EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError("not a zip archive");
	const count = view.getUint16(eocd + 10, true);
	const directoryOffset = view.getUint32(eocd + 16, true);
	if (count === 0xffff || directoryOffset === ZIP64) throw new ZipError("zip64 archives are not supported");

	const entries = new Map<string, Uint8Array>();
	let cursor = directoryOffset;
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > data.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIG) throw new ZipError("corrupt zip directory");
		const method = view.getUint16(cursor + 10, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const uncompressedSize = view.getUint32(cursor + 24, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const name = new TextDecoder().decode(data.subarray(cursor + 46, cursor + 46 + nameLength));
		cursor += 46 + nameLength + extraLength + commentLength;
		if (compressedSize === ZIP64 || uncompressedSize === ZIP64 || localOffset === ZIP64) throw new ZipError("zip64 archives are not supported");
		if (name.endsWith("/")) continue; // directory marker
		if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIG) throw new ZipError("corrupt zip entry");
		const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
		if (start + compressedSize > data.byteLength) throw new ZipError("zip entry runs past the archive");
		const payload = data.subarray(start, start + compressedSize);
		if (method === STORED) entries.set(name, payload);
		else if (method === DEFLATE) entries.set(name, new Uint8Array(inflateRawSync(payload)));
		else throw new ZipError(`unsupported zip compression method ${method}`);
	}
	return entries;
}

/** One archive part as text, or undefined when the part is absent. */
export function zipText(entries: Map<string, Uint8Array>, name: string): string | undefined {
	const bytes = entries.get(name);
	return bytes ? new TextDecoder().decode(bytes) : undefined;
}
