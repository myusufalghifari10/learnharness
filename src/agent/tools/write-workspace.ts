import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { PATHS } from "../../../config.ts";
import { EDITOR_STATE_FILE, WORKSPACE_SCOPE, resolveWorkspacePath, workspaceRoot } from "../../core/code-editor.ts";

/**
 * write_workspace_file — the agent's writing half of the coding workspace
 * (2026-11-11, user-approved option C).
 *
 * open_in_editor only SHOWS a file; without a write path the teacher cannot
 * put an exercise on the learner's screen at all, which is why "teach me to
 * code" could never use the pane. This tool closes that gap and nothing else:
 *
 *   - the target must resolve INSIDE <data>/code/<scope> (resolveWorkspacePath:
 *     lexical pass plus a realpath walk, so a symlink leaf cannot carry the
 *     write out of the workspace);
 *   - the workspace BOOKKEEPING is off limits: the state file and the
 *     `nvim --listen` socket are the app's, not the model's;
 *   - an existing file is never replaced silently: the model must pass
 *     overwrite: true, and the error tells it to read the file first, because
 *     the learner may have edited those bytes in Neovim;
 *   - content is capped (256 KiB) instead of truncated, and the write is
 *     atomic (temp file + rename) so a failed write cannot leave half a file.
 *
 * It does not open the file; open_in_editor is that step, and the prompt tells
 * the model to call it right after writing.
 */

const MAX_CONTENT_CHARS = 256 * 1024;

const writeWorkspaceFileInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description: "File to write, relative to the coding workspace root (for example 'exercises/strings.py').",
	}),
	content: Type.String({
		description: "The complete file content. Not a patch: whatever you send replaces the file.",
	}),
	overwrite: Type.Optional(
		Type.Boolean({
			description:
				"Required when the file already exists. Read it first: the learner may have edited it in Neovim, and their edits are not yours to discard.",
		}),
	),
});

/** The VALUE shape (what execute receives after the loop's validation), so a
 *  caller injecting the tool's input type gets an object, not the schema. */
export type WriteWorkspaceFileInput = Static<typeof writeWorkspaceFileInput>;

export type WriteWorkspaceFileDeps = {
	dataDir?: string;
	scope?: string;
};

function isInsideWorkspaceBookkeeping(leaf: string): boolean {
	return leaf === EDITOR_STATE_FILE || leaf.endsWith(".sock");
}

export function createWriteWorkspaceFileTool(deps: WriteWorkspaceFileDeps = {}): AgentTool<typeof writeWorkspaceFileInput> {
	const dataDir = deps.dataDir ?? PATHS.data;
	const scope = deps.scope ?? WORKSPACE_SCOPE;

	return {
		name: "write_workspace_file",
		label: "write_workspace_file",
		description:
			`Create or replace a file in the learner's coding workspace (the Code view's workspace, the same directory their shell and Neovim run in). Use it to put an exercise, a starter file, or a fix on disk; then call open_in_editor to show it. Paths are relative to the workspace root. Existing files need overwrite: true. The workspace path is returned, so ls/read/find/grep work on it too.`,
		parameters: writeWorkspaceFileInput,
		execute: serverExecute("write_workspace_file", writeWorkspaceFileInput, async (input, { signal }): Promise<string> => {
			signal?.throwIfAborted();
			const root = workspaceRoot(dataDir, scope);
			const absolute = resolveWorkspacePath(root, input.path);
			const relative = path.relative(root, absolute) || input.path;
			if (isInsideWorkspaceBookkeeping(path.basename(absolute))) {
				throw new Error(
					`Refused: ${relative} is workspace bookkeeping (the app's editor state), not a practice file. Work in a normal file instead.`,
				);
			}
			const chars = input.content.length;
			if (chars > MAX_CONTENT_CHARS) {
				throw new Error(
					`Refused: ${chars} characters is over the ${MAX_CONTENT_CHARS} character limit for one write. Split the file into smaller writes.`,
				);
			}
			const existing = await fs.stat(absolute).then((s) => s, () => null);
			if (existing?.isDirectory()) {
				throw new Error(`Refused: ${relative} is a directory in the coding workspace, not a file.`);
			}
			if (existing && input.overwrite !== true) {
				throw new Error(
					`Refused: ${relative} already exists. read it first (the learner may have edited it in Neovim), then re-send with overwrite: true to replace it.`,
				);
			}
			const dir = path.dirname(absolute);
			await fs.mkdir(dir, { recursive: true });
			const temp = path.join(dir, `.${path.basename(absolute)}.lh-${process.pid}-${Date.now()}.tmp`);
			try {
				await fs.writeFile(temp, input.content, "utf8");
				await fs.rename(temp, absolute);
			} catch (error) {
				await fs.rm(temp, { force: true }).catch(() => {});
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Could not write ${relative} in the coding workspace (${message}).`);
			}
			const bytes = Buffer.byteLength(input.content, "utf8");
			const lines = input.content === "" ? 0 : input.content.split("\n").length;
			return `Wrote ${relative} (${bytes} bytes, ${lines} lines).\nWorkspace: ${root}\nShow it in the editor with open_in_editor.`;
		}),
	};
}

export const writeWorkspaceFileTool = createWriteWorkspaceFileTool();

/** Exported for tests: the cap is behaviour, not an internal; a test asserts
 *  the refusal without building a 256 KiB fixture twice. */
export const writeWorkspaceFileLimits = { maxContentChars: MAX_CONTENT_CHARS };
