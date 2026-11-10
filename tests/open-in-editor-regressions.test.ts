/**
 * Regression pins for open_in_editor, review round 1 (2026-11-11).
 *
 * The tool's boundaries are the point: the workspace must confine it even
 * through a symlink, the spawn target must come from the app (not from a
 * mutable file anything in the workspace can rewrite), and the spawned client
 * must not inherit the desktop API secret.
 *
 * Lives beside tests/open-in-editor-tool.test.ts because the session gate
 * refuses edits to an existing test file.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createOpenInEditorTool } from "../src/agent/tools/open-in-editor.ts";
import { editorSocketPath } from "../src/core/code-editor.ts";

const tempDirs: string[] = [];
function workspace(): { dataDir: string; root: string } {
	const dataDir = mkdtempSync(join(tmpdir(), "lh-open-editor-regress-"));
	tempDirs.push(dataDir);
	const root = join(dataDir, "code", "scratch");
	mkdirSync(root, { recursive: true });
	return { dataDir, root };
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function liveEditor(root: string, overrides: Record<string, unknown> = {}): string {
	const socket = editorSocketPath(root, "scratch");
	writeFileSync(join(root, ".editor.json"), JSON.stringify({ socket, pid: 4242, scope: "scratch", cwd: root, ...overrides }));
	return socket;
}

const env = { ...process.env, LH_NVIM: process.execPath };

type ExecCall = { file: string; args: string[]; options: { env?: Record<string, string | undefined> } | undefined };

function recordingTool(dataDir: string, execEnv?: Record<string, string | undefined>) {
	const calls: ExecCall[] = [];
	const tool = createOpenInEditorTool({
		dataDir,
		env: execEnv ?? env,
		execFile: async (file, args, options) => {
			calls.push({ file, args, options });
		},
	});
	return { tool, calls };
}

async function run(tool: ReturnType<typeof createOpenInEditorTool>, input: { path: string }): Promise<string> {
	return JSON.stringify(await tool.execute("call-1", input, undefined));
}

describe("open_in_editor confinement", () => {
	it("refuses a path that escapes through a symlink inside the workspace", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		writeFileSync(join(dataDir, "secret.txt"), "private\n");
		// A directory symlink the learner's own shell (or a cloned exercise repo)
		// can create: lexically inside, really outside.
		symlinkSync(dataDir, join(root, "link"));
		const { tool, calls } = recordingTool(dataDir);

		await assert.rejects(() => run(tool, { path: "link/secret.txt" }), /outside the coding workspace/);
		assert.deepEqual(calls, [], "nothing is spawned for an escaping path");
	});

	it("refuses a state file whose socket is not this workspace's editor", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root, { socket: "/tmp/attacker-chosen.sock" });
		writeFileSync(join(root, "hello.py"), "print('hi')\n");
		const { tool, calls } = recordingTool(dataDir);

		await assert.rejects(() => run(tool, { path: "hello.py" }), /does not match|not the workspace editor/);
		assert.deepEqual(calls, [], "the tool never dials an address a workspace file chose");
	});

	it("refuses a state file that claims a different workspace directory", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root, { cwd: "/tmp/somewhere-else" });
		writeFileSync(join(root, "hello.py"), "x\n");
		const { tool } = recordingTool(dataDir);

		await assert.rejects(() => run(tool, { path: "hello.py" }), /does not match|not the workspace editor/);
	});

	it("opens a real workspace path and hands the client a sanitised env", async () => {
		const { dataDir, root } = workspace();
		const socket = liveEditor(root);
		writeFileSync(join(root, "hello.py"), "print('hi')\n");
		const { tool, calls } = recordingTool(dataDir, {
			...env,
			LH_DESKTOP_API_SECRET: "do-not-leak",
			LH_DESKTOP_SERVER: "1",
		});

		const result = await run(tool, { path: "hello.py" });
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0]!.args, ["--server", socket, "--remote", join(root, "hello.py")]);
		assert.equal(calls[0]!.options?.env?.LH_DESKTOP_API_SECRET, undefined, "the desktop API secret never reaches the child");
		assert.equal(calls[0]!.options?.env?.LH_DESKTOP_SERVER, undefined);
		assert.match(result, /hello\.py/);
	});
});
