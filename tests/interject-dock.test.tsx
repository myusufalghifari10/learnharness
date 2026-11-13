/**
 * Ask-while-asking, the dock surface (owner 2026-11-12).
 *
 * docs/features/ask-while-asking.md, acceptance A6/A7:
 *  - the mode toggle starts on `Answer` and the answer controls are what
 *    the learner sees;
 *  - `Ask first` swaps in the doubt field and hides the answer controls;
 *  - switching back restores the answer controls AND the typed answer;
 *  - the collapsed strip carries its own doubt box underneath;
 *  - the transcript's doubt card renders the question and the doubt, with no
 *    grading anywhere.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import { QuestionDoubtCard } from "../components/answered-card.tsx";
import type { QuestionInterjection } from "../src/core/native-messages.ts";
import type { QuizToolInput } from "../src/core/question-core.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const QUIZ_INPUT: QuizToolInput = {
	question: "Which planet is closest to the sun?",
	options: [
		{ label: "Venus", value: "venus" },
		{ label: "Mercury", value: "mercury" },
	],
	correctAnswer: "mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

/** The contenteditable typing seam the other dock tests use. */
function type(host: Element, selector: string, text: string) {
	const editor = host.querySelector<HTMLElement>(selector)!;
	assert.ok(editor, `missing ${selector}`);
	editor.textContent = text;
	editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("the dock starts in ANSWER mode; the toggle reaches ASK and comes back with the draft", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const interjected: string[] = [];
	try {
		await act(async () =>
			root.render(
				<QuestionDock
					toolName="quiz"
					toolCallId="call-1"
					input={QUIZ_INPUT}
					expanded
					onExpand={() => {}}
					onSubmit={() => {}}
					onInterject={(text) => interjected.push(text)}
					dictationClaim={false}
				/>,
			),
		);

		assert.equal(host.querySelector('[data-testid="dock-mode-answer"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(host.querySelector('[data-testid="dock-mode-ask"]')!.getAttribute("aria-pressed"), "false");
		assert.ok(host.querySelector('[data-testid="thinking-field"]'), "answer controls are the default surface");
		assert.equal(host.querySelector('[data-testid="dock-ask-expanded"]'), null);

		// Type an answer, then ask instead.
		await act(async () => type(host, '[data-testid="thinking-field"] [data-file-path-input]', "Mercury because it is innermost"));
		await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-mode-ask"]')!.click());

		assert.equal(host.querySelector('[data-testid="dock-mode-ask"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(host.querySelector('[data-testid="thinking-field"]'), null, "answer controls are hidden in ask mode");
		assert.ok(host.querySelector('[data-testid="dock-ask-expanded"]'), "the doubt field replaces them");
		const text = host.textContent ?? "";
		assert.ok(text.includes("Which planet is closest to the sun?"), "the question stays visible while asking");

		// Send the doubt.
		await act(async () => type(host, '[data-testid="dock-ask-expanded"] [data-file-path-input]', "why is Venus not the closest?"));
		const send = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Send question"))!;
		await act(async () => send.click());
		assert.deepEqual(interjected, ["why is Venus not the closest?"]);

		// Change of mind: back to answering, with the typed answer intact.
		await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="dock-mode-answer"]')!.click());
		assert.ok(host.querySelector('[data-testid="thinking-field"]'), "answer controls return");
		assert.equal(host.querySelector('[data-testid="dock-ask-expanded"]'), null);
		assert.equal(
			host.querySelector('[data-testid="thinking-field"] [data-file-path-input]')!.textContent,
			"Mercury because it is innermost",
			"the typed answer survived the round trip",
		);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

/**
 * Structural pin, static render: mounting the full dock COLLAPSED under
 * react-dom/root in linkedom loops (a React 19 effect + linkedom interaction;
 * the app renders collapsed docks fine — this is a harness limit, not the
 * product). The interactive lifecycle is covered by the expanded test above,
 * which sends a doubt through the SAME onInterject seam.
 */
test("collapsed: the doubt box renders under the slim strip", () => {
	const html = renderToStaticMarkup(
		<QuestionDock
			toolName="quiz"
			toolCallId="call-1"
			input={QUIZ_INPUT}
			expanded={false}
			onExpand={() => {}}
			onSubmit={() => {}}
			onInterject={() => {}}
			dictationClaim={false}
		/>,
	);
	const bar = html.indexOf('data-testid="question-dock-bar"');
	const ask = html.indexOf('data-testid="dock-ask-collapsed"');
	assert.ok(bar >= 0, "the slim strip renders");
	assert.ok(ask >= 0, "the doubt box renders");
	assert.ok(ask > bar, "it sits UNDER the strip, not beside it");
	assert.ok(html.includes("Ask about this question"), "with its own placeholder");
});

test("the doubt card names the question and the doubt, with no verdict", async () => {
	const doubt: QuestionInterjection = {
		interjection: true,
		text: "wait, why is Venus not the closest?",
		questionText: "Which planet is closest to the sun?",
		tool: "quiz",
	};
	const html = renderToStaticMarkup(<QuestionDoubtCard doubt={doubt} />);
	assert.ok(html.includes('data-testid="question-doubt-card"'));
	assert.ok(html.includes("asked instead"));
	assert.ok(html.includes("Which planet is closest to the sun?"), "the question it was about stays visible");
	assert.ok(html.includes("wait, why is Venus not the closest?"), "the doubt is recorded");
	assert.ok(!/correct|incorrect|didn&apos;t know/i.test(html), "a doubt is never graded");
});
