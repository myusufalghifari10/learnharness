import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Coding-workspace rules shared by the Electron PTY host and the agent's
 * `open_in_editor` tool.
 *
 * Why this module exists: the workspace is the ONE place where the learner's
 * Neovim and the agent meet, so the directory shape, the scope sanitiser and
 * the binary resolution must have a single spelling. `electron/code-session.cjs`
 * cannot import this file (the shell is CommonJS, this repo is ESM-only), so it
 * carries a deliberate mirror of these constants; `tests/code-session.test.ts`
 * pins both copies to the same answers on the same fixtures.
 *
 * Pure on purpose: no fs, no env reads at import time — the callers inject
 * `env` and an executable probe.
 */

/** The one workspace scope the v1 UI opens. Scope ids are path segments, so
 *  anything outside this pattern falls back instead of escaping the root. */
export const WORKSPACE_SCOPE = "scratch";

/** Root of every coding workspace, under the app's data dir. */
export const WORKSPACE_DIR = "code";

/** Written by the PTY host next to the workspace, read by the agent tool. */
export const EDITOR_STATE_FILE = ".editor.json";

/** Widest single `proc.write` the PTY host issues; a larger paste is chunked,
 *  never truncated. Mirrored in electron/code-session.cjs. */
export const MAX_WRITE_CHARS = 65536;

const SCOPE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function sanitizeScope(value: unknown): string {
	return typeof value === "string" && SCOPE_PATTERN.test(value) ? value : WORKSPACE_SCOPE;
}

/** `<data dir>/code/<scope>` — the cwd of both PTYs. */
export function workspaceRoot(dataDir: string, scope: unknown): string {
	return path.join(dataDir, WORKSPACE_DIR, sanitizeScope(scope));
}

/** The `nvim --listen` socket, inside the workspace so it is discoverable. */
export function editorSocketPath(root: string, scope: unknown): string {
	return path.join(root, `.nvim-${sanitizeScope(scope)}.sock`);
}

export function editorStatePath(root: string): string {
	return path.join(root, EDITOR_STATE_FILE);
}

/** Last-resort locations when PATH is missing or stripped (a GUI-launched
 *  Electron app may not inherit the shell's PATH at all). */
export const NVIM_FALLBACK_PATHS: readonly string[] = [
	"/usr/bin/nvim",
	"/usr/sbin/nvim",
	"/usr/local/bin/nvim",
	"/opt/homebrew/bin/nvim",
];

export type ExecutableProbe = (file: string) => boolean;

/**
 * `LH_NVIM` wins (explicit user intent, also how a test pins a fake binary),
 * then PATH, then the fallback list. Returns null when nothing is executable:
 * the caller surfaces that as an honest "Neovim was not found" error instead
 * of spawning something else.
 */
export function resolveNvimBinary(env: Record<string, string | undefined>, isExecutable: ExecutableProbe): string | null {
	const override = env.LH_NVIM?.trim();
	if (override) return isExecutable(override) ? override : null;
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "nvim");
		if (isExecutable(candidate)) return candidate;
	}
	for (const candidate of NVIM_FALLBACK_PATHS) if (isExecutable(candidate)) return candidate;
	return null;
}

/** The app's data dir. `LH_DATA_DIR` wins so the `next dev` server and the
 *  Electron shell can be pinned to ONE root (`npm run desktop:dev` exports it);
 *  otherwise `<userData>/data`. Mirrored in electron/code-session.cjs. */
export function resolveDataDir(env: Record<string, string | undefined>, userDataDir: string): string {
	const explicit = env.LH_DATA_DIR?.trim();
	return explicit ? path.resolve(explicit) : path.join(userDataDir, "data");
}

/** Environment handed to a spawned nvim CLIENT (the `--remote` call): the
 *  learner's own env minus the flags that only mean something to an Electron
 *  helper. Same strip list as the PTY host's sessionEnv. */
export function editorClientEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const out = { ...env };
	delete out.ELECTRON_RUN_AS_NODE;
	delete out.LH_DESKTOP_API_SECRET;
	delete out.LH_DESKTOP_SERVER;
	delete out.NVIM_APPNAME;
	return out;
}

/** Terminal cell geometry arrives from the renderer: clamp before it reaches a
 *  pty ioctl (`resize` with 0/garbage is how a terminal dies). */
export function clampCell(value: unknown, fallback: number, max = 1000): number {
	const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
	if (!Number.isFinite(n) || n < 2) return fallback;
	return Math.min(n, max);
}

/**
 * Resolve a learner/agent-supplied path inside the workspace and refuse
 * anything that escapes it. The workspace is the learner's own directory, so a
 * symlink inside it (`link/id_rsa`) is a real escape route: the lexical check
 * alone accepts it. Containment is therefore checked on the REAL path — the
 * lexical pass first (cheap, catches `../`), then a realpath walk that also
 * covers a symlinked root. A path whose real parent is outside the real root is
 * refused; a root that does not exist falls back to the lexical answer (there
 * is nothing to resolve through, and the caller then reports "file not found").
 */
export function resolveWorkspacePath(root: string, file: string): string {
	const realRoot = realpathOrNull(root) ?? root;
	const absolute = path.resolve(realRoot, file);
	const relative = path.relative(realRoot, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Refused: "${file}" is outside the coding workspace.`);
	}
	const realResolved = realpathOfNearestAncestor(absolute);
	if (realResolved !== null) {
		const realRelative = path.relative(realRoot, realResolved);
		if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
			throw new Error(`Refused: "${file}" is outside the coding workspace.`);
		}
	}
	return absolute;
}

function realpathOrNull(target: string): string | null {
	try {
		return fs.realpathSync(target);
	} catch {
		return null;
	}
}

/** The real path of `target` when it exists, else of its nearest existing
 *  ancestor (a non-existent leaf cannot itself be a symlink). */
function realpathOfNearestAncestor(target: string): string | null {
	let probe = target;
	for (;;) {
		const real = realpathOrNull(probe);
		if (real !== null) return real;
		const parent = path.dirname(probe);
		if (parent === probe) return null;
		probe = parent;
	}
}
