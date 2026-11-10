/**
 * The /code bridge gate (F9 + review round 1 finding 2).
 *
 * A desktop window must not flash the "runs inside the desktop app" notice
 * while the bridge probe is still pending, and a browser tab must not render
 * xterm panes it cannot feed. Both are decided by CodeGate, so the assertions
 * here are about RENDERED MARKUP, not about the view's source text.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeGate } from "../components/code/code-gate.tsx";
import { CodeDesktopNotice } from "../components/code/desktop-notice.tsx";

const NOTICE = /runs inside the LearnHarness desktop app/;

describe("coding view bridge gate", () => {
	it("renders the desktop-only notice statically (what a browser tab sees)", () => {
		const html = renderToStaticMarkup(<CodeDesktopNotice />);
		assert.match(html, NOTICE);
		assert.match(html, /data-testid="code-bridge-notice"/);
	});

	it("the SSR / first-paint state is a neutral placeholder, never the notice", () => {
		for (const state of [null, undefined]) {
			const html = renderToStaticMarkup(
				<CodeGate bridge={state}>
					<span>panes</span>
				</CodeGate>,
			);
			assert.match(html, /data-testid="code-pending"/, `bridge=${String(state)} shows the placeholder`);
			assert.doesNotMatch(html, NOTICE, `bridge=${String(state)} must not claim the bridge is missing`);
			assert.doesNotMatch(html, /panes/, "panes are not mounted before the probe answers");
		}
	});

	it("a measured-absent bridge shows the notice and no panes", () => {
		const html = renderToStaticMarkup(
			<CodeGate bridge={false}>
				<span>panes</span>
			</CodeGate>,
		);
		assert.match(html, NOTICE);
		assert.doesNotMatch(html, /panes/);
	});

	it("a present bridge renders the panes and no notice", () => {
		const html = renderToStaticMarkup(
			<CodeGate bridge>
				<span>panes</span>
			</CodeGate>,
		);
		assert.match(html, /panes/);
		assert.doesNotMatch(html, NOTICE);
		assert.doesNotMatch(html, /code-pending/);
	});
});
