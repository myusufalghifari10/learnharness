/**
 * The researcher has NO turn cap (owner ruling 2026-11-12).
 *
 * The old `maxTurns: 12` was the reported failure: three of four production
 * jobs stopped mid-search and returned "the researcher produced no text", and
 * the one that "finished" handed back narration. The cap is gone, so the only
 * stop is the model finishing its brief (or the learner aborting the job).
 *
 * Kept in its own file because it pins a REQUIREMENT change, not a branch:
 * `tests/subagent-cap-synthesis.test.ts` still pins the cap behaviour for the
 * callers that keep one (demo, extraction, submit).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-no-cap-"));
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
const { runResearcherAgent } = await import("../src/agent/subagents/researcher.ts");
const { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");

const searchTool = {
	name: "web_search",
	label: "web_search",
	description: "Search the web.",
	parameters: Type.Object({ query: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "result" }] }),
} as unknown as AgentTool<ReturnType<typeof Type.Object>>;

const BRIEF = "## Summary\n65 questions, 130 minutes.\n\n## Sources\n- Kept: aws.amazon.com";
const toolTurns = (n: number) =>
	Array.from({ length: n }, (_, i) =>
		fauxAssistantMessage([fauxToolCall("web_search", { query: `q${i}` }, { id: `c${i}` })], { stopReason: "toolUse" }),
	);

function engineWith(responses: unknown[]) {
	const faux = createFauxCore({});
	faux.setResponses(responses as never);
	return { faux, engine: { model: faux.getModel(), streamFn: faux.streamSimple } };
}

describe("runSubagent: no maxTurns means no budget stop", () => {
	it("runs past the old 12-turn wall and returns the brief", async () => {
		const { faux, engine } = engineWith([...toolTurns(13), fauxAssistantMessage([fauxText(BRIEF)])]);
		const result = await runSubagent([searchTool], {
			role: "researcher",
			engine,
			systemPrompt: "Write a brief.",
			prompt: "Research the exam.",
			synthesizeOnCap: true,
		});
		assert.equal(faux.state.callCount, 14, "all thirteen tool turns plus the brief ran");
		assert.match(result.text, /## Summary/);
	});

	it("the researcher agent itself passes no cap", async () => {
		// The regression pin for the ruling: eighteen tool turns, then the brief.
		// A reinstated `maxTurns: 12` would cut this at twelve and return "".
		const { faux, engine } = engineWith([...toolTurns(18), fauxAssistantMessage([fauxText(BRIEF)])]);
		const text = await runResearcherAgent("What are the SAA-C03 exam facts?", { engine });
		assert.equal(faux.state.callCount, 19);
		assert.match(text, /## Summary/);
		assert.equal(text.trim(), text);
	});
});
