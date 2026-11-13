# Ask while a question is open (interjection)

Owner request 2026-11-12. Today a pending question REPLACES the composer
(`components/chat.tsx`, `pending ? <QuestionDock/> : … : composer`) and the
server refuses any turn while a question dangles, because the answer arrives as
that question call's tool result. The learner cannot say "wait, I don't
understand option 2" without answering first.

## Requirement (owner decisions)

1. While a question is open the learner can send a follow-up question instead of
   answering, unlimited times.
2. The model must KNOW the message is a doubt, not an answer.
3. The model may update the question (or re-issue it unchanged).
4. If the model does not update it, the old question stays active and answerable;
   it never hangs.
5. Mode is chosen by the LEARNER, never guessed by the model: a toggle
   `Answer` / `Ask first`, default `Answer`; switching back keeps the
   typed answer.
6. Collapsed question (the slim `CHECK … Answer ↓` strip): a small ask box below
   the strip, so a doubt can be sent without expanding the card.

## Data shape (named first)

One new input event, one new tool result:

```
ChatInput += { type: "interject", toolCallId: string, text: string }

pending question call ──▶ toolResult(toolCallId)            ← the DEFERRAL
                          content: "learner did not answer; asked: <text>;
                                    explain, then RE-ISSUE the question"
                          details: { interjection: true, text, questionText, tool }
```

Why a tool result and not a plain user message: a tool call must be followed by
its result before the provider accepts the next turn, and the ANSWER path needs
a genuinely pending call to attach to. The deferral closes the current call
cleanly, so the model's next question is a fresh, answerable call.

## The turn that follows

1. Learner sends the doubt → the call is closed with the deferral.
2. The model explains the doubt, then re-issues the question with the same tool
   (verbatim if nothing changed, updated if the doubt changed it).
3. A new pending question arrives → dock re-opens in ANSWER mode. If the
   re-issued question is byte-identical to the one just closed, the learner's
   typed draft is carried over; an updated question starts clean.
4. If the model ends without re-asking, the transcript shows the doubt card and
   the composer returns; the learner can ask again or send "give me the question
   back". Nothing pretends a question is still pending.

## Acceptance checks

| # | Check | How |
|---|---|---|
| A1 | `interject` with no pending call, or a mismatched id, is refused with a 400-class `ChatInputError` | unit (`inputAppends`) |
| A2 | `interject` appends exactly ONE toolResult for the pending call, `details.interjection === true`, and the record then has NO pending question | unit |
| A3 | The model-facing text names the doubt and carries the re-ask obligation | unit (content match) |
| A4 | End-to-end: quiz posed → interject → model explains + re-asks → answer is still accepted as a tool result and the lesson continues | integration (`handleChatRequest` + faux engine) |
| A5 | The interjection counts as LEARNER input for request-cause classification (a wake is not misread as background) | unit (`nativeInputCause`) |
| A6 | The transcript renders the doubt card instead of crashing the answered-card path | render test |
| A7 | Dock default mode is ANSWER; the toggle reaches ASK; ASK hides the answer controls; collapsed state renders the ask box | render test |
| A8 | Draft carry: identical re-issued question restores the typed answer; a changed question does not | unit (`SessionModel`) + pure fingerprint |

## Files

- `src/core/native-messages.ts` — `QuestionInterjection`, `newInterjectionResult`,
  `interjectionResultText`, `isQuestionInterjection`; `nativeInputCause` = learner.
- `src/core/input-events.ts` — the `interject` input (union, parse, appends).
- `src/core/question-core.ts` — `questionInputFingerprint` (stable JSON).
- `src/agent/prompts/shared/20-question-tools.md` — the doctrine.
- `components/question-dock.tsx` — the mode toggle, the ask panel, the collapsed box.
- `components/chat.tsx` — wiring + the doubt card branch.
- `components/answered-card.tsx` — `QuestionDoubtCard`.
- `components/session-core.ts`, `components/session.ts` — `interject()`, draft carry,
  optimistic deferral.
- tests: new files only (existing pins untouched).

## Out of scope

- The practice dock (`components/practice-dock.tsx`): its problem flow is a
  different contract (thinking submissions already allow free text mid-problem).
- Answering a question by typing prose into the ask box (the ask box is doubts
  only; the answer path is unchanged).
- Asking while a MALFORMED question is on screen: the recovery affordance owns it.
- Steering a live turn: already exists and is untouched.
