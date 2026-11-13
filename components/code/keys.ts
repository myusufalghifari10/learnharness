/**
 * Keys xterm cannot encode (2026-11-11, acceptance F3).
 *
 * xterm's `evaluateKeyboardEvent` (node_modules/@xterm/xterm/src/common/input/
 * Keyboard.ts) resolves Ctrl+<key> from a hard-coded keyCode table: 65-90 (a-z),
 * 32 (space), 51-56, 219-221. KeyCode **191 ("/") is not in it**, and the only
 * other ctrl mappings are the trailing `ev.key === '_'` / `'@'` fallbacks, so a
 * Ctrl+Slash keydown encodes to the empty string and dies inside xterm before
 * anything is written to the pty.
 *
 * That silently breaks LazyVim's `<C-/>` terminal toggle (`maparg("<C-/>")` is a
 * real mapping in lazyvim/config/keymaps.lua); the acceptance run measured 0
 * bytes reaching the pty for that chord.
 *
 * The fix is the byte the chord means: Ctrl+/ is ASCII 0x1F (C0.US, "unit
 * separator"), the same byte xterm already emits for `_`. Kept as a pure
 * function so the rule is testable without a DOM, and deliberately narrow:
 * every other chord keeps going to xterm untouched.
 */

/** The subset of KeyboardEvent this rule reads. */
export type KeyEventLike = {
	type?: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	key?: string;
};

/** C0.US — what a terminal sends for Ctrl+/ (and Ctrl+_). */
export const CTRL_SLASH_BYTES = "\x1f";

/**
 * Bytes to write for a chord xterm cannot encode, or `null` to let xterm handle
 * the event as usual.
 *
 * Deliberately NOT handled: Ctrl+Shift+/ (`?`) and everything else. Terminals
 * disagree about `?` (0x7F vs 0x1F) and it is not a LazyVim binding, so leaving
 * it to xterm avoids swallowing a chord the shell may want.
 */
export function customKeyBytes(event: KeyEventLike): string | null {
	if (event.type !== "keydown") return null;
	if (!event.ctrlKey || event.altKey || event.metaKey) return null;
	if (event.key === "/" || event.key === "_") return CTRL_SLASH_BYTES;
	return null;
}

/**
 * What one xterm event means for the code/session chord (owner 2026-11-13).
 *
 * xterm calls `attachCustomKeyEventHandler` for BOTH keydown and keyup. The
 * release of a press therefore arrived as a second, non-repeated event with the
 * same chord — it was handled, re-dispatched, and the app bounced back to the
 * session it had just left (reproduced: chat → /code → chat on key release).
 *
 *  - not the chord at all → "pass": xterm keeps the keystroke.
 *  - the chord, but a keyup or an auto-repeat → "swallow": xterm must not see
 *    it and nobody navigates.
 *  - exactly one keydown → "dispatch": the toggle fires once per press.
 */
export function toggleChordIntent(
	isToggle: boolean,
	event: KeyEventLike & { repeat?: boolean },
): "pass" | "swallow" | "dispatch" {
	if (!isToggle) return "pass";
	if (event.type !== "keydown" || event.repeat) return "swallow";
	return "dispatch";
}
