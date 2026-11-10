import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { PATHS } from "../../../config.ts";
import {
	EDITOR_STATE_FILE,
	WORKSPACE_SCOPE,
	editorClientEnv,
	editorSocketPath,
	editorStatePath,
	resolveNvimBinary,
	resolveWorkspacePath,
	workspaceRoot,
} from "../../core/code-editor.ts";

/**
 * open_in_editor — the agent's half of the coding workspace (2026-11-11).
 *
 * The Code view hosts the learner's own Neovim in an Electron pty and leaves a
 * state file next to the workspace (`<data>/code/<scope>/.editor.json` with
 * the `nvim --listen` socket). This tool reads that file and hands the file to
 * the RUNNING editor through `nvim --server <sock> --remote <file>`; it never
 * spawns a second nvim and never edits anything itself (the learner-file tools
 * stay read-only by construction — see fs-shared.ts).
 *
 * Boundaries:
 *   - the path must resolve inside the workspace root (resolveWorkspacePath,
 *     which follows symlinks to their real target before deciding);
 *   - the state file must describe THIS workspace (its socket recomputed from
 *     the root + scope), so a workspace-writable file cannot choose the address
 *     the server dials through `nvim --server`;
 *   - the binary is resolved the same way the pty host resolves it;
 *   - the spawned client inherits the learner's env MINUS the desktop API secret
 *     (editorClientEnv), exactly like the pty host;
 *   - every failure is a clear thrown message: pi turns it into an error tool
 *     result the model can recover from (the read-tool convention).
 */

const openInEditorInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description: "File to show in the learner's coding editor, relative to the workspace root (for example 'hello.py').",
	}),
});

export type OpenInEditorInput = typeof openInEditorInput;

type ExecFn = (file: string, args: string[], options: { env: Record<string, string | undefined> }) => Promise<void>;

export type OpenInEditorDeps = {
	dataDir?: string;
	scope?: string;
	env?: Record<string, string | undefined>;
	/** Test seam: resolve instead of touching a real Neovim. */
	execFile?: ExecFn;
};

export type EditorState = { socket: string; scope: string; cwd: string; pid: number | null };

function defaultExec(file: string, args: string[], options: { env: Record<string, string | undefined> }): Promise<void> {
	return new Promise((resolve, reject) => {
		execFileCallback(file, args, { timeout: 8000, windowsHide: true, env: options.env as NodeJS.ProcessEnv }, (error: Error | null) => {
			if (error) reject(error);
			else resolve();
		});
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

export async function readEditorState(root: string): Promise<EditorState | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(editorStatePath(root), "utf8")) as Partial<EditorState>;
		if (typeof parsed.socket !== "string" || parsed.socket.length === 0) return null;
		return {
			socket: parsed.socket,
			scope: typeof parsed.scope === "string" ? parsed.scope : WORKSPACE_SCOPE,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : root,
			pid: typeof parsed.pid === "number" ? parsed.pid : null,
		};
	} catch {
		return null;
	}
}

export function createOpenInEditorTool(deps: OpenInEditorDeps = {}): AgentTool<typeof openInEditorInput> {
	const dataDir = deps.dataDir ?? PATHS.data;
	const scope = deps.scope ?? WORKSPACE_SCOPE;
	const env = deps.env ?? process.env;
	const exec = deps.execFile ?? defaultExec;

	return {
		name: "open_in_editor",
		label: "open_in_editor",
		description:
			`Show a file in the learner's own coding editor (the Code view's running Neovim). Paths are relative to the coding workspace; the result includes the absolute workspace directory, which you can pass to ls/read/find/grep to inspect the practice files. ${EDITOR_STATE_FILE} is written by the app, not by you.`,
		parameters: openInEditorInput,
		execute: serverExecute("open_in_editor", openInEditorInput, async ({ path: rawPath }, { signal }): Promise<string> => {
			signal?.throwIfAborted();
			const root = workspaceRoot(dataDir, scope);
			const state = await readEditorState(root);
			if (!state) {
				throw new Error(
					`No coding editor is running, so no file can be shown. Ask the learner to open the Code view first. Workspace: ${root}`,
				);
			}
			// The state file lives in a directory the learner (and anything they run)
			// can write, so it is DATA, not authority: only the socket this workspace's
			// own editor would use is accepted.
			const expectedSocket = editorSocketPath(root, scope);
			if (state.socket !== expectedSocket || samePath(state.cwd, root) !== true) {
				throw new Error(
					`The coding workspace state file does not match this workspace (expected socket ${expectedSocket}), so the editor cannot be reached safely. Ask the learner to reopen the Code view.`,
				);
			}
			const absolute = resolveWorkspacePath(root, rawPath);
			const exists = await fs.access(absolute).then(() => true, () => false);
			if (!exists) throw new Error(`File not found in the coding workspace: ${path.relative(root, absolute) || rawPath}`);
			const nvim = resolveNvimBinary(env, isExecutable);
			if (!nvim) throw new Error("Neovim (nvim) was not found, so the running editor cannot be reached.");
			try {
				await exec(nvim, ["--server", state.socket, "--remote", absolute], { env: editorClientEnv(env) });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Could not reach the running editor (${message}). It may have been closed; ask the learner to reopen Code.`);
			}
			return `Opened ${path.relative(root, absolute) || absolute} in the coding editor.\nWorkspace: ${root}`;
		}),
	};
}

export const openInEditorTool = createOpenInEditorTool();

/** Compare two directory spellings through their real path when both exist (a
 *  workspace reached through a symlinked data dir must still count as itself). */
function samePath(a: string, b: string): boolean {
	const left = realpathOr(a);
	const right = realpathOr(b);
	return left === right;
}

function realpathOr(target: string): string {
	try {
		return fsSync.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}
