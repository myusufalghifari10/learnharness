/**
 * Code ↔ session mode switch (owner 2026-11-12) — the pins for the three
 * acceptance checks in docs/coding-pane/spec.md F11:
 *   A1 from a session, the chord opens /code
 *   A2 from /code, the chord opens the last session (graph view when none)
 *   A3 the chord is a real registry action, so the terminal pane can recognise
 *      it (the global dispatcher stands down while a pane owns the keyboard)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CODE_PATH,
	LAST_CHAT_KEY,
	codeToggleTarget,
	isCodePath,
	readLastChatId,
	rememberLastChat,
} from "../components/code/mode-switch.ts";
import { actionForBinding, bindingForAction, eventBinding, kbdEventForAction } from "../src/core/keyboard.ts";

/** The shape xterm hands attachCustomKeyEventHandler. */
function key(over: Partial<KeyboardEvent>): KeyboardEvent {
	return { key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over } as KeyboardEvent;
}

describe("the code toggle destination", () => {
	it("A1: from any session route the chord opens the coding workspace", () => {
		assert.equal(codeToggleTarget("/chat/chat_abc", "chat_xyz"), CODE_PATH);
		assert.equal(codeToggleTarget("/chat/new", null), CODE_PATH);
		assert.equal(codeToggleTarget("/", "chat_xyz"), CODE_PATH);
		assert.equal(codeToggleTarget("/code", null), "/", "code without a remembered session falls back to the graph");
	});

	it("A2: from the workspace the chord returns to the last session", () => {
		assert.equal(codeToggleTarget("/code", "chat_mwc7sieo_ef257481"), "/chat/chat_mwc7sieo_ef257481");
		assert.equal(codeToggleTarget("/code/anything", "chat_abc"), "/chat/chat_abc", "child routes count as the workspace");
	});

	it("a corrupt or hostile stored id never becomes part of a URL", () => {
		for (const bad of ["", "   ", "../settings", "chat id", "chat/../../x", "a?b=1", "<script>"]) {
			assert.equal(codeToggleTarget("/code", bad), "/", `id ${JSON.stringify(bad)} must fall back`);
		}
		assert.equal(isCodePath(null), false);
		assert.equal(isCodePath("/codex"), false, "a prefix is not the workspace");
	});
});

describe("the last-session memory", () => {
	it("round-trips through localStorage and survives a blocked store", () => {
		const store = new Map<string, string>();
		const fake = {
			localStorage: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
			},
		};
		const original = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", { value: fake, configurable: true, writable: true });
		try {
			assert.equal(readLastChatId(), null);
			rememberLastChat("chat_abc");
			assert.equal(store.get(LAST_CHAT_KEY), "chat_abc");
			assert.equal(readLastChatId(), "chat_abc");

			// A store that throws (private mode, quota) must not break the page.
			Object.defineProperty(globalThis, "window", {
				value: {
					localStorage: {
						getItem: () => {
							throw new Error("denied");
						},
						setItem: () => {
							throw new Error("denied");
						},
					},
				},
				configurable: true,
				writable: true,
			});
			assert.equal(readLastChatId(), null);
			assert.doesNotThrow(() => rememberLastChat("chat_abc"));
		} finally {
			if (original) Object.defineProperty(globalThis, "window", original);
			else delete (globalThis as { window?: unknown }).window;
		}
	});
});

describe("A3: the chord is a registry action, not a pane-local guess", () => {
	it("is bound to mod+shift+e and matches from the terminal's own handler", () => {
		assert.equal(bindingForAction("toggle-code"), "mod+shift+e");
		assert.equal(kbdEventForAction("toggle-code"), "lh:kbd-toggle-code");
		// Ctrl+Shift+E (Linux/Windows) and ⌘+Shift+E (mac) both normalize to mod.
		for (const event of [key({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true }), key({ key: "E", code: "KeyE", metaKey: true, shiftKey: true })]) {
			assert.equal(actionForBinding(eventBinding(event)), "toggle-code");
		}
		// Neighbours stay untouched: no accidental shift-e hijack, no leak of
		// the old bindings onto the new chord.
		assert.equal(actionForBinding(eventBinding(key({ key: "e", code: "KeyE" }))), undefined);
		assert.equal(actionForBinding(eventBinding(key({ key: "E", code: "KeyE", ctrlKey: true }))), undefined);
		assert.equal(actionForBinding(eventBinding(key({ key: "f", code: "KeyF", ctrlKey: true, shiftKey: true }))), "sessions-search");
	});
});
