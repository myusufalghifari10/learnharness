"use client";

/**
 * One real terminal pane (2026-11-11).
 *
 * xterm.js renders; the bytes come from a pty spawned by Electron main
 * (electron/code-session.cjs). Two instances ship: `editor` runs the learner's
 * own `nvim --listen …` (LazyVim config, keymaps, plugins — untouched) and
 * `shell` runs their login shell in the same workspace directory.
 *
 * Deliberate choices:
 *   - the xterm modules are imported INSIDE the effect: they touch `document`
 *     at import time, and this repo has no `next/dynamic` precedent — an
 *     effect-scoped import keeps SSR clean with the existing idiom.
 *   - the Nerd Font is loaded and measured BEFORE `open()`: xterm measures
 *     glyphs synchronously and caches the widths, so a late font load makes
 *     every devicon the wrong size for the life of the terminal.
 *   - every keystroke goes to the pty; the app's global shortcuts stand down
 *     while this pane has focus (components/code/focus.ts).
 */

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { cn } from "@/lib/utils";
import { actionForBinding, eventBinding, kbdEventForAction } from "@/src/core";
import { releaseTerminalFocus, setTerminalFocus } from "./focus.ts";
import { customKeyBytes, toggleChordIntent } from "./keys.ts";
import { observePaneSize } from "./pane-size.ts";

const FONT_FAMILY = '"JetBrainsMono Nerd Font Mono", "Symbols Nerd Font Mono", "JetBrains Mono", monospace';
const RESIZE_DEBOUNCE_MS = 120;
/** Second measurement after a resize: layout settles a tick after the notification,
 *  and xterm's fit() no-ops silently until the box is measurable. */
const PANE_RELAYOUT_RETRY_MS = 180;
/** Geometry watchdog: the pane's box is compared against the last fitted box this
 *  often. It is the guarantee — a ResizeObserver notification can be missed (it is
 *  in this Electron build: an inline width change on the observed element produced
 *  no callback at all), and a missed notification used to mean a pane that never
 *  re-fits for the rest of its life. One getBoundingClientRect per tick. */
const PANE_WATCHDOG_MS = 250;

/** App palette (app/globals.css) — the terminal is part of the same surface,
 *  so its literals are the only escape hatch the repo already accepts for
 *  terminal output colour. */
const THEME = {
	background: "#141414",
	foreground: "#e6e6e6",
	cursor: "#e6e6e6",
	cursorAccent: "#141414",
	selectionBackground: "#434343",
	black: "#141414",
	red: "#e59a9a",
	green: "#a8c99a",
	yellow: "#d8c48a",
	blue: "#8fb4d9",
	magenta: "#c4a0d0",
	cyan: "#8fc9c4",
	white: "#e6e6e6",
	brightBlack: "#8d8d8d",
	brightRed: "#f0b0b0",
	brightGreen: "#c2ddb4",
	brightYellow: "#e8d9a8",
	brightBlue: "#a9c9e8",
	brightMagenta: "#d8badf",
	brightCyan: "#a8ddd8",
	brightWhite: "#ffffff",
} as const;

export type CodeSessionKind = "editor" | "shell";

export function TerminalPane({
	kind,
	scope,
	label,
	className,
	autoFocus = false,
	onExit,
	focusToken,
}: {
	kind: CodeSessionKind;
	scope: string;
	label: string;
	className?: string;
	autoFocus?: boolean;
	/** The child process ended (owner 2026-11-12: leaving nvim hands the screen
	 *  to the terminal). Kept in a ref so the pty is never restarted by a
	 *  re-render — the boot effect's deps stay stable on purpose. */
	onExit?: (code: number) => void;
	/** Bumped by the parent when this pane becomes the visible one: focus the
	 *  terminal without remounting it. */
	focusToken?: number;
}) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const paneRef = useRef<HTMLElement | null>(null);
	const [status, setStatus] = useState("starting…");
	const onExitRef = useRef<((code: number) => void) | undefined>(onExit);
	onExitRef.current = onExit;
	const termRef = useRef<{ focus: () => void } | null>(null);

	// Focus follows the parent's choice of visible pane; the boot effect is
	// deliberately NOT in this dependency chain (a remount would kill the pty
	// and the nvim session with it).
	useEffect(() => {
		if (focusToken === undefined) return;
		termRef.current?.focus();
	}, [focusToken]);

	useEffect(() => {
		const host = hostRef.current;
		const bridge = typeof window === "undefined" ? undefined : window.lh?.code;
		if (!host) return;
		if (!bridge) {
			setStatus("desktop app only");
			return;
		}

		let disposed = false;
		let sessionId: string | null = null;
		let terminal: { dispose: () => void; cols: number; rows: number; focus: () => void } | null = null;
		const cleanups: Array<() => void> = [];

		const boot = async () => {
			const [{ Terminal }, { FitAddon }, webgl, unicode11] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
				import("@xterm/addon-webgl"),
				import("@xterm/addon-unicode11"),
			]);
			if (disposed) return;
			// Measure the font first (see the header note).
			try {
				await document.fonts?.load(`12px "JetBrainsMono Nerd Font Mono"`);
			} catch {
				/* no FontFaceSet (or the font is absent): the fallback stack still works */
			}
			if (disposed) return;

			const term = new Terminal({
				fontFamily: FONT_FAMILY,
				fontSize: 12,
				lineHeight: 1.2,
				cursorBlink: true,
				scrollback: 5000,
				allowProposedApi: true, // addon-unicode11 requires it
				theme: { ...THEME },
				macOptionIsMeta: true,
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(host);
			try {
				const webglAddon = new webgl.WebglAddon();
				webglAddon.onContextLoss(() => webglAddon.dispose());
				term.loadAddon(webglAddon);
			} catch {
				/* no GPU: xterm's DOM renderer stays in place */
			}
			term.loadAddon(new unicode11.Unicode11Addon());
			term.unicode.activeVersion = "11";
			fit.fit();
			terminal = term;

			// Subscribe BEFORE starting (review round 1, finding 4): `start` spawns the
			// pty synchronously in main and the child paints immediately, so a
			// subscription registered afterwards loses the first screen (the LazyVim
			// dashboard, the shell banner). The session id is deterministic
			// (`<kind>:<scope>`), so the filter is right before the reply arrives too.
			const expectedId = `${kind}:${scope}`;
			sessionId = expectedId;
			cleanups.push(bridge.onData((payload) => {
				if (!sessionId || payload?.id !== sessionId || typeof payload.data !== "string") return;
				term.write(payload.data);
			}));
			cleanups.push(bridge.onExit((payload) => {
				if (!sessionId || payload?.id !== sessionId) return;
				setStatus(`exited (${payload.code})`);
				term.write(`\r\n\x1b[90m[process exited with code ${payload.code}]\x1b[0m\r\n`);
				onExitRef.current?.(payload.code);
			}));

			const started = await bridge.start({ kind, scope, cols: term.cols, rows: term.rows });
			if (disposed) {
				bridge.kill(started?.id ?? expectedId);
				return;
			}
			if (!started?.ok) {
				sessionId = null;
				setStatus("failed");
				term.write(`\r\n\x1b[31m${started?.error ?? "Could not start the terminal."}\x1b[0m\r\n`);
				return;
			}
			const session = started.id ?? expectedId;
			sessionId = session;
			setStatus(kind === "editor" ? "nvim" : "shell");
			termRef.current = term;

			const dataSubscription = term.onData((data) => bridge.write({ id: session, data }));
			cleanups.push(() => dataSubscription.dispose());
			const resizeSubscription = term.onResize(({ cols, rows }) => bridge.resize({ id: session, cols, rows }));
			cleanups.push(() => resizeSubscription.dispose());

			// Ctrl+/ (and Ctrl+_) cannot be encoded by xterm (see ./keys.ts): the chord
			// dies there and LazyVim's <C-/> terminal toggle never fires. Claim exactly
			// those two chords, write the byte they mean, and let every other key keep
			// xterm's own mapping.
			term.attachCustomKeyEventHandler((event) => {
				// The global dispatcher stands down while a pane has focus
				// (components/code/focus.ts), so the code/session chord is
				// re-dispatched HERE — leaving nvim by keyboard must not
				// require the mouse. The registry stays the one source of truth.
				// xterm hands us keydown AND keyup; the intent decides whether this
				// event toggles (once per press), is swallowed, or belongs to xterm.
				const intent = toggleChordIntent(actionForBinding(eventBinding(event)) === "toggle-code", event);
				if (intent !== "pass") {
					if (intent === "dispatch") window.dispatchEvent(new CustomEvent(kbdEventForAction("toggle-code")));
					return false;
				}
				const bytes = customKeyBytes(event);
				if (bytes === null) return true;
				bridge.write({ id: session, data: bytes });
				return false;
			});

			// Focus ownership: click to focus, DOM focus/blur drive the registry
			// (which releases Electron's menu accelerators and stands the global
			// shortcut dispatcher down).
			const onFocusIn = () => setTerminalFocus(true);
			const onFocusOut = () => releaseTerminalFocus();
			const onClick = () => term.focus();
			host.addEventListener("focusin", onFocusIn);
			host.addEventListener("focusout", onFocusOut);
			host.addEventListener("mousedown", onClick);
			cleanups.push(() => {
				host.removeEventListener("focusin", onFocusIn);
				host.removeEventListener("focusout", onFocusOut);
				host.removeEventListener("mousedown", onClick);
			});

			// Geometry: watch the PANE (the flex child that really changes size), not the
			// xterm host whose box follows the terminal's own content. Debounced, and a
			// fire only reaches `fit()` when the box is measurable — the old code fitted
			// once at mount and swallowed the throw, so the first resize did nothing and
			// no second notification ever came.
			const pane = paneRef.current;
			const measure = () => {
				const target = paneRef.current ?? pane ?? host;
				const box = target.getBoundingClientRect();
				return { width: box.width, height: box.height };
			};
			let retryTimer: ReturnType<typeof setTimeout> | null = null;
			const attempt = () => {
				if (disposed) return;
				try {
					fit.fit();
				} catch (error) {
					// Non-fatal (a hidden pane can measure 0), but never silent again: the
					// swallowed throw is what hid the bug.
					console.warn("code pane: refit failed", error);
				}
			};
			const refit = () => {
				if (disposed) return;
				// A resize notification lands while the layout is still settling, and
				// xterm's fit() returns SILENTLY (no throw) when the box is momentarily
				// unmeasurable — measuring again after layout is what makes the refit
				// stick. Both attempts are idempotent: the second is a no-op when the
				// geometry already matches.
				requestAnimationFrame(attempt);
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = setTimeout(attempt, PANE_RELAYOUT_RETRY_MS);
			};
			cleanups.push(observePaneSize(pane ?? host, measure, refit, { debounceMs: RESIZE_DEBOUNCE_MS, windowTarget: window }));
			cleanups.push(() => {
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = null;
			});

			// The guarantee under the triggers: compare the pane's box with the last one
			// we fitted, and refit when it differs. Covers missed notifications, the
			// sidebar opening, and a window resize the compositor never reports.
			let fittedAgainst = { width: 0, height: 0 };
			const watchdog = setInterval(() => {
				if (disposed) return;
				const size = measure();
				if (!size || !(size.width > 0) || !(size.height > 0)) return;
				if (size.width === fittedAgainst.width && size.height === fittedAgainst.height) return;
				fittedAgainst = { width: size.width, height: size.height };
				attempt();
			}, PANE_WATCHDOG_MS);
			cleanups.push(() => clearInterval(watchdog));

			// Late measurements: the mount-time fit can run before the pane has its
			// final box, and before the Nerd Font is measured.
			const frame = requestAnimationFrame(refit);
			cleanups.push(() => cancelAnimationFrame(frame));
			void document.fonts?.ready.then(refit).catch(() => {});

			// Exactly one pane claims the keyboard at mount (the editor): when both
			// called focus(), whichever booted last won and that was the shell.
			if (autoFocus) term.focus();
		};

		void boot().catch((error: unknown) => {
			if (disposed) return;
			setStatus("failed");
			host.textContent = error instanceof Error ? error.message : String(error);
		});

		return () => {
			disposed = true;
			for (const off of cleanups) {
				try {
					off();
				} catch {
					/* already detached */
				}
			}
			if (sessionId) bridge.kill(sessionId);
			releaseTerminalFocus();
			terminal?.dispose();
			host.replaceChildren();
		};
	}, [kind, scope, autoFocus]);

	return (
		<section ref={paneRef} className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden bg-background", className)} data-testid={`code-pane-${kind}`} aria-label={label}>
			<header className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 text-[11px] uppercase tracking-widest text-muted-foreground">
				<span>{label}</span>
				<span data-testid={`code-status-${kind}`} className="normal-case tracking-normal text-muted-foreground/70">
					{status}
				</span>
			</header>
			<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
		</section>
	);
}
