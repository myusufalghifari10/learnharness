/**
 * Ctrl+/ must reach the pty (acceptance F3).
 *
 * The defect: xterm encodes Ctrl+<key> from a hard-coded keyCode table that has
 * no entry for 191 ("/"), so the chord produced no bytes at all and LazyVim's
 * `<C-/>` terminal toggle appeared dead while every other chord worked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CTRL_SLASH_BYTES, customKeyBytes, toggleChordIntent } from "../components/code/keys.ts";

const down = (init: Record<string, unknown>) => ({ type: "keydown", ctrlKey: false, altKey: false, metaKey: false, ...init });

describe("customKeyBytes — the chords xterm cannot encode", () => {
	it("Ctrl+/ writes the byte the chord means (0x1F), so LazyVim's <C-/> toggle fires", () => {
		assert.equal(customKeyBytes(down({ ctrlKey: true, key: "/" })), CTRL_SLASH_BYTES);
		assert.equal(CTRL_SLASH_BYTES, "\x1f");
	});

	it("Ctrl+_ writes the same byte (the alternate LazyVim binding, and what xterm itself maps)", () => {
		assert.equal(customKeyBytes(down({ ctrlKey: true, key: "_" })), "\x1f");
	});

	it("leaves every other chord to xterm", () => {
		const untouched = [
			down({ key: "/" }), // plain slash
			down({ key: "_" }), // plain underscore
			down({ ctrlKey: true, key: "c" }), // SIGINT / leave insert mode
			down({ ctrlKey: true, key: "v" }), // visual block
			down({ ctrlKey: true, key: "w" }), // window prefix
			down({ ctrlKey: true, key: "b" }), // app shortcut (dispatcher stands down elsewhere)
			down({ ctrlKey: true, key: "a" }),
			down({ ctrlKey: true, key: "d" }),
			down({ ctrlKey: true, key: "z" }),
			down({ ctrlKey: true, key: "?" }), // Ctrl+Shift+/: terminals disagree, left to xterm
			down({ ctrlKey: true, shiftKey: true, key: "?" }),
			down({ ctrlKey: true, altKey: true, key: "/" }), // AltGr-style
			down({ ctrlKey: true, metaKey: true, key: "/" }),
			down({ altKey: true, key: "/" }),
			down({ ctrlKey: true, key: "a" }),
			down({ ctrlKey: true, key: "Enter" }),
			down({ ctrlKey: true, key: " " }),
		];
		for (const event of untouched) {
			assert.equal(customKeyBytes(event), null, `must not claim ${JSON.stringify(event)}`);
		}
	});

	it("only reacts to keydown — a matching keyup must not emit a second byte", () => {
		assert.equal(customKeyBytes({ type: "keyup", ctrlKey: true, key: "/" }), null);
		assert.equal(customKeyBytes({ type: "keypress", ctrlKey: true, key: "/" }), null);
		assert.equal(customKeyBytes({ ctrlKey: true, key: "/" }), null, "no type = not a keydown");
	});
});

describe("toggleChordIntent — one toggle per press (bug 2026-11-13)", () => {
	it("dispatches exactly once: the keydown, never its keyup", () => {
		assert.equal(toggleChordIntent(true, { type: "keydown" }), "dispatch");
		// xterm calls attachCustomKeyEventHandler for the release too; that was the
		// bug (chat -> /code -> chat on keyup).
		assert.equal(toggleChordIntent(true, { type: "keyup" }), "swallow");
		assert.equal(toggleChordIntent(true, { type: "keypress" }), "swallow");
	});

	it("swallows auto-repeat so a held chord cannot bounce back", () => {
		assert.equal(toggleChordIntent(true, { type: "keydown", repeat: true }), "swallow");
		assert.equal(toggleChordIntent(true, { type: "keydown", repeat: undefined }), "dispatch");
	});

	it("leaves every other keystroke to xterm", () => {
		assert.equal(toggleChordIntent(false, { type: "keydown" }), "pass");
		assert.equal(toggleChordIntent(false, { type: "keyup" }), "pass");
	});
});
