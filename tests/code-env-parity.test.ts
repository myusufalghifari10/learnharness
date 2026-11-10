/**
 * F3 (docs/coding-pane/review-2.md): the env-strip pins were per-variable. Two
 * sanitisers feed a child process (`sessionEnv` for the PTY host,
 * `editorClientEnv` for the `nvim --remote` client), and a future secret added
 * to only one of them must fail a test.
 *
 * The fixture check proves the deletes actually apply; the DECLARED-list check
 * (parsed from each function's own body) is what catches a new `delete out.X`
 * that no fixture has ever heard of.
 *
 * Beside the round-2 pin file because the session gate refuses edits to an
 * existing test file.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const requireCjs = createRequire(import.meta.url);
const codeSession = requireCjs("../electron/code-session.cjs");
const core = await import("../src/core/code-editor.ts");

type Sanitiser = (env: Record<string, string>) => Record<string, string | undefined>;

const FIXTURE: Record<string, string> = {
	PATH: "/usr/bin:/bin",
	SHELL: "/bin/sh",
	WAYLAND_DISPLAY: "wayland-1",
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	ELECTRON_RUN_AS_NODE: "1",
	LH_DESKTOP_API_SECRET: "desktop-secret",
	LH_DESKTOP_SERVER: "1",
	NVIM_APPNAME: "custom",
	HOME: "/home/learner",
};

function declaredStrips(sanitise: (...args: never[]) => unknown): string[] {
	const body = sanitise.toString();
	return [...body.matchAll(/delete out\.([A-Za-z0-9_]+)/g)].map((match) => match[1]!).sort();
}

function strippedBy(sanitise: Sanitiser): string[] {
	const out = sanitise({ ...FIXTURE });
	return Object.keys(FIXTURE).filter((key) => out[key] === undefined).sort();
}

describe("F3 — the two env sanitisers declare the same strip list", () => {
	it("the PTY host and the nvim client delete exactly the same names", () => {
		const host = declaredStrips(codeSession.sessionEnv as (...args: never[]) => unknown);
		const client = declaredStrips(core.editorClientEnv as (...args: never[]) => unknown);
		assert.deepEqual(host, client, "adding a secret to one sanitiser only must fail here");
		assert.deepEqual(client, ["ELECTRON_RUN_AS_NODE", "LH_DESKTOP_API_SECRET", "LH_DESKTOP_SERVER", "NVIM_APPNAME"]);
	});

	it("every declared name is really removed from a live environment, on both sides", () => {
		for (const [label, sanitiser] of [
			["sessionEnv", (env: Record<string, string>) => codeSession.sessionEnv(env) as Record<string, string | undefined>],
			["editorClientEnv", (env: Record<string, string>) => core.editorClientEnv(env)],
		] as Array<[string, Sanitiser]>) {
			const stripped = strippedBy(sanitiser);
			assert.deepEqual(stripped, ["ELECTRON_RUN_AS_NODE", "LH_DESKTOP_API_SECRET", "LH_DESKTOP_SERVER", "NVIM_APPNAME"], label);
		}
	});

	it("neither side drops the learner's session identity", () => {
		for (const [label, sanitiser] of [
			["sessionEnv", (env: Record<string, string>) => codeSession.sessionEnv(env) as Record<string, string | undefined>],
			["editorClientEnv", (env: Record<string, string>) => core.editorClientEnv(env)],
		] as Array<[string, Sanitiser]>) {
			const env = sanitiser({ ...FIXTURE });
			assert.equal(env.WAYLAND_DISPLAY, "wayland-1", `${label} keeps the Wayland session`);
			assert.equal(env.HOME, "/home/learner", `${label} keeps HOME so nvim finds ~/.config/nvim`);
			assert.equal(env.PATH, "/usr/bin:/bin", `${label} keeps PATH`);
		}
	});
});
