/**
 * Ask while a question is open (owner 2026-11-12, docs/features/ask-while-asking.md).
 *
 * The learner can send a follow-up INSTEAD of answering: the pending question
 * call closes with a DEFERRAL tool result (never a graded answer), the model
 * answers the doubt and re-issues the question, and the answer path keeps
 * working because the re-issued question is a fresh, dangling call.
 *
 * The shape pins here: the input refuses to touch anything but a dangling
 * question, the append is exactly one deferral result, its model-facing text
 * carries the re-ask obligation, and the request-cause fold still reads the
 * doubt as LEARNER input.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-interject-"));
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

const { inputAppends, parseChatInput } = await import("../src/core/input-events.ts");
const {
	danglingQuestionOf,
	hasUnresolvedQuestion,
	isQuestionInterjection,
	nativeInputCause,
	newInterjectionResult,
	pendingQuestionOf,
} = await import("../src/core/native-messages.ts");
const { questionInputFingerprint } = await import("../src/core/question-core.ts");

const QUESTION_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
};

/** A record that ends on a dangling question call (the dock's state). */
function recordWithPendingQuestion(): LhMessage[] {
	return [
		{ id: "u1", role: "user", content: "teach me the solar system", timestamp: 1 },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "quiz", arguments: QUESTION_INPUT }],
			stopReason: "toolUse",
			timestamp: 2,
		},
	] as unknown as LhMessage[];
}

describe("interject input: parse", () => {
	it("accepts a doubt aimed at a call", () => {
		assert.deepEqual(parseChatInput({ type: "interject", toolCallId: "call-1", text: "why not Venus?" }), {
			type: "interject",
			toolCallId: "call-1",
			text: "why not Venus?",
		});
	});

	it("refuses an empty doubt or a missing call id", () => {
		assert.throws(() => parseChatInput({ type: "interject", toolCallId: "call-1", text: "   " }), /non-empty text/);
		assert.throws(() => parseChatInput({ type: "interject", text: "why?" }), /toolCallId/);
	});
});

describe("interject input: appends", () => {
	it("closes the pending question with exactly ONE deferral result", () => {
		const record = { messages: recordWithPendingQuestion() };
		assert.ok(hasUnresolvedQuestion(record.messages), "the fixture really is pending");
		const appends = inputAppends(record, { type: "interject", toolCallId: "call-1", text: "why not Venus?" });
		assert.equal(appends.length, 1);
		const result = appends[0]!;
		assert.equal(result.role, "toolResult");
		assert.equal((result as { toolCallId?: string }).toolCallId, "call-1");
		assert.equal((result as { toolName?: string }).toolName, "quiz");
		assert.equal((result as { isError?: boolean }).isError, false);
		const details = (result as { details?: unknown }).details;
		assert.ok(isQuestionInterjection(details));
		assert.equal(details.text, "why not Venus?");
		assert.equal(details.questionText, QUESTION_INPUT.question);
		// The question is no longer pending — the dock closes, the model reacts.
		assert.equal(hasUnresolvedQuestion([...record.messages, ...appends]), false);
		assert.equal(danglingQuestionOf([...record.messages, ...appends]), null);
	});

	it("tells the model it is a doubt and obliges a re-ask", () => {
		const appends = inputAppends(
			{ messages: recordWithPendingQuestion() },
			{ type: "interject", toolCallId: "call-1", text: "why not Venus?" },
		);
		const text = (appends[0] as { content: Array<{ type: string; text: string }> }).content[0]!.text;
		assert.match(text, /did NOT answer/);
		assert.match(text, /why not Venus\?/);
		assert.match(text, /RE-ISSUE the question/);
	});

	it("refuses a stale or absent pending question", () => {
		assert.throws(
			() => inputAppends({ messages: recordWithPendingQuestion() }, { type: "interject", toolCallId: "call-9", text: "why?" }),
			/targets no pending question call/,
		);
		// Already answered → no dangling call to interrupt.
		const answered = [...recordWithPendingQuestion(), ...inputAppends(
			{ messages: recordWithPendingQuestion() },
			{ type: "interject", toolCallId: "call-1", text: "why?" },
		)];
		assert.throws(
			() => inputAppends({ messages: answered }, { type: "interject", toolCallId: "call-1", text: "again?" }),
			/targets no pending question call/,
		);
	});

	it("a second interject needs the re-issued call (unlimited doubts, one per call)", () => {
		const first = inputAppends(
			{ messages: recordWithPendingQuestion() },
			{ type: "interject", toolCallId: "call-1", text: "why?" },
		);
		const reissued = [
			...recordWithPendingQuestion(),
			...first,
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-2", name: "quiz", arguments: QUESTION_INPUT }],
				stopReason: "toolUse",
				timestamp: 4,
			},
		] as unknown as LhMessage[];
		const second = inputAppends({ messages: reissued }, { type: "interject", toolCallId: "call-2", text: "and now?" });
		assert.equal(second.length, 1);
		assert.equal((second[0] as { toolCallId?: string }).toolCallId, "call-2");
	});
});

describe("interject input: the request-cause fold", () => {
	it("counts as LEARNER input, never background noise", () => {
		const result = newInterjectionResult("call-1", "quiz", "why?", QUESTION_INPUT.question);
		assert.equal(nativeInputCause(result, recordWithPendingQuestion()), "learner");
	});
});

describe("the question fingerprint (draft carry)", () => {
	it("identical questions match across key order and whitespace", () => {
		const a = questionInputFingerprint(QUESTION_INPUT);
		const b = questionInputFingerprint({
			explanation: "  Mercury   is the innermost planet. ",
			correctAnswer: "Mercury",
			options: QUESTION_INPUT.options,
			question: QUESTION_INPUT.question,
		});
		assert.equal(a, b);
	});

	it("a changed question does not match", () => {
		assert.notEqual(
			questionInputFingerprint(QUESTION_INPUT),
			questionInputFingerprint({ ...QUESTION_INPUT, question: "Which planet is farthest?" }),
		);
		assert.notEqual(
			questionInputFingerprint(QUESTION_INPUT),
			questionInputFingerprint({ ...QUESTION_INPUT, options: [{ label: "Venus" }, { label: "Mercury" }] }),
		);
	});

	it("the pending dock scan survives an interjection result in the record", () => {
		const record = [
			...recordWithPendingQuestion(),
			...inputAppends({ messages: recordWithPendingQuestion() }, { type: "interject", toolCallId: "call-1", text: "why?" }),
		];
		assert.equal(pendingQuestionOf(record as LhMessage[]), null, "the dock closes while the model explains");
	});
});
