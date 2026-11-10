/**
 * open_in_editor (src/agent/tools/open-in-editor.ts).
 *
 * The tool is the agent's only way into the running editor, so its refusals
 * matter more than its happy path: no live editor, a path outside the
 * workspace, a missing file, and a dead socket must all fail loudly with a
 * message the model can act on — never by spawning a second nvim.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createOpenInEditorTool, readEditorState } from "../src/agent/tools/open-in-editor.ts";
import { editorSocketPath } from "../src/core/code-editor.ts";

const tempDirs: string[] = [];
function workspace(): { dataDir: string; root: string } {
	const dataDir = mkdtempSync(join(tmpdir(), "lh-open-editor-"));
	tempDirs.push(dataDir);
	const root = join(dataDir, "code", "scratch");
	mkdirSync(root, { recursive: true });
	return { dataDir, root };
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function liveEditor(root: string, socket = editorSocketPath(root, "scratch")): void {
	writeFileSync(join(root, ".editor.json"), JSON.stringify({ socket, pid: 4242, scope: "scratch", cwd: root }));
}

// process.execPath is a real executable, so the resolver accepts it without a
// fake binary on disk; the exec stub never runs it.
const env = { ...process.env, LH_NVIM: process.execPath };

async function run(tool: ReturnType<typeof createOpenInEditorTool>, input: { path: string }): Promise<string> {
	return JSON.stringify(await tool.execute("call-1", input, undefined));
}

describe("open_in_editor", () => {
	it("opens an existing workspace file in the running editor", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		writeFileSync(join(root, "hello.py"), "print('hi')\n");
		const calls: Array<{ file: string; args: string[] }> = [];
		const tool = createOpenInEditorTool({
			dataDir,
			env,
			execFile: async (file, args) => {
				calls.push({ file, args });
			},
		});
		const result = await run(tool, { path: "hello.py" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.file, process.execPath);
		assert.deepEqual(calls[0]!.args, ["--server", editorSocketPath(root, "scratch"), "--remote", join(root, "hello.py")]);
		assert.match(result, /hello\.py/);
		assert.ok(result.includes(root), "result carries the workspace path for later ls/read calls");
	});

	it("refuses a path that escapes the workspace", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		writeFileSync(join(dataDir, "code", "outside.txt"), "nope\n");
		const tool = createOpenInEditorTool({ dataDir, env, execFile: async () => {} });
		await assert.rejects(() => run(tool, { path: "../outside.txt" }), /outside the coding workspace/);
		await assert.rejects(() => run(tool, { path: "/etc/passwd" }), /outside the coding workspace/);
	});

	it("refuses when no editor is running", async () => {
		const { dataDir } = workspace();
		const tool = createOpenInEditorTool({ dataDir, env, execFile: async () => {} });
		await assert.rejects(() => run(tool, { path: "hello.py" }), /No coding editor is running/);
	});

	it("reports a missing file instead of opening a new buffer", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		const tool = createOpenInEditorTool({ dataDir, env, execFile: async () => {} });
		await assert.rejects(() => run(tool, { path: "nope.py" }), /File not found/);
	});

	it("explains a dead socket (editor closed mid-session)", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		writeFileSync(join(root, "hello.py"), "x\n");
		const tool = createOpenInEditorTool({
			dataDir,
			env,
				execFile: async () => {
				throw new Error(`connect ENOENT ${editorSocketPath(root, "scratch")}`);
			},
		});
		await assert.rejects(() => run(tool, { path: "hello.py" }), /Could not reach the running editor/);
	});

	it("reads the state file the PTY host writes", async () => {
		const { root } = workspace();
		assert.equal(await readEditorState(root), null);
		liveEditor(root, "/tmp/sock");
		const state = await readEditorState(root);
		assert.equal(state?.socket, "/tmp/sock");
		assert.equal(state?.pid, 4242);
	});
});
