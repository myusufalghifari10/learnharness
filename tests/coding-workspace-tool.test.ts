/**
 * write_workspace_file (src/agent/tools/write-workspace.ts).
 *
 * The writing half of the coding workspace. The refusals are the contract:
 * a path outside the workspace, a symlink escape, the app's own bookkeeping
 * files, an unrequested overwrite of the learner's edits, and an oversized
 * payload must all fail loudly and leave the bytes on disk untouched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	createWriteWorkspaceFileTool,
	writeWorkspaceFileLimits,
	type WriteWorkspaceFileInput,
} from "../src/agent/tools/write-workspace.ts";

const tempDirs: string[] = [];
function workspace(): { dataDir: string; root: string } {
	const dataDir = mkdtempSync(join(tmpdir(), "lh-write-workspace-"));
	tempDirs.push(dataDir);
	const root = join(dataDir, "code", "scratch");
	mkdirSync(root, { recursive: true });
	return { dataDir, root };
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function run(tool: ReturnType<typeof createWriteWorkspaceFileTool>, input: WriteWorkspaceFileInput): Promise<string> {
	return JSON.stringify(await tool.execute("call-1", input, undefined));
}

describe("write_workspace_file", () => {
	it("writes a nested file and reports the workspace path", async () => {
		const { dataDir, root } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		const result = await run(tool, { path: "exercises/strings.py", content: "print('hi')\n" });
		assert.equal(readFileSync(join(root, "exercises/strings.py"), "utf8"), "print('hi')\n");
		assert.match(result, /exercises\/strings\.py/);
		assert.ok(result.includes(root), "result carries the workspace path for ls/read");
		assert.match(result, /open_in_editor/);
	});

	it("refuses a path that escapes the workspace", async () => {
		const { dataDir, root } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		await assert.rejects(() => run(tool, { path: "../outside.py", content: "x\n" }), /outside the coding workspace/);
		await assert.rejects(() => run(tool, { path: "/tmp/lh-escape.py", content: "x\n" }), /outside the coding workspace/);
		assert.equal(existsSync(join(root, "..", "outside.py")), false);
	});

	it("refuses a symlinked directory that points outside the workspace", async () => {
		const { dataDir, root } = workspace();
		const outside = mkdtempSync(join(tmpdir(), "lh-write-outside-"));
		tempDirs.push(outside);
		symlinkSync(outside, join(root, "link"));
		const tool = createWriteWorkspaceFileTool({ dataDir });
		await assert.rejects(() => run(tool, { path: "link/owned.ts", content: "x\n" }), /outside the coding workspace/);
		assert.equal(existsSync(join(outside, "owned.ts")), false, "nothing landed outside the workspace");
	});

	it("refuses the app's own bookkeeping files", async () => {
		const { dataDir } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		await assert.rejects(() => run(tool, { path: ".editor.json", content: "{}" }), /workspace bookkeeping/);
		await assert.rejects(() => run(tool, { path: ".nvim-scratch.sock", content: "x" }), /workspace bookkeeping/);
	});

	it("never replaces the learner's file without overwrite: true", async () => {
		const { dataDir, root } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		writeFileSync(join(root, "attempt.py"), "learner edits\n");
		await assert.rejects(
			() => run(tool, { path: "attempt.py", content: "agent edits\n" }),
			/already exists/,
		);
		assert.equal(readFileSync(join(root, "attempt.py"), "utf8"), "learner edits\n", "the learner's bytes survive a refused write");
		const result = await run(tool, { path: "attempt.py", content: "agent edits\n", overwrite: true });
		assert.match(result, /attempt\.py/);
		assert.equal(readFileSync(join(root, "attempt.py"), "utf8"), "agent edits\n");
	});

	it("refuses content over the cap instead of truncating it", async () => {
		const { dataDir, root } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		const oversized = "a".repeat(writeWorkspaceFileLimits.maxContentChars + 1);
		await assert.rejects(() => run(tool, { path: "big.txt", content: oversized }), /over the .* character limit/);
		assert.equal(existsSync(join(root, "big.txt")), false, "the rejected write left no file behind");
	});

	it("refuses a directory target", async () => {
		const { dataDir, root } = workspace();
		mkdirSync(join(root, "notes"));
		const tool = createWriteWorkspaceFileTool({ dataDir });
		await assert.rejects(() => run(tool, { path: "notes", content: "x" }), /is a directory/);
	});

	it("reports bytes and lines for an empty file", async () => {
		const { dataDir } = workspace();
		const tool = createWriteWorkspaceFileTool({ dataDir });
		const result = await run(tool, { path: "empty.py", content: "" });
		assert.match(result, /0 bytes, 0 lines/);
	});
});
