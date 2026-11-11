/**
 * The step cap is a budget, not a cliff (bug, 2026-11-11).
 *
 * Reported symptom: the teacher spawns a researcher and the result never comes
 * back. Job records show why: three of four research jobs stopped at exactly
 * `steps: 12` (= the researcher's maxTurns) with `error: "the researcher
 * produced no text"`, and the one that "succeeded" returned mid-search
 * narration instead of a brief.
 *
 * Mechanism: `runSubagent` ends the loop when the turn counter reaches
 * `maxTurns`, then takes the LAST assistant message as the deliverable. A run
 * whose twelfth turn is a tool call has no text, so the caller throws; a run
 * whose twelfth turn is narration hands the teacher narration.
 *
 * The fix: with `synthesizeOnCap`, the cap ends the tool phase, every tool is
 * withdrawn, and one final turn writes the deliverable from what was gathered.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-cap-synthesis-"));
const originalEnv = process.env;
process.env = {
	...(originalEnv.NODE_TEST_CONTEXT ? { NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT } : {}),
	NODE_ENV: "test",
	HOME: path.join(scratch, "home"),
	LH_DATA_DIR: path.join(scratch, "data"),
	LH_AUTH_FILE: path.join(scratch, "auth.json"),
};
fs.mkdirSync(path.join(scratch, "home"), { recursive: true });
fs.mkdirSync(path.join(scratch, "data"), { recursive: true });
fs.writeFileSync(path.join(scratch, "auth.json"), "{}");
after(() => {
	process.env = originalEnv;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const { runSubagent } = await import("../src/agent/subagents/pi-run.ts");
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");

/** A tool the fake model can call, so the loop really runs tool turns. */
const searchTool: AgentTool<ReturnType<typeof Type.Object>> = {
	name: "web_search",
	label: "web_search",
	description: "Search the web.",
	parameters: Type.Object({ query: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "result" }] }),
} as unknown as AgentTool<ReturnType<typeof Type.Object>>;

const BRIEF = "## Summary\nThe SAA-C03 exam has 65 questions.\n\n## Sources\n- Kept: aws.amazon.com";

function engineWith(responses: unknown[]) {
	const faux = createFauxCore({});
	faux.setResponses(responses as never);
	return { faux, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}

describe("runSubagent: the step cap", () => {
	it("REPRO before the fix: a run that spends every turn on tools returns no text", async () => {
		// Two tool turns and maxTurns: 2 — the shape every failed job had
		// (twelve tool turns, nothing left for the brief).
		const { faux, engine } = engineWith([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "a" }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("web_search", { query: "b" }, { id: "c2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(BRIEF)]),
		]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			maxTurns: 2,
		});
		assert.equal(faux.state.callCount, 2, "without the option the cap simply ends the run");
		assert.equal(result.text, "", "the deliverable is empty — this is what produced 'no text'");
	});

	it("with synthesizeOnCap: one extra tool-less turn writes the deliverable", async () => {
		const { faux, engine } = engineWith([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "a" }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("web_search", { query: "b" }, { id: "c2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(BRIEF)]),
		]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			maxTurns: 2,
			synthesizeOnCap: true,
		});
		assert.equal(faux.state.callCount, 3, "exactly one synthesis turn");
		assert.match(result.text, /## Summary/);
		assert.match(result.text, /65 questions/);
	});

	it("replaces narration when the cap lands on a talking turn", async () => {
		const { faux, engine } = engineWith([
			fauxAssistantMessage([fauxText("Let me check the Revisions page next.")], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText(BRIEF)]),
		]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			maxTurns: 1,
			synthesizeOnCap: true,
		});
		assert.equal(faux.state.callCount, 2);
		assert.match(result.text, /## Summary/, "the brief wins over mid-run narration");
		assert.equal(result.text.includes("Let me check"), false);
	});

	it("a run that finishes inside the budget takes no extra turn", async () => {
		const { faux, engine } = engineWith([fauxAssistantMessage([fauxText(BRIEF)])]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			maxTurns: 5,
			synthesizeOnCap: true,
		});
		assert.equal(faux.state.callCount, 1, "no synthesis when the model delivered on its own");
		assert.match(result.text, /## Summary/);
	});

	it("a silent synthesis turn still returns the empty text rather than inventing one", async () => {
		const { faux, engine } = engineWith([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "a" }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([]),
		]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			maxTurns: 1,
			synthesizeOnCap: true,
		});
		assert.equal(result.text, "", "the caller's honest 'no text' error still applies");
	});
});
