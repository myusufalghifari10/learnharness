/**
 * Ask-while-asking, end to end (owner 2026-11-12).
 *
 * docs/features/ask-while-asking.md, acceptance A4: the full loop with zero
 * tokens — a scripted teacher poses a quiz, the learner sends a DOUBT instead
 * of an answer (the `interject` input event), the call closes with a deferral,
 * the model explains and re-issues the question, and the ANSWER still lands as
 * the new call's tool result so the lesson continues.
 *
 * Also pinned here: the follow-up reaches the model as a doubt (not an answer),
 * a completed turn with no question left never hangs the session, and the
 * transcript renders the doubt card instead of the graded one.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { isQuestionInterjection, pendingQuestionOf } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { PATHS } from "../config.ts";

// The key-presence turn gate (same seam chat-flow pins): the chat's model pin
// exists, so the turn gate needs a provider key present in the process.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

type Captured = { messages: string };

function scripted(steps: (seen: Captured[]) => FauxResponseStep[]): { engine: PiEngine; seen: Captured[] } {
	const seen: Captured[] = [];
	const faux = createFauxCore({});
	faux.setResponses(steps(seen));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, seen };
}

function agentFactory(engine: PiEngine): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

function gradedAnswer(values: string[]) {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: "call",
		kind: "quiz",
		question: QUIZ_INPUT.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ_INPUT.correctAnswer, options).indices,
		explanation: QUIZ_INPUT.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

/** POST + drain the turn's own wire (the ack path of CONNECTION DIET B). */
async function runTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<Response> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) return ack;
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	return ack;
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function createConfiguredChat(title: string) {
	const chat = chatStore.createChat(title);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	createdChats.push(chat.id);
	return chat;
}

/** Step 1 poses the question; step 2 explains the doubt and re-issues it;
 *  step 3 is the lesson continuing after the answer. */
function doubtThenReask(seen: Captured[]): FauxResponseStep[] {
	return [
		(context) => {
			seen.push({ messages: JSON.stringify(context.messages) });
			return fauxAssistantMessage(
				[fauxThinking("Probe first."), fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			seen.push({ messages: JSON.stringify(context.messages) });
			return fauxAssistantMessage(
				[
					fauxText("Venus is farther out than Mercury — closest means smallest orbit, not hottest."),
					fauxToolCall("quiz", QUIZ_INPUT, { id: "call-2" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			seen.push({ messages: JSON.stringify(context.messages) });
			return fauxAssistantMessage([fauxText("Right — Mercury, the innermost orbit.")]);
		},
	];
}

describe("ask-while-asking: the full loop", () => {
	it("a doubt closes the question, the model explains + re-asks, the answer still lands", async () => {
		const { engine, seen } = scripted(doubtThenReask);
		const chat = createConfiguredChat("Test: interjection loop");

		// ── Turn 1: the question arrives pending ──
		await runTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		assert.equal(pendingQuestionOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-1");

		// ── Turn 2: the DOUBT, not an answer ──
		await runTurn(
			post(chat.id, { type: "interject", toolCallId: "call-1", text: "wait, why is Venus not the closest?" }),
			agentFactory(engine),
		);

		const afterDoubt = chatStore.getChat(chat.id)!.messages;
		const deferral = afterDoubt.find(
			(m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-1",
		) as { details?: unknown; isError?: boolean } | undefined;
		assert.ok(deferral, "the interjection persisted as the call's tool result");
		assert.equal(deferral.isError, false);
		assert.ok(isQuestionInterjection(deferral.details), "it is a deferral, never QuestionAnswerData");
		assert.equal((deferral.details as { text: string }).text, "wait, why is Venus not the closest?");

		// The model SAW it as a doubt: the doubt text is in its context and the
		// deferral text carries the re-ask obligation.
		assert.match(seen[1]!.messages, /why is Venus not the closest\?/);
		assert.match(seen[1]!.messages, /did NOT answer/);
		assert.match(seen[1]!.messages, /RE-ISSUE the question/);

		// The re-issued question is the new pending dock.
		assert.equal(pendingQuestionOf(afterDoubt)?.toolCallId, "call-2");

		// ── Turn 3: the answer still works, against the NEW call ──
		await runTurn(
			post(chat.id, { type: "answer", toolCallId: "call-2", answer: gradedAnswer(["Mercury"]) }),
			agentFactory(engine),
		);

		const final = chatStore.getChat(chat.id)!.messages;
		const answer = final.find(
			(m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call-2",
		) as { details?: { kind?: string; correct?: boolean } } | undefined;
		assert.ok(answer, "the answer landed as call-2's tool result");
		assert.equal(answer.details?.kind, "quiz");
		assert.equal(answer.details?.correct, true);
		assert.equal(pendingQuestionOf(final), null, "no question is left dangling");
		const last = final[final.length - 1]!;
		assert.equal(last.role, "assistant");
		assert.match(JSON.stringify(last.content), /innermost orbit/);

		// The transcript renders the doubt card for that slot (not a graded card).
		const parts = projectView(final).flatMap((m) => m.parts ?? []);
		const doubtPart = parts.find((p) => (p as { toolCallId?: string }).toolCallId === "call-1");
		assert.ok(doubtPart, "the interrupted question keeps its part");
		assert.equal((doubtPart as { state?: string }).state, "output-available");
		assert.ok(isQuestionInterjection((doubtPart as { output?: unknown }).output));
	});

	it("an answer aimed at the closed call is refused (no double-answer, no silent turn)", async () => {
		const { engine } = scripted(doubtThenReask);
		const chat = createConfiguredChat("Test: interjection stale answer");
		await runTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		await runTurn(
			post(chat.id, { type: "interject", toolCallId: "call-1", text: "hmm, why Venus?" }),
			agentFactory(engine),
		);
		const before = JSON.stringify(chatStore.getChat(chat.id)!.messages);

		const res = await runTurn(
			post(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(["Mercury"]) }),
			agentFactory(engine),
		);
		assert.equal(res.status, 400);
		assert.match(await res.text(), /targets no pending question call/);
		assert.equal(JSON.stringify(chatStore.getChat(chat.id)!.messages), before, "a refused input appends nothing");
	});
});

describe("ask-while-asking: a model that forgets to re-ask", () => {
	it("leaves NO fake pending question and does not hang the session", async () => {
		const { engine } = scripted((seen) => [
			(context) => {
				seen.push({ messages: JSON.stringify(context.messages) });
				return fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })], { stopReason: "toolUse" });
			},
			(context) => {
				seen.push({ messages: JSON.stringify(context.messages) });
				return fauxAssistantMessage([fauxText("Venus is farther from the sun than Mercury.")]);
			},
		]);
		const chat = createConfiguredChat("Test: interjection no re-ask");
		await runTurn(post(chat.id, { type: "text", text: "teach me the solar system" }), agentFactory(engine));
		await runTurn(
			post(chat.id, { type: "interject", toolCallId: "call-1", text: "why is Venus not the closest?" }),
			agentFactory(engine),
		);

		const record = chatStore.getChat(chat.id)!.messages;
		assert.equal(pendingQuestionOf(record), null, "nothing pretends a question is still pending");
		const last = record[record.length - 1]!;
		assert.equal(last.role, "assistant", "the explanation is the tail — the composer returns");

		// The composer is free again: a plain follow-up runs a normal turn.
		const res = await runTurn(post(chat.id, { type: "text", text: "ok, give me the question back" }), agentFactory(engine));
		assert.equal(res.status, 200);
	});
});
