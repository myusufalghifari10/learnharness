import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { PATHS } from "../../config.ts";
import {
	WORKSPACE_SCOPE,
	editorClientEnv,
	editorSocketPath,
	resolveNvimBinary,
	workspaceRoot,
} from "../core/code-editor.ts";
import { readEditorState } from "./tools/open-in-editor.ts";

/**
 * Live coding-workspace status for the model's system prompt (2026-11-11).
 *
 * The agent can write practice files and hand them to the learner's Neovim,
 * but without this block it has to GUESS whether the Code view is open, where
 * the workspace is, and which file the learner is looking at. It would then
 * either ask questions it can answer itself or skip the pane entirely.
 *
 * The block is rebuilt per turn from the SAME facts the tool side uses:
 *   - root/scope come from core/code-editor.ts (one spelling with the PTY host);
 *   - the state file is DATA, not authority: only this workspace's own socket
 *     and cwd count as "running" (the open_in_editor trust rule);
 *   - the active buffer is a best-effort `nvim --remote-expr` probe with a hard
 *     timeout. A probe failure is never an error: it degrades to "unknown".
 *
 * Cheap on purpose: with no state file (the learner never opened Code) this
 * does one failing stat and spawns nothing.
 */

export type CodingWorkspaceStatus = {
	root: string;
	scope: string;
	running: boolean;
	stale: boolean;
	pid: number | null;
	activeFile: string | null;
	/** The prompt block, no trailing newline. */
	text: string;
};

type ProbeFn = (file: string, args: string[], options: { env: Record<string, string | undefined> }) => Promise<string>;

export type CodingWorkspaceStatusDeps = {
	dataDir?: string;
	scope?: unknown;
	env?: Record<string, string | undefined>;
	/** Test seam: read the active buffer instead of spawning nvim. */
	probe?: ProbeFn;
};

const PROBE_TIMEOUT_MS = 600;

function defaultProbe(file: string, args: string[], options: { env: Record<string, string | undefined> }): Promise<string> {
	return new Promise((resolve, reject) => {
		execFileCallback(
			file,
			args,
			{ timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: options.env as NodeJS.ProcessEnv },
			(error: Error | null, stdout: string) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

function isExecutable(file: string): boolean {
	try {
		fsSync.accessSync(file, fsSync.constants.X_OK);
		return fsSync.statSync(file).isFile();
	} catch {
		return false;
	}
}

function realpathOr(target: string): string {
	try {
		return fsSync.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function samePath(a: string, b: string): boolean {
	return realpathOr(a) === realpathOr(b);
}

/**
 * Read the running editor's current buffer. Returns null for every failure
 * mode (no binary, dead socket, timeout, a path outside the workspace): the
 * status block must never make a turn fail.
 */
async function probeActiveFile(
	root: string,
	socket: string,
	env: Record<string, string | undefined>,
	probe: ProbeFn,
): Promise<string | null> {
	const nvim = resolveNvimBinary(env, isExecutable);
	if (!nvim) return null;
	try {
		const out = await probe(nvim, ["--server", socket, "--remote-expr", "expand('%:p')"], { env: editorClientEnv(env) });
		const candidate = out.trim();
		if (!candidate) return null;
		const relative = path.relative(root, path.resolve(root, candidate));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
		return candidate;
	} catch {
		return null;
	}
}

function statusText(input: {
	root: string;
	running: boolean;
	stale: boolean;
	pid: number | null;
	activeFile: string | null;
}): string {
	const lines = ["## Coding workspace (live)", "", `Workspace: ${input.root}`];
	if (input.running) {
		lines.push(`Editor: running (Neovim${input.pid === null ? "" : `, pid ${input.pid}`})`);
		lines.push(
			input.activeFile
				? `Active buffer: ${input.activeFile}`
				: "Active buffer: unknown (the running editor did not answer)",
		);
	} else if (input.stale) {
		lines.push("Editor: not reachable (stale session state); ask the learner to reopen the Code view.");
	} else {
		lines.push("Editor: not open. The learner has not opened the Code view; files you write are still saved to disk.");
	}
	return lines.join("\n");
}

function status(input: {
	root: string;
	scope: string;
	running: boolean;
	stale: boolean;
	pid: number | null;
	activeFile: string | null;
}): CodingWorkspaceStatus {
	return { ...input, text: statusText(input) };
}

export async function describeCodingWorkspaceStatus(deps: CodingWorkspaceStatusDeps = {}): Promise<CodingWorkspaceStatus> {
	const env = deps.env ?? process.env;
	const scope = typeof deps.scope === "string" ? deps.scope : WORKSPACE_SCOPE;
	const root = workspaceRoot(deps.dataDir ?? PATHS.data, scope);
	const state = await readEditorState(root);
	if (!state) {
		return status({ root, scope, running: false, stale: false, pid: null, activeFile: null });
	}
	const expectedSocket = editorSocketPath(root, scope);
	const socketPresent = await fs.access(state.socket).then(() => true, () => false);
	if (state.socket !== expectedSocket || !samePath(state.cwd, root) || !socketPresent) {
		return status({ root, scope, running: false, stale: true, pid: null, activeFile: null });
	}
	const activeFile = await probeActiveFile(root, state.socket, env, deps.probe ?? defaultProbe);
	return status({ root, scope, running: true, stale: false, pid: state.pid, activeFile });
}
