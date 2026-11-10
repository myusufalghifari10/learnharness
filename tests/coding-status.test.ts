/**
 * describeCodingWorkspaceStatus (src/agent/coding-workspace-status.ts) and the
 * prompt seam that carries it (withWorkspaceStatus in teacher-agent.ts).
 *
 * The block exists so the model stops guessing whether the Code view is open.
 * Every uncertain case must degrade to text, never to a throw: a status read
 * failure may not fail a chat turn.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { describeCodingWorkspaceStatus } from "../src/agent/coding-workspace-status.ts";
import { withWorkspaceStatus } from "../src/agent/teacher-agent.ts";
import { editorSocketPath } from "../src/core/code-editor.ts";

const tempDirs: string[] = [];
function workspace(): { dataDir: string; root: string; socket: string } {
	const dataDir = mkdtempSync(join(tmpdir(), "lh-code-status-"));
	tempDirs.push(dataDir);
	const root = join(dataDir, "code", "scratch");
	mkdirSync(root, { recursive: true });
	return { dataDir, root, socket: editorSocketPath(root, "scratch") };
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A live editor's state file: the socket is a plain file here (existence is
 *  all the status reader checks; the real socket belongs to the PTY tests). */
function liveEditor(root: string, socket = editorSocketPath(root, "scratch"), cwd = root, pid = 4242): void {
	writeFileSync(join(root, ".editor.json"), JSON.stringify({ socket, pid, scope: "scratch", cwd }));
	writeFileSync(socket, "");
}

// process.execPath is executable, so the nvim resolver accepts it without a
// fake binary on disk; the probe stub never runs it.
const env = { ...process.env, LH_NVIM: process.execPath };

describe("describeCodingWorkspaceStatus", () => {
	it("reports an unopened Code view without probing anything", async () => {
		const { dataDir } = workspace();
		let probed = false;
		const status = await describeCodingWorkspaceStatus({
			dataDir,
			env,
			probe: async () => {
				probed = true;
				return "";
			},
		});
		assert.equal(status.running, false);
		assert.equal(status.stale, false);
		assert.equal(probed, false, "no state file means no subprocess");
		assert.match(status.text, /^## Coding workspace \(live\)/);
		assert.ok(status.text.includes(join(dataDir, "code", "scratch")));
		assert.match(status.text, /Editor: not open/);
	});

	it("reports a running editor and the active buffer", async () => {
		const { dataDir, root, socket } = workspace();
		liveEditor(root);
		const calls: string[][] = [];
		const status = await describeCodingWorkspaceStatus({
			dataDir,
			env,
			probe: async (_file, args) => {
				calls.push(args);
				return `${join(root, "exercise.py")}\n`;
			},
		});
		assert.equal(status.running, true);
		assert.equal(status.stale, false);
		assert.equal(status.pid, 4242);
		assert.equal(status.activeFile, join(root, "exercise.py"));
		assert.match(status.text, /Editor: running \(Neovim, pid 4242\)/);
		assert.match(status.text, /Active buffer: .*exercise\.py/);
		assert.deepEqual(calls[0]!.slice(0, 2), ["--server", socket]);
	});

	it("degrades to an unknown buffer when the probe fails", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		const status = await describeCodingWorkspaceStatus({
			dataDir,
			env,
			probe: async () => {
				throw new Error("connect ENOENT");
			},
		});
		assert.equal(status.running, true);
		assert.equal(status.activeFile, null);
		assert.match(status.text, /Active buffer: unknown/);
	});

	it("ignores an active buffer outside the workspace", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		const status = await describeCodingWorkspaceStatus({ dataDir, env, probe: async () => "/etc/passwd\n" });
		assert.equal(status.activeFile, null);
	});

	it("calls a mismatched socket stale instead of running", async () => {
		const { dataDir, root } = workspace();
		const foreign = join(root, "..", "foreign.sock");
		writeFileSync(join(root, ".editor.json"), JSON.stringify({ socket: foreign, pid: 1, scope: "scratch", cwd: root }));
		writeFileSync(foreign, "");
		const status = await describeCodingWorkspaceStatus({ dataDir, env, probe: async () => "" });
		assert.equal(status.running, false);
		assert.equal(status.stale, true);
		assert.match(status.text, /reopen the Code view/);
	});

	it("calls a vanished socket stale (the editor died but left its state)", async () => {
		const { dataDir, root } = workspace();
		liveEditor(root);
		rmSync(editorSocketPath(root, "scratch"));
		const status = await describeCodingWorkspaceStatus({ dataDir, env, probe: async () => "" });
		assert.equal(status.running, false);
		assert.equal(status.stale, true);
	});
});

describe("the prompt seam", () => {
	it("appends the block to the end of the composed prompt", () => {
		assert.equal(withWorkspaceStatus("BASE", undefined), "BASE");
		assert.equal(withWorkspaceStatus("BASE", "   "), "BASE");
		const composed = withWorkspaceStatus("BASE", "## Coding workspace (live)\n\nWorkspace: /w\n");
		assert.ok(composed.startsWith("BASE\n\n---\n\n"));
		assert.ok(composed.endsWith("Workspace: /w"));
	});
});
