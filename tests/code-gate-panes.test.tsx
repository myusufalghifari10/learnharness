/**
 * F4 (docs/coding-pane/review-2.md): the source-text pin in
 * tests/code-view.test.tsx stays green if the panes render nothing. This file
 * pins the missing behaviour at the cheapest real seam: CodeGate must pass its
 * children through untouched (two panes → two rendered panes), so a
 * `bridge === true` branch that swallowed or emptied its subtree fails.
 *
 * Beside code-gate.test.tsx because the session gate refuses edits to an
 * existing test file.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeGate } from "../components/code/code-gate.tsx";

describe("F4 — the bridge-present branch renders every pane it is given", () => {
	it("renders both pane children of a present bridge and no notice", () => {
		const html = renderToStaticMarkup(
			<CodeGate bridge>
				<div data-testid="pane-editor">editor</div>
				<div data-testid="pane-shell">shell</div>
			</CodeGate>,
		);
		const panes = html.match(/data-testid="pane-/g) ?? [];
		assert.equal(panes.length, 2, "both panes survive the gate; an empty branch would render none");
		assert.match(html, /data-testid="pane-editor"/);
		assert.match(html, /data-testid="pane-shell"/);
		assert.doesNotMatch(html, /runs inside the LearnHarness desktop app/);
		assert.doesNotMatch(html, /data-testid="code-pending"/);
	});

	it("boundary states still drop the panes completely (no half-mounted workspace)", () => {
		for (const bridge of [null, undefined, false] as const) {
			const html = renderToStaticMarkup(
				<CodeGate bridge={bridge}>
					<div data-testid="pane-editor">editor</div>
					<div data-testid="pane-shell">shell</div>
				</CodeGate>,
			);
			assert.equal((html.match(/data-testid="pane-/g) ?? []).length, 0, `bridge=${String(bridge)} renders no panes`);
		}
	});

	it("the view really feeds it two panes, both inside the gate", () => {
		const source = readFileSync(new URL("../components/code-view.tsx", import.meta.url), "utf8");
		const gate = source.slice(source.indexOf("<CodeGate"), source.indexOf("</CodeGate>"));
		const panes = gate.match(/<TerminalPane /g) ?? [];
		assert.equal(panes.length, 2, "an added or lost pane is a layout change, not a silent pass");
		assert.equal((gate.match(/\bkind="editor"/g) ?? []).length, 1);
		assert.equal((gate.match(/\bkind="shell"/g) ?? []).length, 1);
	});
});
