# Fix round 1 — coding workspace (debugger)

Date: 2026-11-11 · Branch `local-searxng-search` (no commits) · Class: bug-fix (playbook read: `bug-fix.md`).
Inputs: `docs/coding-pane/review-1-correctness.md`, `docs/coding-pane/review-1-security.md`, `plan.md`, `spec.md`.

## Session constraint that shaped the outcome

The session gate refuses `edit`/`write` on any **existing** test file, and refuses `rm` of a test file, for this
agent role. So every new pin landed in new files (`tests/code-session-regressions.test.ts`,
`tests/open-in-editor-regressions.test.ts`, `tests/code-gate.test.tsx`) instead of being appended to
`tests/code-session.test.ts` / `tests/open-in-editor-tool.test.ts` / `tests/code-view.test.tsx`.
Two of those existing files now pin the **pre-fix** behaviour and are red on purpose; §"Tests that must change"
below gives the exact one-line patches. Nothing was weakened or deleted.

Order followed for every item: regression test first (red), then the fix (green).

---

## 1. [BLOCKER] Stale pty exit deleted the live session with the same id

**Mechanism (one sentence):** killing a pty and starting another with the same `<kind>:<scope>` id is normal (a
remount), but the dead child's `onExit` acts on the shared map and shared socket/state-file paths without checking
identity, so the late exit (~1 s measured for a real nvim) unregisters, unlinks and clears the *new* session.

**Repro before the fix** (`tests/code-session-regressions.test.ts` → "a stale pty exit never deletes the session
that replaced it"): start → kill → start → fire the first proc's exit ⇒ `state()` loses the live session, its
`.editor.json` disappears, `write()` returns `false`, and `killAll()` never reaches it.

```
NODE_ENV=test npx tsx --test tests/code-session-regressions.test.ts   # before
not ok 1 - PTY session lifecycle regressions
  error: '3 subtests failed'      # stale-exit deepEqual, reuse resize, chunking
# pass 3 / # fail 11
```

**Fix:** `electron/code-session.cjs:196-215` — `if (sessions.get(id) !== session) return;` before any cleanup or
broadcast; the dead `session.exited && exitCode === undefined` guard (which node-pty never satisfies) is gone.
A stale exit also no longer broadcasts `lh:code:exit`, so a live pane cannot be told "exited".

**Pin:** same test, now green; it asserts the map, the state file, `write()` and `killAll()`.

## 2. [BLOCKER] Dev workspace root split between Electron and the agent

**Mechanism:** `DATA_DIR()` was always `<userData>/data` (dev: `…-dev/data`), while the agent resolves
`LH_DATA_DIR ?? <repo>/data`; `npm run desktop:dev` set neither, so `open_in_editor` looked in a tree the pty host
never wrote to.

**Fix:** one shared rule in both implementations — `resolveDataDir(env, userDataDir)` in
`src/core/code-editor.ts:57-62` and its CJS mirror `electron/code-session.cjs:34-38`; `main.cjs` now derives
`DATA_DIR()` from it (`electron/main.cjs:69-74`), and `package.json` `desktop:dev` exports `LH_DATA_DIR=./data`
for **both** children (`next dev` and `electron .`), which is the same directory the dev server already used, so
no dev data moves.

**Pins:** "resolves the app data dir the same way in both implementations" and "the dev shell exports LH_DATA_DIR
for BOTH children" (both were red: `AssertionError: desktop:dev must pin the root the agent reads`).

## 3. [SECURITY BUG] Symlink escaped the workspace confinement

**Mechanism:** `resolveWorkspacePath` compared lexical paths only, so `link/id_rsa` with `link → ~/.ssh` passed the
containment check and nvim was pointed at a file outside the workspace.

**Fix:** `src/core/code-editor.ts:100-147` — realpath the root, resolve against the real root, keep the
separator-safe lexical check, then realpath the target (or its nearest existing ancestor) and require containment
there too. A non-existent root falls back to the lexical answer (nothing to resolve through; the caller then says
"file not found").

**Pin:** "refuses a path that escapes through a symlink inside the workspace" — real `ln -s` fixture, asserts the
refusal **and** that nothing was spawned. Red before: `Missing expected rejection.`

## 4. [SECURITY] `.editor.json` chose the socket the server dialled

**Mechanism:** the state file lives in a directory the learner's own shell can write, and its `socket` (and `cwd`)
were used verbatim for `nvim --server <sock>`, so any workspace writer could redirect the dial.

**Fix:** `src/agent/tools/open-in-editor.ts:120-133` — the state is DATA, not authority: accept it only when
`socket === editorSocketPath(root, scope)` and its `cwd` resolves to the same real directory as the root
(`samePath`), otherwise refuse with "does not match this workspace".

**Pins:** "refuses a state file whose socket is not this workspace's editor" and "…claims a different workspace
directory" (both `Missing expected rejection.` before), plus the happy-path test that still opens a real file.

## 5. [FINDING 1] `start()` reuse ignored the requested geometry

**Fix:** `electron/code-session.cjs:163-169` — on reuse, `resize(id, cols, rows)` with the incoming (clamped)
values before returning.
**Pin:** "reusing a live session applies the geometry the new pane measured" (asserts the pty resize call).

## 6. [FINDING 4] First screen lost; focus landed on the shell

**Mechanism:** `onData`/`onExit` were subscribed *after* `bridge.start()`, and `start` spawns synchronously, so the
child's first output (LazyVim dashboard, shell banner) was broadcast to nobody. Both panes also called `focus()`,
so the last boot won and that was the shell.

**Fix:** `components/code/terminal-pane.tsx:118-152` subscribes before `start` (the session id is deterministic,
`<kind>:<scope>`), and `components/code-view.tsx:42-46` passes `autoFocus` to the editor pane only.

**Verification:** build passes, and the pane ordering is exercised by the acceptance run (a live UI claim this
diff cannot self-certify). No unit seam exists for IPC ordering; recorded as a residual risk below.

## 7. [FINDING 2] "Desktop only" notice flashed in the desktop app

**Mechanism:** `hasBridge` starts `null` (falsy), so the SSR/first-paint branch was the notice.

**Fix:** `components/code/code-gate.tsx` — three states: `null/undefined` → neutral placeholder
(`data-testid="code-pending"`), `false` → notice, `true` → panes. `components/code-view.tsx:40` uses it.

**Pin:** `tests/code-gate.test.tsx` renders markup (not source text): placeholder for `null`/`undefined`, notice
for `false`, panes for `true`. Red before (component absent).

## 8. [FINDING 3] 64 KB write cap truncated a large paste

**Fix:** `electron/code-session.cjs:236-259` chunks instead of slicing: every chunk ≤ `MAX_WRITE_CHARS`, and a
split never lands inside a surrogate pair.
**Pin:** "delivers a large paste in capped chunks, without dropping or splitting a surrogate pair" — payload built
so the naive boundary falls between the halves of an emoji; asserts byte-for-byte reassembly and no lone halves.

## 9. [SECURITY F2] The spawned nvim client inherited the desktop API secret

**Fix:** `editorClientEnv()` in `src/core/code-editor.ts:65-75` (same strip list as the pty host's `sessionEnv`) and
`defaultExec` now passes it as `env` (`src/agent/tools/open-in-editor.ts:60-68`, `:139`).
**Pin:** "opens a real workspace path and hands the client a sanitised env" + the mirrored-strip assertion in the
parity suite.

## 10. [SECURITY F3] Packaging shipped 53 MB of Windows `.pdb` + build-only headers

**Fix:** `electron-builder.yml:88-99` — `- "!node_modules/node-pty/prebuilds/**/*.pdb"` added after the node-pty
positive, and the `node_modules/node-addon-api/**/*` positive removed (verified: `grep` finds it only in node-pty's
`package.json` as a build dependency, nothing under `lib/` requires it). Prebuilds are kept otherwise: darwin and
win32 load them at runtime, so narrowing to Linux would break those targets.
**Pins:** three assertions in `tests/code-session-regressions.test.ts` (positive present + unpacked, pdb excluded,
header package absent).

## 11. [FINDING 4 — correctness review] `killAll` not wired to `window-all-closed`

**Fix:** `electron/main.cjs:654-663` — `codeSessions?.killAll()` before the macOS-resident branch, matching
`killServer` parity.

## 12. [FINDING 6] Parity test covered only part of the mirror

**Fix:** `MAX_WRITE_CHARS` now exists in both files (`src/core/code-editor.ts:30-32`,
`electron/code-session.cjs:28`), and the parity suite compares `clampCell` (including the explicit `max` argument),
the write cap, and `resolveDataDir` across the two implementations.

## 13. [FINDING 7] Unrelated `micromark-extension-math` reordering

**Fix:** restored the original position in `package.json`; `git diff package.json` now carries only the feature
deps, the `desktop:dev` env and the revert.

## 14. [FINDING 5] Source-text test replaced by render-based assertions

**Fix:** the new `tests/code-gate.test.tsx` asserts rendered markup for all three bridge states. The old
source-substring test still exists (uneditable here) and still passes for the notice half; its pane half asserts
strings that no longer live in `code-view.tsx` — see below.

---

## Tests that must change (requirement changes, gate-blocked for this role)

**A. `tests/open-in-editor-tool.test.ts` — 4 subtests, one-line fixture fix.**
Its `liveEditor()` writes `/run/user/1000/lh-nvim.sock`, an arbitrary socket, which the security fix (item 4) now
correctly refuses. Patch: default the parameter to the workspace's own socket.

```diff
-function liveEditor(root: string, socket = "/run/user/1000/lh-nvim.sock"): void {
+function liveEditor(root: string, socket = editorSocketPath(root, "scratch")): void {
```
plus `import { editorSocketPath } from "../src/core/code-editor.ts";` and, in the happy-path test, the expected
argument becomes `["--server", editorSocketPath(root, "scratch"), "--remote", join(root, "hello.py")]`.
The `execFile` stub now also receives a third `options` argument (`{ env }`); the existing stub signature ignores
it, so no other change is needed.

**B. `tests/code-view.test.tsx` — 1 subtest.**
It asserts the literal `<CodeDesktopNotice />` inside `components/code-view.tsx`; the branch moved into
`components/code/code-gate.tsx` (render-tested instead). Patch: replace that one assertion with
`assert.match(source, /<CodeGate bridge=\{hasBridge\}>/)`, or drop the test now that `tests/code-gate.test.tsx`
covers the behaviour on markup.

**Why this is not "weakening a test":** both files pinned behaviour the security/correctness findings proved wrong
(a dial address that any workspace writer controls; a wiring shape that produced a visible flash). The requirement
changed, so the pins change, and the new pins are asserted on behaviour, not on source text.

---

## Commands (this session, verbatim tails)

```
NODE_ENV=test npx tsx --test tests/code-session-regressions.test.ts tests/open-in-editor-regressions.test.ts
  before: # pass 3  # fail 11
  after:  # pass 14 # fail 0

NODE_ENV=test npx tsx --test tests/code-session.test.ts tests/open-in-editor-tool.test.ts tests/code-ipc.test.ts \
  tests/code-view.test.tsx tests/code-gate.test.tsx tests/code-session-regressions.test.ts tests/open-in-editor-regressions.test.ts
  → # pass 34 # fail 5   (the 5 are A + B above)

npm run typecheck   → exit 0 (after fixing one `env` cast + one implicit-any callback)
npm run lint        → 1 problem (0 errors, 1 pre-existing warning tests/source-name-ui.test.tsx:26)
npm run build       → exit 0, route table contains "├ ƒ /code"; next-env.d.ts reverted afterwards
npm test            → # tests 3592 # pass 3580 # fail 8
                      = 3 pre-existing (search-expansion "all five saved keys", settings-pure "classifyKeys",
                        subscription-auth pi-ai exports) + 5 from A+B (1 code-view, 4 open_in_editor)
```

## Deliberately not fixed

- **Focused terminal disables every menu accelerator** (Reload/DevTools/Fullscreen/Zoom/Quit) — inherent to
  `setIgnoreMenuShortcuts`, which is what makes LazyVim usable. Documentation item for `build.md`/acceptance.
- **`start()` unlinks the socket without probing a live owner.** After a `SIGKILL`ed Electron an orphan nvim can
  hold the path; the new instance binds a fresh socket and the orphan becomes unreachable. A liveness probe needs a
  policy decision (kill by socket owner vs. leave it), so it stays a documented residual risk.
- **Broken native addon shows Electron's raw "No handler registered" text** instead of the honest notice. Cosmetic,
  and the failure is already logged (`coding workspace unavailable: …`), so it was left alone in this round.
- **`readEditorState` still returns `pid`** that nothing consumes; harmless, and removing it would churn the
  existing (gate-blocked) test.
- **macOS window-close focus bookkeeping** — out of scope per `plan.md` (Linux x64 only); `killAll` is now wired,
  so no process leaks there.

## Residual risks

1. The two gate-blocked test files stay red until the patches above are applied; the full suite cannot be green
   before that.
2. IPC-ordering and focus behaviour (items 6) are only proven by build + acceptance, not by a unit seam.
3. `DATA_DIR()` now honours a user-set `LH_DATA_DIR` in packaged mode too. Intentional (one rule, one root), but it
   is a behaviour change for anyone who sets that variable.
