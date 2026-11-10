/**
 * Terminal-focus registry (2026-11-11).
 *
 * The coding panes host a real pty, so the keyboard is no longer the app's:
 * while a terminal has focus the global shortcut dispatcher must stay out of
 * the way (Tab completion, Esc, Ctrl+W as vim's window prefix) and Electron
 * must release its application-menu accelerators (main: lh:code:focus).
 *
 * A module-level flag is enough because focus is single-valued per window and
 * the document-level dispatcher reads it synchronously. It is written only
 * from DOM focus events after mount, never during render (SSR-safe).
 */

let terminalFocused = false;

export function isTerminalFocused(): boolean {
	return terminalFocused;
}

/** Idempotent: blur of one pane followed by focus of the other must not
 *  flicker the bridge, and repeated blur events must not spam main. */
export function setTerminalFocus(focused: boolean): void {
	if (terminalFocused === focused) return;
	terminalFocused = focused;
	if (typeof window !== "undefined") window.lh?.code?.focus?.(focused);
}

/** Unmount path: a pane that unmounts while focused must hand the keyboard
 *  back, otherwise the app's accelerators stay released forever. */
export function releaseTerminalFocus(): void {
	setTerminalFocus(false);
}
