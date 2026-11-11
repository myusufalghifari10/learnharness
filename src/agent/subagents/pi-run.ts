import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { APP_IDENTITY, piEngineFor, type PiEngine } from "../models.ts";
import { usageWasAdmitted } from "../subscription-request-cycle.ts";
import { providerEventObserver } from "../provider-events.ts";
import { backgroundCaptureStream, createBackgroundCapture } from "../background-capture.ts";
import type { ModelRole } from "../../../config.ts";

/**
 * The shared sub-agent runner (docs/archive/pi-engine-swap.md §6): one helper every
 * background agent (researcher, demo-builder, visual-maker, extractor,
 * auditor) runs on — a stateless pi Agent built per call, driven to
 * completion, with the seams the job runner and the money channel need.
 *
 * Error semantics mirror the old ToolLoopAgent.generate: provider/loop
 * failures THROW (pi encodes them in the stream; this helper surfaces
 * them), and an abort throws an AbortError so every existing
 * `signal.aborted` early-return keeps working unchanged.
 */

export interface SubagentRunOptions {
	/** The role whose engine (model + thinking level) this run uses. */
	role: ModelRole;
	/** Test seam: a scripted engine replaces the role's production one. */
	engine?: PiEngine;
	systemPrompt: string;
	/** Initial transcript (continuation semantics: ends user / toolResult). */
	messages?: AgentMessage[];
	/** Fresh-run prompt text (mutually exclusive with a continuation). */
	prompt?: string;
	/** Max model calls (the old stepCountIs safety net). */
	maxTurns: number;
	/** Abort mid-model-call (the real-kill semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per model request. */
	onUsage?: (usage: Usage) => void;
	/** Activity line per tool execution (job record progress). */
	onToolStart?: (toolName: string, args: unknown) => void;
	/** Per completed assistant message (extraction's step log). */
	onAssistantMessage?: (message: AssistantMessage, step: number) => void;
	/** Extra stop rule (extractor: stop after a clean submit). */
	shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
	/** Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream
	 *  events append to data/debug/provider-events/<chatId>.jsonl (context
	 *  "job:<role>"). Absent or env-off → no observer.
	 *  Also identifies the source in opt-in LH_BACKGROUND_CAPTURE captures. */
	chatId?: string;
	/** Cap behaviour (2026-11-11): a run that stops on `maxTurns` used to hand
	 *  its caller whatever the model was doing at that moment — mid-search
	 *  narration, or nothing at all (3 of 4 researcher jobs came back as "the
	 *  researcher produced no text"). With this on, the cap ends the tool phase,
	 *  every tool is withdrawn, and ONE more turn writes the deliverable from
	 *  what was already gathered. The cap stays a budget, not a cliff. */
	synthesizeOnCap?: boolean;
	/** The instruction for that last turn (defaults to the shared wording). */
	synthesisPrompt?: string;
}

export interface SubagentRunResult {
	/** The messages this run added (assistant + tool results). */
	newMessages: AgentMessage[];
	/** The final assistant text (the deliverable). */
	text: string;
}

/** The last-turn instruction when the step budget runs out (see
 *  SubagentRunOptions.synthesizeOnCap). It says the two things that matter: no
 *  tools are left, and the DELIVERABLE — not a plan — is the output. */
const DEFAULT_SYNTHESIS_PROMPT =
	"You have reached the step limit, so this is the last turn and every tool has been withdrawn. Write your final deliverable NOW, in the required format, using only the material you already have. Do not describe what you would do next, do not apologise, and do not ask questions.";

export function subagentEngine(role: ModelRole, override?: PiEngine): PiEngine {
	// BYOK (owner, 2026-09-22): no factory pins — the override is the only
	// real path (the runner injects settings-resolved engines); a missed
	// injection hits the honest thrower in models.ts instead of a guess.
	return override ?? piEngineFor(role);
}

export async function runSubagent(tools: AgentTool<any, any>[], opts: SubagentRunOptions): Promise<SubagentRunResult> {
	const engine = subagentEngine(opts.role, opts.engine);
	let turns = 0;
	// Debug recorder (owner, 2026-10-04): raw provider events per job run.
	const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, `job:${opts.role}`) : undefined;
	const sessionId = randomUUID();
	const capture = createBackgroundCapture({ role: opts.role, runId: sessionId, sourceId: opts.chatId });
	const agent = new Agent({
		identity: APP_IDENTITY,
		// One unsaved conversation per invocation, stable through every turn.
		sessionId,
		initialState: {
			systemPrompt: opts.systemPrompt,
			model: engine.model,
			thinkingLevel: engine.level,
			tools,
			messages: opts.messages ?? [],
		},
		streamFn: backgroundCaptureStream(engine.streamFn, capture),
		...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
		// 0.87.1: shouldStopAfterTurn → finishTurn (same call point; "end"
		// exits before the steering poll, exactly the old boolean-true).
		finishTurn: (turn) => {
			turns++;
			// `capped` is sticky: it records WHY the loop ended, so the synthesis
			// turn below can tell a budget stop from a task stop.
			if (turns >= opts.maxTurns) capped = true;
			return capped || opts.shouldStop?.(turn.message, turn.toolResults) === true
				? { action: "end" }
				: undefined;
		},
	});

	const onAbort = () => agent.abort();
	opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

	const before = opts.messages?.length ?? 0;
	let step = 0;
	let errorMessage: string | undefined;
	let aborted = false;
	let capped = false;
	let runFailure: unknown;

	try {
		agent.subscribe((event: AgentEvent) => {
			switch (event.type) {
				case "message_end":
					if ((event.message as { role?: string }).role === "assistant") {
						const m = event.message as AssistantMessage;
						capture?.reply(m);
						if (m.stopReason === "aborted") {
							// The call was cancelled — no completed step, no billed
							// usage (the abort path asserts zero steps).
								aborted = true;
							break;
						}
						if (!usageWasAdmitted(m.usage)) { if (m.stopReason === "error") errorMessage = m.errorMessage; break; }
						step++;
						opts.onUsage?.(m.usage);
						opts.onAssistantMessage?.(m, step);
						if (m.stopReason === "error") errorMessage = m.errorMessage;
					} else if (event.message.role === "toolResult") {
						capture?.toolResult(event.message);
					}
					break;
				case "tool_execution_start":
					opts.onToolStart?.(event.toolName, event.args);
					break;
			}
		});
		if (opts.prompt !== undefined) await agent.prompt({
			role: "user",
			content: opts.prompt,
			timestamp: Date.now(),
		});
		else await agent.continue();
	} catch (error) {
		runFailure = error;
		throw error;
	} finally {
		opts.abortSignal?.removeEventListener("abort", onAbort);
		capture?.finish(runFailure);
	}

	if (aborted || opts.abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		capture?.finish(err);
		throw err;
	}
	if (errorMessage !== undefined) throw new Error(errorMessage);

	// 0.87.1: drop the seeded leading SystemMessage (transcript rework —
	// see ui-stream's settleWith) before slicing past the input count, or
	// the seed displaces the slice and the last INPUT message leaks in.
	const snapshot = (): SubagentRunResult => {
		const newMessages = agent.state.messages
			.filter((m) => (m as { role?: string }).role !== "system")
			.slice(before);
		const assistants = newMessages.filter((m) => (m as { role?: string }).role === "assistant") as AssistantMessage[];
		const last = assistants[assistants.length - 1];
		const text = last
			? last.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
			: "";
		return { newMessages, text };
	};
	let result = snapshot();

	// Cap behaviour (2026-11-11): a run that spends its whole budget on tools has
	// no text to hand back, and one that ends on narration hands back narration —
	// both happened to the researcher in production (three of four jobs: "the
	// researcher produced no text"). Withdraw every tool and take ONE last turn
	// that can only write the deliverable.
	if (opts.synthesizeOnCap && capped && errorMessage === undefined) {
		agent.state.tools = [];
		try {
			await agent.prompt({
				role: "user",
				content: opts.synthesisPrompt ?? DEFAULT_SYNTHESIS_PROMPT,
				timestamp: Date.now(),
			});
			const after = snapshot();
			// Prefer the synthesis; if it stayed silent, keep whatever text the
			// capped run had (possibly none — the caller's honest error stands).
			result = after.text.trim() !== "" ? after : { newMessages: after.newMessages, text: result.text };
		} catch (error) {
			if (opts.abortSignal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			// A failed synthesis must not throw away the gathered material.
			console.warn(`[subagent ${opts.role}] synthesis turn failed:`, error);
		}
	}
	return result;
}