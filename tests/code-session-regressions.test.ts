/**
 * Regression pins for the 2026-11-11 review round 1 (docs/coding-pane/review-1-*.md).
 *
 * Why this file exists instead of additions to tests/code-session.test.ts: the
 * session gate refuses edits to an existing test file ("evidence you do not
 * own"), so the new pins land beside it. Same helper shape, same runner.
 *
 * Each test below fails on the pre-fix code and is named for the defect it
 * pins, not for the function it calls.
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
	const dir = mkdtempSync(join(tmpdir(), "lh-code-regress-"));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

type FakeProc = {
	writes: string[];
	resizes: Array<[number, number]>;
	killed: boolean;
	pid: number;
	onDataCb?: (data: string) => void;
	onExitCb?: (event: { exitCode: number }) => void;
	onData: (cb: (data: string) => void) => void;
	onExit: (cb: (event: { exitCode: number }) => void) => void;
	write: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	kill: () => void;
};

/** A pty stand-in with the surface the manager uses, plus exit handles. */
function fakePty(): { spawn: () => FakeProc; procs: FakeProc[] } {
	const procs: FakeProc[] = [];
	const spawn = () => {
		const proc: FakeProc = {
			writes: [],
			resizes: [],
			killed: false,
			pid: 4000 + procs.length,
			onData: (cb) => {
				proc.onDataCb = cb;
			},
			onExit: (cb) => {
				proc.onExitCb = cb;
			},
			write: (data) => {
				proc.writes.push(data);
			},
			resize: (cols, rows) => {
				proc.resizes.push([cols, rows]);
			},
			kill: () => {
				proc.killed = true;
			},
		};
		procs.push(proc);
		return proc;
	};
	return { spawn, procs };
}

const fakeEnv = { PATH: "/usr/bin:/bin", LH_NVIM: "/bin/sh", SHELL: "/bin/sh" };

describe("PTY session lifecycle regressions", () => {
	it("a stale pty exit never deletes the session that replaced it", () => {
		const dataDir = tempDir();
		const fake = fakePty();
		const sessions = codeSession.createCodeSessions({ dataDir, env: fakeEnv, spawnPty: fake.spawn });

		const first = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
		assert.equal(first.ok, true, first.error);
		const procA = fake.procs[0]!;

		// The remount: kill the old editor, start a new one with the same id.
		sessions.kill(first.id);
		const second = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
		assert.equal(second.ok, true, second.error);
		const procB = fake.procs[1]!;

		// The first child's exit lands late (measured: ~1 s for a real nvim).
		procA.onExitCb?.({ exitCode: 0 });

		assert.deepEqual(sessions.state().map((s: { id: string }) => s.id), [second.id], "the live session survives a stale exit");
		assert.ok(existsSync(join(second.cwd, ".editor.json")), "its state file survives too");
		assert.equal(sessions.write(second.id, "i"), true, "and it stays writable");
		assert.deepEqual(procB.writes, ["i"], "keystrokes reach the live pty, not a dead one");

		sessions.killAll();
		assert.equal(procB.killed, true, "killAll still reaches it (no orphan nvim on quit)");
	});

	it("reusing a live session applies the geometry the new pane measured", () => {
		const dataDir = tempDir();
		const fake = fakePty();
		const sessions = codeSession.createCodeSessions({ dataDir, env: fakeEnv, spawnPty: fake.spawn });

		const first = sessions.start({ kind: "editor", scope: "scratch", cols: 80, rows: 24 });
		assert.equal(first.ok, true, first.error);
		const again = sessions.start({ kind: "editor", scope: "scratch", cols: 120, rows: 40 });
		assert.equal(again.reused, true);
		assert.deepEqual(fake.procs[0]!.resizes.at(-1), [120, 40], "the reused pty is resized, not left at its old size");

		sessions.killAll();
	});

	it("delivers a large paste in capped chunks, without dropping or splitting a surrogate pair", () => {
		const dataDir = tempDir();
		const fake = fakePty();
		const sessions = codeSession.createCodeSessions({ dataDir, env: fakeEnv, spawnPty: fake.spawn });
		const started = sessions.start({ kind: "shell", scope: "scratch", cols: 80, rows: 24 });
		assert.equal(started.ok, true, started.error);

		const cap = codeSession.MAX_WRITE_CHARS;
		assert.ok(typeof cap === "number" && cap > 0, "the cap is exported (one value, mirrored in src/core/code-editor.ts)");

		// The naive split lands exactly between the two halves of the emoji.
		const payload = "x".repeat(cap - 1) + "😀" + "y".repeat(200);
		assert.equal(sessions.write(started.id, payload), true);
		const chunks = fake.procs[0]!.writes;
		assert.ok(chunks.length > 1, "the payload is chunked");
		assert.equal(chunks.join(""), payload, "every code unit of the paste arrives, in order");
		for (const chunk of chunks) {
			assert.ok(chunk.length <= cap, "no chunk exceeds the cap");
			assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), "a chunk never starts mid-pair");
			assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "a chunk never ends mid-pair");
		}

		sessions.killAll();
	});
});

describe("workspace rules mirrored by both implementations", () => {
	it("clamps geometry the same way in the CJS shell and in src/core", () => {
		const fixtures: Array<[unknown, number]> = [[0, 80], [-5, 24], ["120", 80], [10_000, 80], [120, 80], [NaN, 80], [2, 80], [1000, 80]];
		for (const [value, fallback] of fixtures) {
			assert.equal(codeSession.clampCell(value, fallback), core.clampCell(value, fallback), `clampCell(${String(value)})`);
		}
		assert.equal(codeSession.clampCell(5_000, 80, 400), core.clampCell(5_000, 80, 400), "the explicit cap argument is mirrored too");
		assert.equal(codeSession.MAX_WRITE_CHARS, core.MAX_WRITE_CHARS, "one write cap, mirrored");
	});

	it("resolves the app data dir the same way in both implementations", () => {
		assert.equal(typeof core.resolveDataDir, "function", "src/core exposes the shared rule");
		assert.equal(typeof codeSession.resolveDataDir, "function", "the CJS shell exposes the shared rule");
		for (const env of [{ LH_DATA_DIR: "/tmp/lh-data" }, { LH_DATA_DIR: "  " }, {}] as Array<Record<string, string>>) {
			assert.equal(
				codeSession.resolveDataDir(env, "/home/me/.config/LearnHarness"),
				core.resolveDataDir(env, "/home/me/.config/LearnHarness"),
				`same root for ${JSON.stringify(env)}`,
			);
		}
	});

	it("the dev shell exports LH_DATA_DIR for BOTH children, so the server and the pty host agree", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
		assert.match(pkg.scripts["desktop:dev"] ?? "", /LH_DATA_DIR=/, "desktop:dev must pin the root the agent reads");
	});

	it("the dev nvim client receives the same sanitised env the pty host builds", () => {
		const env = core.editorClientEnv({ PATH: "/usr/bin", LH_DESKTOP_API_SECRET: "secret", LH_DESKTOP_SERVER: "1", ELECTRON_RUN_AS_NODE: "1", WAYLAND_DISPLAY: "wayland-1" });
		assert.equal(env.LH_DESKTOP_API_SECRET, undefined);
		assert.equal(env.LH_DESKTOP_SERVER, undefined);
		assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
		assert.equal(env.WAYLAND_DISPLAY, "wayland-1", "everything else is inherited");
	});
});

describe("packaging keeps the native addon and drops the debug symbols", () => {
	const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

	it("ships node-pty and unpacks its .node", () => {
		assert.match(builder, /- node_modules\/node-pty\/\*\*\/\*/);
		assert.match(builder, /asarUnpack:\n(\s+- .*\n)*?\s+- node_modules\/node-pty/);
	});

	it("does not carry 53 MB of Windows .pdb symbols into every install", () => {
		assert.match(builder, /!node_modules\/node-pty\/prebuilds\/\*\*\/\*\.pdb/, "the pdb glob is excluded");
	});

	it("does not ship header-only build dependencies", () => {
		assert.ok(!/- node_modules\/node-addon-api/.test(builder), "node-addon-api is build-time only");
	});
});
