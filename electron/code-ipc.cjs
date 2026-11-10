/**
 * Coding-workspace IPC (Electron main). Kept out of main.cjs for the same
 * reason chatgpt-ipc.cjs / subscription-ipc.cjs exist: the handlers get a
 * harness test (tests/code-ipc.test.ts) with a fake ipcMain, and main.cjs
 * stays a composition root.
 *
 * Trust model: every entry point checks the sender exactly like the other
 * desktop channels (`trustedAppWindows` + `trustedSender`), because these
 * handlers spawn processes. The renderer can only ever name a session id,
 * a kind, a scope under the data dir, terminal geometry, and keystrokes —
 * never a binary, a cwd, an env var, or an argv list.
 */

const CODE_CHANNELS = {
	start: "lh:code:start",
	write: "lh:code:write",
	resize: "lh:code:resize",
	kill: "lh:code:kill",
	focus: "lh:code:focus",
	state: "lh:code:state",
	data: "lh:code:data",
	exit: "lh:code:exit",
};

/**
 * @param {object} deps
 * @param {import("electron").IpcMain} deps.ipcMain
 * @param {ReturnType<import("./code-session.cjs").createCodeSessions>} deps.sessions
 * @param {(event: unknown) => boolean} deps.isTrusted
 * @param {(focused: boolean, event: unknown) => void} deps.onFocus
 */
function registerCodeIpc({ ipcMain, sessions, isTrusted, onFocus }) {
	ipcMain.handle(CODE_CHANNELS.start, (event, args) => {
		if (!isTrusted(event)) return { ok: false, error: "Untrusted desktop request." };
		return sessions.start({ kind: args?.kind, scope: args?.scope, cols: args?.cols, rows: args?.rows });
	});

	ipcMain.on(CODE_CHANNELS.write, (event, args) => {
		if (!isTrusted(event)) return;
		sessions.write(args?.id, args?.data);
	});

	ipcMain.on(CODE_CHANNELS.resize, (event, args) => {
		if (!isTrusted(event)) return;
		sessions.resize(args?.id, args?.cols, args?.rows);
	});

	ipcMain.on(CODE_CHANNELS.kill, (event, args) => {
		if (!isTrusted(event)) return;
		sessions.kill(args?.id);
	});

	ipcMain.on(CODE_CHANNELS.focus, (event, focused) => {
		if (!isTrusted(event)) return;
		onFocus(focused === true, event);
	});

	ipcMain.handle(CODE_CHANNELS.state, (event) => (isTrusted(event) ? sessions.state() : []));

	return CODE_CHANNELS;
}

module.exports = { CODE_CHANNELS, registerCodeIpc };
