# Fix round 2 — review-2 findings (N1, F2, F3, F4)

Date: 2026-11-11 · Branch `local-searxng-search` · One writer: `debugger` · Deadline 30 min (met).
Sources: `docs/coding-pane/review-2.md` (Finding F2/F3/F4, Note N1), `fix-round-1.md`, `plan.md`.
Reviewer reported **no bugs**; this pass closed one real behavioural defect plus three pin-quality gaps.

## Item 1 — N1, the only behavioural fix: a remounted renderer was never repainted

**Root cause (one sentence).** `start()`'s reuse branch only resized the surviving pty and returned; the
bytes the pty had already emitted were broadcast once to a renderer that no longer existed and were never
retained, so a reload (which keeps the pty but builds a fresh xterm) produced a blank pane until a keystroke
triggered a repaint.

**Repro before the fix** (`/tmp/n1-repro.cjs`, fake pty, real module):

```
live output delivered: [["editor:scratch","SCREEN-ONE"]]
reuse: {"reused":true}
replay delivered to the new renderer: [] <-- expected SCREEN-ONE
```

**Fix** (`electron/code-session.cjs`):

- `OUTPUT_BUFFER_CHARS = 65536`, `appendBounded(buffer, chunk, cap)` — a tail buffer that drops the OLDEST
  characters and never cuts between a surrogate pair.
- Each session record gained `buffer: ""`; `proc.onData` appends **and** broadcasts as before (live output is
  delivered exactly once, never duplicated).
- The reuse path in `start()` now sends `onData(id, existing.buffer)` **before** `resize(...)`: a resize makes
  nvim repaint, and those repaint bytes must land after the restored screen. The return object gained
  `replayed: existing.buffer.length` so the behaviour is observable.
- A fresh spawn has an empty buffer, so nothing is replayed; buffers live on the session object, which is
  keyed `<kind>:<scope>`, so scopes cannot leak into each other and `kill` disposes the buffer with it.

**Repro after the fix** (same command, same file):

```
live output delivered: [["editor:scratch","SCREEN-ONE"]]
reuse: {"reused":true,"replayed":10}
replay delivered to the new renderer: [["editor:scratch","SCREEN-ONE"]] <-- expected SCREEN-ONE
fresh spawn replay leaked: [] <-- expected []
```

**Pin:** `tests/code-review-2-pins.test.ts` → describe `N1 — a remounted renderer is repainted from the tail
buffer` (5 tests): exactly one ordered replay on reuse; replay precedes the repaint-triggering resize; a fresh
session after kill carries no stale screen and does not leak; scope isolation; the buffer stays at the cap and
keeps the newest bytes, with a surrogate-safe cut.

**Proved to fail without the fix** — reverted copy (replay line and buffer append removed), same file:

```
not ok 1 - N1 — a remounted renderer is repainted from the tail buffer
# tests 10 # pass 6 # fail 4
```

Restored, then `sha256sum` matched the pre-revert file (`bcb6792f…`) and the suite returned `# pass 10`.

## Item 2 — F2: the parity pin compared two mirrors, not the production pair

**Root cause.** `tests/code-session-regressions.test.ts` compared `cjs.resolveDataDir` against
`core.resolveDataDir`. Both are mirrors; neither is what the agent actually uses (`config.ts:17-19` feeds
`PATHS.data`, which reaches the tool). A drift in `config.ts` would have stayed green.

**Fix (test-level, no `config.ts` edit — it is outside this run's authority).** The production pair is now
asserted directly: a child process loads the REAL `config.ts` under a given `LH_DATA_DIR` and prints
`PATHS.data`, and that value is compared to the CJS resolver the pty host uses.

**Pin:** `tests/code-review-2-pins.test.ts` → describe `F2 — the parity pin compares the production data-dir
pair` (3 tests):

1. `LH_DATA_DIR=./data` (the desktop:dev form) → `config.ts` and the CJS resolver both give `<repo>/data`.
2. an absolute `LH_DATA_DIR` → identical on both sides.
3. unset → the two fallbacks differ **by design** (repo-data for the headless server, `<userData>/data` for the
   shell), and the test pins that `desktop:dev` exports `LH_DATA_DIR` so those differing fallbacks never meet.

The child-process read is what makes this sensitive: cases 1 and 2 assert an equality that only holds if the
real `config.ts` rule and the real CJS rule agree, e.g. `assert.equal(agent, dir)` fails if `config.ts` ever
stops resolving a relative form.

## Item 3 — F3: the env-strip pins were per-variable

**Root cause.** `tests/code-session-regressions.test.ts` hardcoded the four names it expected
`editorClientEnv` to delete and never compared it to `sessionEnv`. A new secret added to the PTY host's
sanitiser only would have kept every test green while the `nvim --remote` client inherited it.

**Fix.** Two-level pin in `tests/code-env-parity.test.ts`: (a) the DECLARED strip list, parsed out of each
sanitiser's own body (`/delete out\.([A-Za-z0-9_]+)/g`) and compared as a set, which catches a name no fixture
knows; (b) every declared name is proven to actually disappear from a live fixture env, on both sides.

**Proved to fail without the invariant** — injected `delete out.LH_DESKTOP_TOKEN;` into
`src/core/code-editor.ts` only:

```
not ok 1 - F3 — the two env sanitisers declare the same strip list
# tests 3 # pass 2 # fail 1
```

Reverted; `sha256sum` matched (`25e4886e…`), `grep -c LH_DESKTOP_TOKEN src/core/code-editor.ts` → `0`.

## Item 4 — F4: the view pin passed if the panes rendered nothing

**Root cause.** `tests/code-view.test.tsx` matches source text (`<CodeGate bridge={hasBridge}>`,
`<TerminalPane kind="editor"`), so it stays green if the gate's `true` branch renders an empty tree.

**Fix.** Behavioural pin beside it (a new file because the session gate refuses edits to an existing test):
`CodeGate` with `bridge` must render every child it is given — two panes in, two `data-testid="pane-…"` nodes
out, no notice, no placeholder — while `null`/`undefined`/`false` render zero panes. A third assertion keeps
the wiring honest: the `<CodeGate>…</CodeGate>` slice of `code-view.tsx` must contain exactly two
`<TerminalPane>`, one `kind="editor"` and one `kind="shell"`.

**Proved to fail without the behaviour** — changed the gate's `true` branch to `return <></>;`:

```
not ok 1 - F4 — the bridge-present branch renders every pane it is given
# tests 3 # pass 2 # fail 1
```

Reverted; `sha256sum` matched (`807895f9…`).

## Commands (real output, this session)

```
NODE_ENV=test npx tsx --test tests/code-session.test.ts tests/code-session-regressions.test.ts \
  tests/code-ipc.test.ts tests/code-view.test.tsx tests/code-gate.test.tsx tests/open-in-editor-tool.test.ts \
  tests/open-in-editor-regressions.test.ts tests/code-review-2-pins.test.ts tests/code-env-parity.test.ts \
  tests/code-gate-panes.test.tsx
  → # tests 55 · # pass 55 · # fail 0

npm test            → # tests 3608 · # pass 3601 · # fail 3   (the 3 known pre-existing, names below)
npm run typecheck   → exit 0 (no output)
npm run lint        → 0 errors, 1 warning (pre-existing tests/source-name-ui.test.tsx:26 no-head-element)
npm run build       → exit 0, route table still contains "ƒ /code"
git checkout -- next-env.d.ts → reverted (next build rewrote it)
node /tmp/n1-repro.cjs        → before/after output quoted in item 1
```

The 3 remaining failures are the same pre-existing ones, untouched:
`tests/search-expansion-integration.test.ts` "all five saved keys …", `tests/settings-pure.test.ts`
"classifyKeys …", `tests/subscription-auth.test.ts` "main loader resolves Pi's import-only PUBLIC package
exports …".

`git status --porcelain`:

```
 M components/keyboard-shortcuts.tsx
 M components/sidebar.tsx
 M electron-builder.yml
 M electron/main.cjs
 M electron/preload.cjs
 M package-lock.json
 M package.json
 M src/agent/tools.ts
 M tests/desktop-platform.test.ts
 M tests/file-path-preload.test.ts
 M tests/graph-tools.test.ts
 M tests/question-tools.test.ts
?? app/code/  ?? components/code-view.tsx  ?? components/code/  ?? docs/coding-pane/
?? electron/code-ipc.cjs  ?? electron/code-session.cjs
?? src/agent/tools/open-in-editor.ts  ?? src/core/code-editor.ts
?? tests/code-env-parity.test.ts  ?? tests/code-gate-panes.test.tsx  ?? tests/code-gate.test.tsx
?? tests/code-ipc.test.ts  ?? tests/code-review-2-pins.test.ts  ?? tests/code-session-regressions.test.ts
?? tests/code-session.test.ts  ?? tests/code-view.test.tsx  ?? tests/open-in-editor-regressions.test.ts
?? tests/open-in-editor-tool.test.ts
```

Changed by this round: `electron/code-session.cjs` (the fix) and three new test files
(`tests/code-review-2-pins.test.ts`, `tests/code-env-parity.test.ts`, `tests/code-gate-panes.test.tsx`). No
existing test assertion was weakened, no dependency added, no docs edited.

## Residual risks

1. **Replay is a bounded tail, not a full re-render.** A pane that produced more than 64 KiB since it was last
   attached is repainted from the newest 64 KiB; the cut may land inside an escape sequence, so the very top of
   a long scrollback can look odd until a redraw. nvim's own dashboard/statusline repaint after `resize` limits
   the visible effect.
2. **Replay is announced on the same broadcast channel as live data** (`lh:code:data`). With more than one app
   window, every window would receive another window's replay; the same is already true of live output, and the
   app has one window today.
3. **`config.ts` still holds the authoritative rule and is not covered by the parity test's import.** The pin
   compares against the real module output, so drift fails — but `config.ts` still has its own copy of the
   resolve/trim logic, which is why `LH_DATA_DIR="  "` (whitespace only) still diverges from the CJS mirror.
   Making `config.ts` call `resolveDataDir` is the structural fix; it is outside this run's file authority and
   would belong with the branch-hygiene pass.
4. **F4's view-level assertion is still source-text** (the repo has no DOM harness). The gate behaviour is
   render-pinned; the wiring between `code-view.tsx` and its two panes is pinned by counting, not by mounting.
