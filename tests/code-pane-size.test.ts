/**
 * The pane refits when it actually changes size (acceptance F5).
 *
 * The defect: the old watcher observed the xterm host (whose box follows the
 * terminal's own content) and swallowed the thrown fit, so one notification
 * failed silently and no second one ever arrived — the pty stayed at 98x26 while
 * the pane was 1400 px wide, and a shrinking window clipped the canvas.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observePaneSize } from "../components/code/pane-size.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake ResizeObserver: records the observed target and lets a test fire it. */
function fakeObserver() {
	const state: { targets: unknown[]; fired: number; disconnected: number; callback: (() => void) | null } = {
		targets: [],
		fired: 0,
		disconnected: 0,
		callback: null,
	};
	class Observer {
		constructor(callback: () => void) {
			state.callback = callback;
		}
		observe(target: unknown) {
			state.targets.push(target);
		}
		disconnect() {
			state.disconnected += 1;
		}
	}
	const fire = () => {
		state.fired += 1;
		state.callback?.();
	};
	return { state, Observer, fire };
}

/** Fake window: records the listener so a test can fire a resize. */
function fakeWindow() {
	let listener: (() => void) | null = null;
	return {
		target: {
			addEventListener(_type: "resize", cb: () => void) {
				listener = cb;
			},
			removeEventListener(_type: "resize", cb: () => void) {
				if (listener === cb) listener = null;
			},
		},
		fire: () => listener?.(),
		get attached() {
			return listener !== null;
		},
	};
}

describe("observePaneSize — the refit trigger", () => {
	it("coalesces a burst of notifications into one call, then fires again for a later burst", async () => {
		const { Observer, state, fire } = fakeObserver();
		const pane = { id: "pane" };
		let calls = 0;
		observePaneSize(pane, () => ({ width: 1400, height: 542 }), () => { calls += 1; }, {
			debounceMs: 5,
			createObserver: Observer,
		});
		assert.deepEqual(state.targets, [pane], "observes the pane element it was handed, not a host div");

		fire();
		fire();
		fire();
		assert.equal(calls, 0, "nothing fires before the debounce window closes");
		await sleep(25);
		assert.equal(calls, 1, "three notifications in one burst collapse into one fit");

		fire();
		await sleep(25);
		assert.equal(calls, 2, "a later resize is a new burst and must fit again");
	});

	it("a window resize wakes it too, and coalesces with an observer burst", async () => {
		const { Observer, fire } = fakeObserver();
		const win = fakeWindow();
		let calls = 0;
		observePaneSize({}, () => ({ width: 900, height: 400 }), () => { calls += 1; }, {
			debounceMs: 5,
			createObserver: Observer,
			windowTarget: win.target,
		});
		assert.equal(win.attached, true, "the window listener is registered");
		fire();
		win.fire();
		await sleep(25);
		assert.equal(calls, 1, "one burst across both sources = one fit");
	});

	it("skips an unmeasurable box (hidden pane, sidebar animation, height:auto)", async () => {
		const { Observer, fire } = fakeObserver();
		let calls = 0;
		let box: { width: number; height: number } | null = null;
		observePaneSize({}, () => box, () => { calls += 1; }, { debounceMs: 5, createObserver: Observer });

		fire();
		await sleep(25);
		assert.equal(calls, 0, "null measurement does nothing");

		box = { width: 0, height: 400 };
		fire();
		await sleep(25);
		assert.equal(calls, 0, "zero width does nothing");

		box = { width: 400, height: 0 };
		fire();
		await sleep(25);
		assert.equal(calls, 0, "zero height does nothing");

		box = { width: 400, height: 400 };
		fire();
		await sleep(25);
		assert.equal(calls, 1, "a measurable box fires");
	});

	it("dispose disconnects the observer, removes the listener and cancels a pending fit", async () => {
		const { Observer, state, fire } = fakeObserver();
		const win = fakeWindow();
		let calls = 0;
		const dispose = observePaneSize({}, () => ({ width: 800, height: 500 }), () => { calls += 1; }, {
			debounceMs: 5,
			createObserver: Observer,
			windowTarget: win.target,
		});

		fire(); // pending, not yet fired
		dispose();
		await sleep(25);
		assert.equal(calls, 0, "a pending fit is cancelled by dispose");
		assert.equal(state.disconnected, 1, "the observer is disconnected");
		assert.equal(win.attached, false, "the window listener is removed");

		fire();
		win.fire();
		await sleep(25);
		assert.equal(calls, 0, "nothing fires after dispose");
	});

	it("does not observe anything when no observer constructor is available (SSR-safe)", async () => {
		let calls = 0;
		const dispose = observePaneSize({}, () => ({ width: 800, height: 500 }), () => { calls += 1; }, {
			debounceMs: 5,
			createObserver: null,
		});
		await sleep(25);
		assert.equal(calls, 0);
		dispose();
	});
});
