/**
 * Review round 2 pins (docs/coding-pane/review-2.md): N1 (a remounted renderer
 * must be repainted from the pty host's tail buffer), F2 (the parity test must
 * compare the PRODUCTION data-dir pair, not two mirrors) and F3 (the two env
 * sanitisers must strip the same set, not a hardcoded list of names).
 *
 * Kept in their own file because the session gate refuses edits to existing
 * test files; same runner and helper shape as tests/code-session-regressions.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const requireCjs = createRequire(import.meta.url);
const codeSession = requireCjs("../electron/code-session.cjs");
const core = await import("../src/core/code-editor.ts");

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TSX_LOADER = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lh-review2-"));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

type FakeProc = {
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

/** A pty stand-in that records the SENDER's side effects in one ordered log, so
 *  "replay happened before the repaint-triggering resize" is assertable. */
function harness(dataDir: string) {
	const procs: FakeProc[] = [];
	const log: Array<{ type: "data" | "resize"; id: string; value: string | [number, number] }> = [];
	const spawnPty = () => {
		const proc: FakeProc = {
			resizes: [],
			killed: false,
			pid: 5000 + procs.length,
			onData: (cb) => {
				proc.onDataCb = cb;
			},
			onExit: (cb) => {
				proc.onExitCb = cb;
			},
			write: () => {},
			resize: (cols, rows) => {
				proc.resizes.push([cols, rows]);
				log.push({ type: "resize", id: `p${proc.pid}`, value: [cols, rows] });
			},
			kill: () => {
				proc.killed = true;
			},
		};
		procs.push(proc);
		return proc;
	};
	const sessions = codeSession.createCodeSessions({
		dataDir,
		env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
		spawnPty,
		onData: (id: string, data: string) => log.push({ type: "data", id, value: data }),
	});
	return {
		sessions: sessions as {
			start(input: { kind: string; scope?: string; cols?: number; rows?: number }): {
				ok: boolean; id: string; reused?: boolean; replayed?: number; error?: string;
			};
			kill(id: string): boolean;
			write(id: string, data: string): boolean;
			killAll(): void;
			state(): Array<{ id: string }>;
		},
		procs,
		log,
		announce(index: number, data: string) {
			procs[index]!.onDataCb!(data);
		},
		drain() {
			const out = [...log];
			log.length = 0;
			return out;
		},
	};
}

const EDITOR = { kind: "editor", scope: "scratch", cols: 80, rows: 24 } as const;

describe("N1 — a remounted renderer is repainted from the tail buffer", () => {
	it("replays the buffered screen exactly once, in order, on the reuse path", () => {
		const h = harness(tempDir());
		const first = h.sessions.start(EDITOR);
		assert.equal(first.ok, true);
		assert.deepEqual(h.drain(), [], "a fresh spawn replays nothing (there is no screen yet)");

		h.announce(0, "ALPHA");
		h.announce(0, "BETA");
		assert.deepEqual(h.drain(), [
			{ type: "data", id: "editor:scratch", value: "ALPHA" },
			{ type: "data", id: "editor:scratch", value: "BETA" },
		], "live output is delivered once, as it arrives");

		const again = h.sessions.start(EDITOR);
		assert.equal(again.reused, true);
		assert.equal(again.replayed, 9, "the whole buffered screen is announced as replayed");
		assert.deepEqual(h.drain(), [{ type: "data", id: "editor:scratch", value: "ALPHABETA" }], "exactly one replay, in order, never duplicated per chunk");
		h.sessions.killAll();
	});

	it("replays BEFORE the resize that makes nvim repaint", () => {
		const h = harness(tempDir());
		h.sessions.start(EDITOR);
		h.announce(0, "OLD-SCREEN");
		h.drain();
		h.sessions.start({ ...EDITOR, cols: 132, rows: 44 });
		assert.deepEqual(h.drain(), [
			{ type: "data", id: "editor:scratch", value: "OLD-SCREEN" },
			{ type: "resize", id: "p5000", value: [132, 44] },
		], "the restored screen lands before repaint bytes, so nothing is drawn twice out of order");
		h.sessions.killAll();
	});

	it("a fresh session after kill carries no stale screen", () => {
		const h = harness(tempDir());
		const first = h.sessions.start(EDITOR);
		h.announce(0, "GONE");
		h.sessions.kill(first.id);
		h.procs[0]!.onExitCb!({ exitCode: 0 });
		h.drain();

		const next = h.sessions.start(EDITOR);
		assert.equal(next.ok, true);
		assert.equal(next.replayed, undefined, "a new pty has an empty buffer");
		assert.deepEqual(h.drain(), [], "no bytes from the killed session reach the new one");
		assert.equal(h.sessions.state().length, 1);
		h.sessions.killAll();
	});

	it("keeps the replays scoped: one scope never replays another's screen", () => {
		const h = harness(tempDir());
		h.sessions.start({ kind: "editor", scope: "one", cols: 80, rows: 24 });
		h.sessions.start({ kind: "editor", scope: "two", cols: 80, rows: 24 });
		h.announce(0, "SCOPE-ONE");
		h.announce(1, "SCOPE-TWO");
		h.drain();

		h.sessions.start({ kind: "editor", scope: "one", cols: 80, rows: 24 });
		assert.deepEqual(h.drain(), [{ type: "data", id: "editor:one", value: "SCOPE-ONE" }], "only the requested scope is repainted");
		h.sessions.killAll();
	});

	it("bounds the buffer at the newest OUTPUT_BUFFER_CHARS and never cuts a surrogate pair", () => {
		const cap: number = codeSession.OUTPUT_BUFFER_CHARS;
		assert.equal(typeof cap, "number");
		assert.ok(cap > 0 && cap <= 65536 * 4, "the buffer is capped, not unbounded");

		const h = harness(tempDir());
		h.sessions.start(EDITOR);
		h.announce(0, "a".repeat(cap));
		h.announce(0, "TAIL");
		h.drain();
		h.sessions.start(EDITOR);
		const replay = h.drain()[0]!.value as string;
		assert.equal(replay.length, cap, "the buffer never grows past the cap");
		assert.ok(replay.endsWith("TAIL"), "the NEWEST bytes survive; the oldest are dropped");
		h.sessions.killAll();

		// The cut must not leave a lone half of a surrogate pair at the start.
		const buffer = codeSession.appendBounded("x", "😀".repeat(4), 5);
		assert.equal(buffer.length <= 5, true);
		assert.ok(!/^[\uDC00-\uDFFF]/.test(buffer), "a bounded tail never starts mid-pair");
	});
});

describe("F2 — the parity pin compares the production data-dir pair", () => {
	function agentDataDir(env: Record<string, string>): string {
		const out = execFileSync(
			process.execPath,
			["--import", TSX_LOADER, "--eval", `const m = await import(${JSON.stringify(join(REPO_ROOT, "config.ts"))}); console.log(JSON.stringify({ data: m.PATHS.data }));`],
			{ cwd: REPO_ROOT, encoding: "utf-8", env: { ...process.env, ...env } },
		);
		return (JSON.parse(out) as { data: string }).data;
	}

	it("the desktop:dev relative form resolves to the SAME root for the agent and the pty host", () => {
		const agent = agentDataDir({ LH_DATA_DIR: "./data" });
		const host = codeSession.resolveDataDir({ LH_DATA_DIR: "./data" }, "/home/me/.config/LearnHarness");
		assert.equal(agent, host, "one root: config.ts (the agent) and the CJS resolver (the pty host)");
		assert.equal(agent, join(REPO_ROOT, "data"), "LH_DATA_DIR=./data is repo-relative for both");
	});

	it("an absolute LH_DATA_DIR resolves identically on both sides", () => {
		const dir = tempDir();
		const agent = agentDataDir({ LH_DATA_DIR: dir });
		const host = codeSession.resolveDataDir({ LH_DATA_DIR: dir }, "/home/me/.config/LearnHarness");
		assert.equal(agent, host);
		assert.equal(agent, dir);
	});

	it("unset is the only mode where the two roots differ BY DESIGN, and desktop:dev never uses it", () => {
		const agent = agentDataDir({ LH_DATA_DIR: "" });
		assert.equal(agent, join(REPO_ROOT, "data"), "the headless server keeps its repo-data fallback");
		assert.equal(
			codeSession.resolveDataDir({}, "/home/me/.config/LearnHarness"),
			join("/home/me/.config/LearnHarness", "data"),
			"the shell keeps its userData fallback",
		);
		const pkg = JSON.parse(
			execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync('package.json','utf8'))"], { cwd: REPO_ROOT, encoding: "utf-8" }),
		) as { scripts: Record<string, string> };
		assert.match(pkg.scripts["desktop:dev"] ?? "", /LH_DATA_DIR=/, "the script pins the root, so the differing fallbacks never meet");
	});
});

describe("F3 — both env sanitisers strip the same SET, not a remembered list", () => {
	const fixture = {
		PATH: "/usr/bin:/bin",
		SHELL: "/bin/sh",
		WAYLAND_DISPLAY: "wayland-1",
		TERM: "xterm-256color",
		ELECTRON_RUN_AS_NODE: "1",
		LH_DESKTOP_API_SECRET: "secret",
		LH_DESKTOP_SERVER: "1",
		NVIM_APPNAME: "custom",
	};

	function strippedBy(sanitise: (env: Record<string, string>) => Record<string, string | undefined>): string[] {
		const out = sanitise({ ...fixture });
		return Object.keys(fixture).filter((key) => out[key] === undefined).sort();
	}

	it("the pty host and the nvim client drop exactly the same variables", () => {
		const host = strippedBy((env) => codeSession.sessionEnv(env) as Record<string, string | undefined>);
		const client = strippedBy((env) => core.editorClientEnv(env));
		assert.deepEqual(host, client, "a future secret added to one sanitiser must fail this pin");
		assert.deepEqual(client, ["ELECTRON_RUN_AS_NODE", "LH_DESKTOP_API_SECRET", "LH_DESKTOP_SERVER", "NVIM_APPNAME"]);
	});

	it("neither side drops the learner's session identity", () => {
		for (const env of [codeSession.sessionEnv({ ...fixture }) as Record<string, string>, core.editorClientEnv({ ...fixture }) as Record<string, string>]) {
			assert.equal(env.WAYLAND_DISPLAY, "wayland-1");
			assert.equal(env.PATH, "/usr/bin:/bin");
			assert.equal(env.SHELL, "/bin/sh");
		}
	});
});
