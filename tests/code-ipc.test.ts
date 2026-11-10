/**
 * Coding-workspace IPC registration (electron/code-ipc.cjs).
 *
 * The handlers spawn processes, so the trust gate is the point of the file:
 * every entry point must refuse a sender that is not a trusted app window.
 * A fake ipcMain keeps this a pure unit test (the same shape
 * tests/browser-service-lifetime.test.ts uses for the shell).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const requireCjs = createRequire(import.meta.url);
const { CODE_CHANNELS, registerCodeIpc } = requireCjs("../electron/code-ipc.cjs");

type Handler = (event: unknown, payload?: unknown) => unknown;

function harness({ trusted }: { trusted: boolean }) {
	const handles = new Map<string, Handler>();
	const listeners = new Map<string, Handler>();
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const focusCalls: Array<{ focused: boolean; event: unknown }> = [];

	const sessions = {
		start: (args: unknown) => {
			calls.push({ name: "start", args: [args] });
			return { ok: true, id: "editor:scratch", cwd: "/data/code/scratch", socket: "/data/code/scratch/.nvim-scratch.sock" };
		},
		write: (id: unknown, data: unknown) => calls.push({ name: "write", args: [id, data] }),
		resize: (id: unknown, cols: unknown, rows: unknown) => calls.push({ name: "resize", args: [id, cols, rows] }),
		kill: (id: unknown) => calls.push({ name: "kill", args: [id] }),
		state: () => [{ id: "editor:scratch" }],
	};

	registerCodeIpc({
		ipcMain: {
			handle: (channel: string, handler: Handler) => handles.set(channel, handler),
			on: (channel: string, handler: Handler) => listeners.set(channel, handler),
		},
		sessions,
		isTrusted: () => trusted,
		onFocus: (focused: boolean, event: unknown) => focusCalls.push({ focused, event }),
	});

	const caller = () => events[0];
	const events = [{ sender: "trusted-window" }];
	return { handles, listeners, calls, focusCalls, caller };
}

describe("code ipc", () => {
	it("refuses every channel from an untrusted sender", async () => {
		const h = harness({ trusted: false });
		const start = await h.handles.get(CODE_CHANNELS.start)!(h.caller(), { kind: "editor", scope: "scratch" });
		assert.deepEqual(start, { ok: false, error: "Untrusted desktop request." });
		h.listeners.get(CODE_CHANNELS.write)!(h.caller(), { id: "editor:scratch", data: "x" });
		h.listeners.get(CODE_CHANNELS.resize)!(h.caller(), { id: "editor:scratch", cols: 80, rows: 24 });
		h.listeners.get(CODE_CHANNELS.kill)!(h.caller(), { id: "editor:scratch" });
		h.listeners.get(CODE_CHANNELS.focus)!(h.caller(), true);
		assert.deepEqual(await h.handles.get(CODE_CHANNELS.state)!(h.caller()), []);
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.focusCalls, []);
	});

	it("forwards a trusted session lifecycle without inventing arguments", async () => {
		const h = harness({ trusted: true });
		const args = { kind: "shell", scope: "scratch", cols: 120, rows: 40 };
		const started = await h.handles.get(CODE_CHANNELS.start)!(h.caller(), args);
		assert.equal((started as { ok: boolean }).ok, true);
		assert.deepEqual(h.calls[0], { name: "start", args: [args] });

		h.listeners.get(CODE_CHANNELS.write)!(h.caller(), { id: "shell:scratch", data: "ls\r" });
		h.listeners.get(CODE_CHANNELS.resize)!(h.caller(), { id: "shell:scratch", cols: 100, rows: 30 });
		h.listeners.get(CODE_CHANNELS.kill)!(h.caller(), { id: "shell:scratch" });
		assert.deepEqual(h.calls.slice(1), [
			{ name: "write", args: ["shell:scratch", "ls\r"] },
			{ name: "resize", args: ["shell:scratch", 100, 30] },
			{ name: "kill", args: ["shell:scratch"] },
		]);
	});

	it("only a literal true claims terminal focus", () => {
		const h = harness({ trusted: true });
		h.listeners.get(CODE_CHANNELS.focus)!(h.caller(), true);
		h.listeners.get(CODE_CHANNELS.focus)!(h.caller(), "yes");
		assert.deepEqual(h.focusCalls.map((c) => c.focused), [true, false]);
	});

	it("returns the live session list to a trusted window", async () => {
		const h = harness({ trusted: true });
		assert.deepEqual(await h.handles.get(CODE_CHANNELS.state)!(h.caller()), [{ id: "editor:scratch" }]);
	});

	it("keeps the channel names the preload bridge spells", () => {
		const preload = readFileSync(new URL("../electron/preload.cjs", import.meta.url), "utf8");
		for (const channel of Object.values(CODE_CHANNELS) as string[]) {
			assert.ok(preload.includes(channel), `preload.cjs is missing ${channel}`);
		}
	});
});
