/**
 * Pane geometry watching (2026-11-11, acceptance F5).
 *
 * Why this exists: the pane never re-fit after mount, so a window resize left
 * the pty at its launch geometry (98x26 while the pane was 1400 px wide, and a
 * shrinking window clipped the canvas at 1483 px). The old code observed the
 * xterm HOST div, whose size follows the terminal's own content, and the single
 * mount-time `fit()` was the only measurement ever taken.
 *
 * This module owns the trigger, not the rendering: it watches the element that
 * actually changes size (the pane), coalesces a burst of notifications into one
 * call (xterm asks embedders to debounce), skips a size that is not measurable
 * (hidden pane, sidebar animation, `height: auto`), and disposes cleanly. The
 * component passes a `measure` callback so nothing here touches the DOM and the
 * whole rule is testable with fakes.
 */

export type PaneSize = { width: number; height: number };

type ResizeObserverLike = { observe(target: unknown): void; disconnect(): void };

type ResizeObserverCtorLike = new (callback: () => void) => ResizeObserverLike;

type WindowLike = {
	addEventListener(type: "resize", listener: () => void): void;
	removeEventListener(type: "resize", listener: () => void): void;
};

export type ObservePaneSizeOptions = {
	/** Coalescing window; xterm's typings ask embedders to debounce resize work. */
	debounceMs?: number;
	/** ResizeObserver constructor (injected for tests). */
	createObserver?: ResizeObserverCtorLike | null;
	/** Window-like target for the `resize` event (injected for tests). */
	windowTarget?: WindowLike | null;
};

export const PANE_RESIZE_DEBOUNCE_MS = 120;

/**
 * Watch `element` for size changes (plus window resizes) and call `onFire` once
 * per settled burst, but only when `measure()` reports a measurable box.
 * Returns the disposer; after it runs nothing fires again.
 */
export function observePaneSize(
	element: unknown,
	measure: () => PaneSize | null,
	onFire: () => void,
	options: ObservePaneSizeOptions = {},
): () => void {
	const debounceMs = options.debounceMs ?? PANE_RESIZE_DEBOUNCE_MS;
	const createObserver =
		options.createObserver === undefined
			? (typeof ResizeObserver === "undefined" ? null : (ResizeObserver as unknown as ResizeObserverCtorLike))
			: options.createObserver;
	const windowTarget = options.windowTarget === undefined ? null : options.windowTarget;

	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const fire = () => {
		if (disposed) return;
		const size = measure();
		if (!size || !(size.width > 0) || !(size.height > 0)) return;
		onFire();
	};

	const wake = () => {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fire();
		}, debounceMs);
	};

	let observer: ResizeObserverLike | null = null;
	if (element && createObserver) {
		observer = new createObserver(wake);
		observer.observe(element);
	}
	windowTarget?.addEventListener("resize", wake);

	return () => {
		disposed = true;
		if (timer) clearTimeout(timer);
		timer = null;
		observer?.disconnect();
		observer = null;
		windowTarget?.removeEventListener("resize", wake);
	};
}
