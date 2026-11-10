/**
 * /code without the desktop bridge (F9).
 *
 * A browser tab has no `window.lh.code`, so the view must say so plainly and
 * keep the rest of the app working. The notice is rendered here directly (it
 * is the SSR-visible half of CodeView); the second test pins the wiring so the
 * notice cannot be dropped from the view and the panes cannot render without a
 * bridge.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeDesktopNotice } from "../components/code/desktop-notice.tsx";

describe("coding view without the desktop bridge", () => {
	it("renders the desktop-only notice", () => {
		const html = renderToStaticMarkup(<CodeDesktopNotice />);
		assert.match(html, /runs inside the LearnHarness desktop app/);
		assert.match(html, /data-testid="code-bridge-notice"/);
	});

	it("CodeView gates the panes on window.lh.code and falls back to the notice", () => {
		const source = readFileSync(new URL("../components/code-view.tsx", import.meta.url), "utf8");
		assert.match(source, /window\.lh\?\.code/, "the bridge capability is detected");
		assert.match(source, /<CodeGate bridge=\{hasBridge\}>/, "the no-bridge branch is the gate (the notice itself is render-tested in code-gate.test.tsx)");
		assert.match(source, /<TerminalPane kind="editor"/, "the editor pane is the bridge branch");
		assert.match(source, /<TerminalPane kind="shell"/, "the shell pane is the bridge branch");
	});
});
