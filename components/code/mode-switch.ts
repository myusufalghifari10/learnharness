/**
 * Mode switching between the coding workspace and the learning session
 * (owner 2026-11-12): one keyboard chord, two directions.
 *
 * Data shape: one string (the last session id) in localStorage, plus a pure
 * decision from (pathname, lastChatId) to a route. The chat surface and the
 * code surface each answer the same window event; this module decides where
 * the toggle lands, so neither surface invents its own rule.
 *
 * Acceptance checks (docs/coding-pane/spec.md, F11):
 *  A1 from a session, the chord opens /code
 *  A2 from /code, the chord opens the last session (graph view when none)
 *  A3 the chord fires even while a terminal pane owns the keyboard
 */

/** localStorage key holding the session the learner was last inside. */
export const LAST_CHAT_KEY = "lh:last-chat";

export const CODE_PATH = "/code";

/** True when `pathname` is the coding workspace (or a child of it). */
export function isCodePath(pathname: string | null | undefined): boolean {
	const path = pathname ?? "";
	return path === CODE_PATH || path.startsWith(`${CODE_PATH}/`);
}

/**
 * Where the code/session toggle sends the learner.
 *  - from a learning session → the coding workspace;
 *  - from the coding workspace → the last session that was open, falling
 *    back to the graph view when no session has been visited on this device.
 * A malformed stored id never produces a broken URL: anything that is not a
 * plain session id is discarded and the fallback applies.
 */
export function codeToggleTarget(pathname: string | null | undefined, lastChatId: string | null | undefined): string {
	if (!isCodePath(pathname)) return CODE_PATH;
	const id = (lastChatId ?? "").trim();
	if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return "/";
	return `/chat/${encodeURIComponent(id)}`;
}

/** Safe read of the remembered session id (SSR, private mode, corrupt store). */
export function readLastChatId(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(LAST_CHAT_KEY);
	} catch {
		return null;
	}
}

/** Record the session the learner is in. Guarded: a blocked store is fine. */
export function rememberLastChat(chatId: string): void {
	if (typeof window === "undefined" || !chatId) return;
	try {
		window.localStorage.setItem(LAST_CHAT_KEY, chatId);
	} catch {
		/* storage unavailable = the toggle falls back to the graph view */
	}
}
