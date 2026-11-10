/**
 * Coding workspace PTY host (Electron main only).
 *
 * One record per PTY, keyed `<kind>:<scope>`:
 *   { id, kind, scope, cwd, pid, socket, proc, exited, cols, rows }
 * Plus one file record per workspace (`.editor.json`) that tells the AGENT
 * which nvim socket is live, so `open_in_editor` can reach the running editor.
 *
 * Deliberate constraints:
 *   - the binary is never supplied by the renderer (env `LH_NVIM`, PATH, then
 *     a fixed fallback list — resolved by resolveNvimBinary);
 *   - the child inherits the learner's environment, so `nvim` reads the real
 *     `~/.config/nvim` (LazyVim) and `wl-copy` works on Wayland. No
 *     `NVIM_APPNAME`, no sandbox config;
 *   - the mirror below duplicates `src/core/code-editor.ts` because this shell
 *     is CommonJS and the app is ESM-only; tests/code-session.test.ts asserts
 *     both copies agree.
 */

const fsDefault = require("node:fs");
const path = require("node:path");

const WORKSPACE_SCOPE = "scratch";
const WORKSPACE_DIR = "code";
const EDITOR_STATE_FILE = ".editor.json";
const NVIM_FALLBACK_PATHS = ["/usr/bin/nvim", "/usr/sbin/nvim", "/usr/local/bin/nvim", "/opt/homebrew/bin/nvim"];
const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_WRITE_CHARS = 65536;
/** Last N characters of pty output, kept per session so a remounted renderer (a
 *  reload keeps the pty alive but builds a fresh xterm) can be repainted
 *  instead of sitting blank until the next keystroke. */
const OUTPUT_BUFFER_CHARS = 65536;

/** Append to a bounded tail buffer, dropping the oldest characters. The cut
 *  never lands between a surrogate pair (a lone half is not a character). */
function appendBounded(buffer, chunk, cap) {
	const next = buffer + chunk;
	if (next.length <= cap) return next;
	let start = next.length - cap;
	const code = next.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return next.slice(start);
}

function sanitizeScope(value) {
	return typeof value === "string" && SCOPE_PATTERN.test(value) ? value : WORKSPACE_SCOPE;
}

/** The app's data dir: an explicit `LH_DATA_DIR` wins (the dev shell exports it
 *  so the `next dev` server and this process agree on ONE root), otherwise the
 *  Electron userData path. Mirrored in src/core/code-editor.ts. */
function resolveDataDir(env, userDataDir) {
	const explicit = typeof env.LH_DATA_DIR === "string" ? env.LH_DATA_DIR.trim() : "";
	return explicit ? path.resolve(explicit) : path.join(userDataDir, "data");
}

function workspaceRoot(dataDir, scope) {
	return path.join(dataDir, WORKSPACE_DIR, sanitizeScope(scope));
}

function editorSocketPath(root, scope) {
	return path.join(root, `.nvim-${sanitizeScope(scope)}.sock`);
}

function editorStatePath(root) {
	return path.join(root, EDITOR_STATE_FILE);
}

function resolveNvimBinary(env, isExecutable) {
	const override = typeof env.LH_NVIM === "string" ? env.LH_NVIM.trim() : "";
	if (override) return isExecutable(override) ? override : null;
	for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "nvim");
		if (isExecutable(candidate)) return candidate;
	}
	for (const candidate of NVIM_FALLBACK_PATHS) if (isExecutable(candidate)) return candidate;
	return null;
}

function clampCell(value, fallback, max = 1000) {
	const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
	if (!Number.isFinite(n) || n < 2) return fallback;
	return Math.min(n, max);
}

/** The learner's own environment, minus the flags that only mean something to
 *  an Electron helper process, plus the terminal identity nvim/plugins read. */
function sessionEnv(env) {
	const out = { ...env };
	delete out.ELECTRON_RUN_AS_NODE;
	delete out.LH_DESKTOP_API_SECRET;
	delete out.LH_DESKTOP_SERVER;
	delete out.NVIM_APPNAME;
	if (!out.PATH) out.PATH = "/usr/local/bin:/usr/bin:/usr/sbin:/bin";
	out.TERM = "xterm-256color";
	out.COLORTERM = "truecolor";
	return out;
}

function shellBinary(env) {
	const shell = typeof env.SHELL === "string" ? env.SHELL.trim() : "";
	return shell.startsWith("/") ? shell : "/bin/sh";
}

/**
 * @param {object} options
 * @param {string} options.dataDir            app data dir (LH_DATA_DIR)
 * @param {NodeJS.ProcessEnv} [options.env]   environment handed to the PTYs
 * @param {Function} [options.spawnPty]       node-pty's spawn (injectable for tests)
 * @param {typeof fsDefault} [options.fsModule]
 * @param {(id: string, data: string) => void} [options.onData]
 * @param {(id: string, exitCode: number) => void} [options.onExit]
 */
function createCodeSessions({ dataDir, env = process.env, spawnPty, fsModule = fsDefault, onData = () => {}, onExit = () => {}, log = () => {} } = {}) {
	if (typeof dataDir !== "string" || !dataDir) throw new Error("code-session: dataDir is required");
	const spawn = spawnPty ?? require("node-pty").spawn;
	const sessions = new Map();
	const constants = fsModule.constants ?? fsDefault.constants;

	function isExecutable(file) {
		try {
			fsModule.accessSync(file, constants.X_OK);
			return fsModule.statSync(file).isFile();
		} catch {
			return false;
		}
	}

	function clearState(root, socket) {
		try {
			const file = editorStatePath(root);
			const raw = fsModule.readFileSync(file, "utf8");
			const state = JSON.parse(raw);
			if (socket && state && state.socket && state.socket !== socket) return;
		} catch {
			// No state file: nothing to clear.
		}
		try {
			fsModule.rmSync(editorStatePath(root), { force: true });
		} catch {
			// best effort
		}
	}

	function dispose(session) {
		session.exited = true;
		try {
			session.proc.kill();
		} catch {
			// already gone
		}
		if (session.socket) {
			try {
				fsModule.rmSync(session.socket, { force: true });
			} catch {
				// best effort
			}
			clearState(session.cwd, session.socket);
		}
	}

	function start({ kind, scope, cols, rows } = {}) {
		if (kind !== "editor" && kind !== "shell") return { ok: false, error: "Unknown coding session kind." };
		const safeScope = sanitizeScope(scope);
		const root = workspaceRoot(dataDir, safeScope);
		const id = `${kind}:${safeScope}`;
		const existing = sessions.get(id);
		if (existing && !existing.exited) {
			// Replay BEFORE resize: a resize makes nvim repaint, and those bytes must
			// land after the restored screen, never before it.
			if (existing.buffer) onData(id, existing.buffer);
			// A remount may bring different geometry (the window was resized while the
			// editor stayed alive, or a fresh xterm never re-sends its size).
			resize(id, cols, rows);
			return { ok: true, id, kind, scope: safeScope, cwd: root, socket: existing.socket, reused: true, replayed: existing.buffer.length };
		}

		let file;
		let args;
		let socket = null;
		if (kind === "editor") {
			const nvim = resolveNvimBinary(env, isExecutable);
			if (!nvim) {
				return {
					ok: false,
					error: "Neovim (nvim) was not found. Install it, or set LH_NVIM to its absolute path, then reopen the editor.",
				};
			}
			socket = editorSocketPath(root, safeScope);
			file = nvim;
			args = ["--listen", socket];
		} else {
			file = shellBinary(env);
			args = ["-l"];
		}

		try {
			fsModule.mkdirSync(root, { recursive: true, mode: 0o700 });
			if (socket) fsModule.rmSync(socket, { force: true });
		} catch (error) {
			return { ok: false, error: `Could not prepare the coding workspace: ${error.message}` };
		}

		const size = { cols: clampCell(cols, 80), rows: clampCell(rows, 24) };
		let proc;
		try {
			proc = spawn(file, args, { name: "xterm-256color", cwd: root, env: sessionEnv(env), cols: size.cols, rows: size.rows });
		} catch (error) {
			return { ok: false, error: `Could not start ${kind === "editor" ? "Neovim" : "the shell"}: ${error.message}` };
		}

		const session = { id, kind, scope: safeScope, cwd: root, socket, proc, exited: false, cols: size.cols, rows: size.rows, pid: proc.pid, buffer: "" };
		sessions.set(id, session);

		proc.onData((data) => {
			if (session.exited) return;
			session.buffer = appendBounded(session.buffer, data, OUTPUT_BUFFER_CHARS);
			onData(id, data);
		});
		proc.onExit(({ exitCode }) => {
			session.exited = true;
			// Identity guard (2026-11-11): killing a pty and starting another with the
			// same id is normal (a remount), and the old child's exit lands up to a
			// second later. Only the session that still OWNS the registry entry may
			// clean up the shared socket + state file; a stale exit must never delete
			// the live one, which would leave the new pty unwritable, unreachable by
			// the agent, and invisible to killAll.
			if (sessions.get(id) !== session) return;
			if (session.socket) {
				try {
					fsModule.rmSync(session.socket, { force: true });
				} catch {
					// best effort
				}
				clearState(root, session.socket);
			}
			sessions.delete(id);
			onExit(id, exitCode ?? 0);
		});

		if (socket) {
			try {
				fsModule.writeFileSync(
					editorStatePath(root),
					`${JSON.stringify({ socket, pid: proc.pid ?? null, scope: safeScope, cwd: root, startedAt: Date.now() }, null, 2)}\n`,
					{ mode: 0o600 },
				);
			} catch (error) {
				log(`code-session: could not write ${EDITOR_STATE_FILE}: ${error.message}`);
			}
		}

		log(`code-session: started ${id} (${path.basename(file)}) in ${root}`);
		return { ok: true, id, kind, scope: safeScope, cwd: root, socket };
	}

	function write(id, data) {
		const session = sessions.get(id);
		if (!session || session.exited) return false;
		if (typeof data !== "string" || data.length === 0) return false;
		try {
			// Deliver the WHOLE payload in capped chunks: truncating a large bracketed
			// paste silently dropped its tail. A split never lands inside a surrogate
			// pair (that would emit a lone half to the terminal).
			for (let index = 0; index < data.length; ) {
				let end = Math.min(index + MAX_WRITE_CHARS, data.length);
				if (end < data.length) {
					const code = data.charCodeAt(end - 1);
					if (code >= 0xd800 && code <= 0xdbff) end -= 1;
				}
				session.proc.write(data.slice(index, end));
				index = end;
			}
			return true;
		} catch {
			return false;
		}
	}

	function resize(id, cols, rows) {
		const session = sessions.get(id);
		if (!session || session.exited) return false;
		const next = { cols: clampCell(cols, session.cols), rows: clampCell(rows, session.rows) };
		if (next.cols === session.cols && next.rows === session.rows) return true;
		try {
			session.proc.resize(next.cols, next.rows);
			session.cols = next.cols;
			session.rows = next.rows;
			return true;
		} catch {
			return false;
		}
	}

	function kill(id) {
		const session = sessions.get(id);
		if (!session) return false;
		dispose(session);
		sessions.delete(id);
		return true;
	}

	function killAll() {
		for (const session of [...sessions.values()]) dispose(session);
		sessions.clear();
	}

	function state() {
		return [...sessions.values()].map(({ id, kind, scope, cwd, socket, pid, cols, rows }) => ({ id, kind, scope, cwd, socket, pid, cols, rows }));
	}

	return { start, write, resize, kill, killAll, state };
}

module.exports = {
	WORKSPACE_SCOPE,
	WORKSPACE_DIR,
	EDITOR_STATE_FILE,
	NVIM_FALLBACK_PATHS,
	MAX_WRITE_CHARS,
	OUTPUT_BUFFER_CHARS,
	appendBounded,
	sanitizeScope,
	resolveDataDir,
	workspaceRoot,
	editorSocketPath,
	editorStatePath,
	resolveNvimBinary,
	clampCell,
	sessionEnv,
	shellBinary,
	createCodeSessions,
};
