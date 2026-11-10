/**
 * The coding-workspace prompt segment (src/agent/prompts/shared/35-coding-workspace.md).
 *
 * A tool the model never hears about is a tool it never calls: the segment is
 * what makes "teach me to code" land in the pane instead of staying in chat.
 * It composes for the prober and the teacher (practice keeps its curated
 * shared appendix), so the assertion covers both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

describe("coding-workspace prompt segment", () => {
	it("composes into the teaching prompts with both tools named", () => {
		for (const kind of ["teacher", "prober"] as const) {
			const prompt = composeInstructions(kind);
			assert.ok(prompt.includes("## Coding workspace"), `${kind} carries the doctrine`);
			assert.ok(prompt.includes("write_workspace_file"), `${kind} knows the writing tool`);
			assert.ok(prompt.includes("open_in_editor"), `${kind} knows the opening tool`);
		}
	});

	it("does not leak into the practice agent's curated appendix", () => {
		assert.equal(composeInstructions("practice").includes("## Coding workspace"), false);
	});
});
