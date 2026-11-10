/**
 * Coding-workspace PTY host (electron/code-session.cjs).
 *
 * Two things are pinned here:
 *  1. the pure rules — the CJS mirror must agree with src/core/code-editor.ts
 *     on the same fixtures (that is the whole reason the mirror is allowed);
 *  2. the real thing — node-pty spawns, keystrokes reach the child, resize is
 *     honoured, the editor writes `.editor.json` and both cleanup paths
 *     (kill, killAll) remove the socket + state file.
 *
 * The editor case uses a stand-in binary (a shell script that sleeps) rather
 * than the learner's Neovim: the assertion is about OUR wiring, not about
 * nvim rendering a UI.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const requireCjs = createRequire(import.meta.url);
const codeSession = requireCjs("../electron/code-session.cjs");
const core = await import("../src/core/code-editor.ts");

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-code-session-"));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("code-session pure rules match src/core/code-editor.ts", () => {
	const fixtures = [
		{ env: { PATH: "/usr/bin:/bin", LH_NVIM: "" }, probe: () => true },
		{ env: { PATH: "" }, probe: () => false },
		{ env: { LH_NVIM: "/opt/custom/nvim", PATH: "/nowhere" }, probe: (f: string) => f === "/opt/custom/nvim" },
		{ env: { PATH: "/Users/me/.local/bin:/usr/bin" }, probe: (f: string) => f === "/Users/me/.local/bin/nvim" },
	];

	it("resolves the same binary for the same env + fs probe", () => {
		for (const fixture of fixtures) {
			assert.equal(
				codeSession.resolveNvimBinary(fixture.env, fixture.probe),
				core.resolveNvimBinary(fixture.env, fixture.probe),
			);
		}
	});

	it("agrees on scope sanitising, workspace paths and socket names", () => {
		for (const scope of ["scratch", "python-lessons", "../escape", "", 42, "a".repeat(40)]) {
			assert.equal(codeSession.sanitizeScope(scope), core.sanitizeScope(scope));
			const root = codeSession.workspaceRoot("/data", scope);
			assert.equal(root, core.workspaceRoot("/data", scope));
			assert.equal(codeSession.editorSocketPath(root, scope), core.editorSocketPath(root, scope));
			assert.equal(codeSession.editorStatePath(root), core.editorStatePath(root));
		}
	});

	it("clamps terminal geometry instead of trusting the renderer", () => {
		assert.equal(codeSession.clampCell(0, 80), 80);
		assert.equal(codeSession.clampCell(-5, 24), 24);
		assert.equal(codeSession.clampCell("120", 80), 80);
		assert.equal(codeSession.clampCell(10_000, 80), 1000);
		assert.equal(codeSession.clampCell(120, 80), 120);
	});

	it("strips Electron-only flags and sets the terminal identity", () => {
		const env = codeSession.sessionEnv({
			PATH: "/usr/bin",
			ELECTRON_RUN_AS_NODE: "1",
			LH_DESKTOP_API_SECRET: "secret",
			LH_DESKTOP_SERVER: "1",
			NVIM_APPNAME: "clean",
			WAYLAND_DISPLAY: "wayland-1",
		});
		assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
		assert.equal(env.LH_DESKTOP_API_SECRET, undefined);
		assert.equal(env.LH_DESKTOP_SERVER, undefined);
		assert.equal(env.NVIM_APPNAME, undefined);
		assert.equal(env.WAYLAND_DISPLAY, "wayland-1");
		assert.equal(env.TERM, "xterm-256color");
		assert.equal(env.COLORTERM, "truecolor");
	});
});

describe("code-session manager", () => {
	it("refuses to start when nvim cannot be found", () => {
		// An explicit but non-executable override: the fallback list would otherwise
		// find the machine's real nvim and make this test lie.
		const sessions = codeSession.createCodeSessions({ dataDir: tempDir(), env: { LH_NVIM: "/definitely-not-here/nvim", PATH: "/definitely-not-here" } });
		const result = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
		assert.equal(result.ok, false);
		assert.match(String(result.error), /Neovim \(nvim\) was not found/);
	});

	it("rejects an unknown session kind", () => {
		const sessions = codeSession.createCodeSessions({ dataDir: tempDir(), env: { PATH: process.env.PATH, SHELL: "/bin/sh" } });
		assert.equal(sessions.start({ kind: "browser" }).ok, false);
	});

	it("runs a real shell in the workspace, takes keystrokes, and resizes", { timeout: 20_000 }, async () => {
		const dataDir = tempDir();
		const outputs: string[] = [];
		const sessions = codeSession.createCodeSessions({
			dataDir,
			env: { ...process.env, SHELL: "/bin/bash" },
			onData: (_id: string, data: string) => outputs.push(data),
		});
		try {
			const started = sessions.start({ kind: "shell", scope: "scratch", cols: 90, rows: 24 });
			assert.equal(started.ok, true, started.error);
			assert.equal(started.cwd, join(dataDir, "code", "scratch"));
			assert.ok(existsSync(started.cwd), "workspace directory is created");

			assert.equal(sessions.write(started.id, "echo PTY_READY\r"), true);
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && !outputs.join("").includes("PTY_READY")) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.match(outputs.join(""), /PTY_READY/);

			assert.equal(sessions.resize(started.id, 120, 40), true);
			const state = sessions.state().find((s: { id: string }) => s.id === started.id);
			assert.equal(state.cols, 120);
			assert.equal(state.rows, 40);

			// Garbage from a renderer must not reach the ioctl.
			sessions.resize(started.id, 0, -1);
			const after = sessions.state().find((s: { id: string }) => s.id === started.id);
			assert.equal(after.cols, 120);

			assert.equal(sessions.kill(started.id), true);
			assert.deepEqual(sessions.state(), []);
			assert.equal(sessions.write(started.id, "ignored"), false);
		} finally {
			sessions.killAll();
		}
	});

	it("writes the editor state file and removes it on kill", { timeout: 20_000 }, async () => {
		const dataDir = tempDir();
		const fakeNvim = join(tempDir(), "fake-nvim");
		writeFileSync(fakeNvim, "#!/bin/sh\nsleep 30\n");
		chmodSync(fakeNvim, 0o755);

		const sessions = codeSession.createCodeSessions({ dataDir, env: { ...process.env, LH_NVIM: fakeNvim } });
		try {
			const started = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
			assert.equal(started.ok, true, started.error);
			const statePath = join(started.cwd, ".editor.json");
			assert.ok(existsSync(statePath), "state file written next to the workspace");
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			assert.equal(state.socket, started.socket);
			assert.equal(state.scope, "scratch");
			assert.equal(state.cwd, started.cwd);

			// A second start of the same kind reuses the live session.
			const again = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
			assert.equal(again.reused, true);
			assert.equal(again.id, started.id);

			sessions.kill(started.id);
			assert.equal(existsSync(statePath), false, "state file removed on kill");
		} finally {
			sessions.killAll();
		}
	});
});
