I have enough evidence. Writing the review (no repo edits; artifact returned in full per the runtime's persist-on-return rule).

## Review

Artifact: `docs/coding-pane/review-1-correctness.md`

# Review 1: correctness + lifecycle, coding workspace (2026-11-11)

Scope: `git status`/`git diff` (12 modified files) plus 8 untracked new files. Audited against `plan.md` D1-D9, `spec.md` F1-F10, and `build.md` claims. Read-only: no file edited, no git mutation, no install.

---

## Correct

- IPC trust gate matches the repo's existing pattern: every `lh:code:*` entry point checks `trustedAppWindows` + `trustedSender` before touching the session manager (`electron/code-ipc.cjs:30-58`); untrusted calls are provably inert (`tests/code-ipc.test.ts:62-73` passes, and I read the handlers).
- No renderer message can reach an undefined/stale session and throw: `write`/`resize`/`kill` all `sessions.get(id)` and return `false` (`electron/code-session.cjs:219-256`); `state()` maps the map. The one id-shaped hazard is the `onExit` handler, reported as B1, not an IPC hole.
- Renderer arguments are validated where they matter: `kind` whitelisted (`code-session.cjs:141`), `scope` against `/^[A-Za-z0-9_-]{1,32}$/` with fallback (`:26-30`), geometry floored and clamped 2..1000 before the ioctl (`clampCell`, `:48-52`, asserted `tests/code-session.test.ts:74-80`), `data` must be a non-empty string (`:221`).
- A renderer can never name a binary, cwd, env or argv: all four are main-side decisions (`code-session.cjs:143-175`), which is what D1/D3 asked for.
- Terminal cleanup on unmount is complete in kind: IPC unsubscribes, `term.onData`/`onResize` disposables, DOM listeners, debounce timer, `ResizeObserver`, focus release, `terminal.dispose()`, `host.replaceChildren()` (`components/code/terminal-pane.tsx:189-202`). Nothing in that list is missing.
- Fit-addon undefined/NaN is genuinely covered, though not by the diff's `try/catch`: `@xterm/addon-fit@0.11.0` returns early on `!dims || isNaN(cols) || isNaN(rows)` and clamps to `MINIMUM_COLS/ROWS` (`node_modules/@xterm/addon-fit/src/FitAddon.ts:39-44,88-92`), so the unguarded `fit.fit()` at `terminal-pane.tsx:115` cannot throw the documented way.
- WebGL context loss has a real fallback: `webglAddon.onContextLoss(() => webglAddon.dispose())` (`terminal-pane.tsx:108`) and the addon's own dispose registers `renderService.setRenderer(_createRenderer())` (`node_modules/@xterm/addon-webgl/src/WebglAddon.ts:90-96`), i.e. back to the DOM renderer, not a blank canvas.
- Font is preloaded before `open()` (`terminal-pane.tsx:97-103` then `:105`), the family name is real (`fc-list` shows `JetBrainsMono Nerd Font Mono`), and the load failure is swallowed into the fallback stack (D8 honoured).
- No SSR/hydration hazard: `useState<boolean | null>(null)` renders the same markup on server and first client paint, xterm is imported inside the effect, and the only static import is the stylesheet (`components/code-view.tsx:22-24`, `terminal-pane.tsx:23-25`).
- React 19 double-effect cannot double-spawn: `boot()` checks `disposed` before `start`, and kills a session it started after cleanup (`terminal-pane.tsx:96,118-121`).
- Key-fidelity wiring targets the right API and it exists in this Electron: `webContents.setIgnoreMenuShortcuts(ignore)` is present in `electron@44.9.3` typings (`node_modules/electron/electron.d.ts:19129`), the app menu really does own `CmdOrCtrl+W` via `{ role: "windowMenu" }` plus the Edit/View roles (`electron/main.cjs:597-645`), and the renderer dispatcher stands down while a terminal is focused (`components/keyboard-shortcuts.tsx:67`).
- `open_in_editor` refuses instead of guessing: no state file, path outside the workspace, missing file, missing nvim, and a dead socket each throw a distinct actionable message (`src/agent/tools/open-in-editor.ts:102-122`); argv is an array, never a shell string, and the 8 s `execFile` timeout is real (`:55-61`). No second nvim is ever spawned: `nvim --server <sock> --remote` fails hard when the socket is dead (verified: exit 1, `E247`).
- Packaging: exactly one `asarUnpack` key (`electron-builder.yml:96`), node-pty unparks from asar, and no package was dropped from `package-lock.json` (the 117 deleted lines are all `"libc"` metadata normalisation, zero removed package entries).
- Test-pin edits to the four existing suites are additions only (one id each, or `"code"` in the preload enumerations); no assertion was relaxed (`git diff tests/`).
- Real-behaviour tests exist where it counts: `tests/code-session.test.ts:120-160` drives an actual `node-pty` + `/bin/bash`, round-trips `echo PTY_READY`, and asserts the resize reached the session.

---

## Bug

### B1 (blocker) A dead pty's `onExit` deletes the *current* session with the same id, unlinks its socket and its state file, and makes it unkillable

`electron/code-session.cjs:188-201` (the damage: `:192-193` `rmSync(session.socket)`, `:197` `clearState(root, session.socket)`, `:199` `sessions.delete(id)`).

Why: the handler captures `id` (a constant string `editor:scratch`) and acts on the shared map without checking that the map entry is still *this* pty. `kill()` (`:250`) and `killAll()` only remove from the map; the child's exit event arrives up to a second later, and by then a new session with the same id can own the entry. Both sessions also compute the *same* socket path and the *same* `.editor.json`, so `clearState`'s socket comparison cannot distinguish them.

Measured window: a real `nvim` under the user's LazyVim config takes **1012 ms** to exit after `proc.kill()` (SIGHUP). Repro is therefore trivial in the UI: open Code, click into the sidebar for a chat, click Code again within about a second.

Verified (real nvim, throwaway dataDir in /tmp, not the repo):

```
A ok editor:scratch   state file: true
s.kill(A.id)          registry: []           state file: false
B = s.start(...)      registry: ["editor:scratch"]  state file: true
<A's SIGHUP exit lands ~1s later>
AFTER stale exit -> registry: []            <-- B is gone
AFTER stale exit -> state file: false       <-- open_in_editor now refuses
AFTER stale exit -> socket file: false      <-- B's --listen socket unlinked
nvim --remote against B's socket -> status 1 "E247: Failed to connect ... connection refused"
write() to B: false   resize() B: false
killAll() afterwards -> pgrep still lists: /usr/bin/nvim --listen .../.nvim-scratch.sock
```

Minimal unit form (fake spawn, deterministic, no nvim needed): start editor, `kill`, `start` again, then fire the *first* proc's `onExit`; `state()` returns `[]`.

Expected: killing session A must not disturb session B. Actual: B's keystrokes stop flowing (`write` returns `false`), resize is dead, `.editor.json` is deleted so `open_in_editor` answers "No coding editor is running" while nvim *is* running (F8), the socket is unlinked so nothing can reach it any more, and B's nvim can no longer be reached by `killAll`, so it survives app quit (F10 violation).

Suspected cause / fix direction: guard the handler on identity, and only clean up shared state that is still ours, e.g.

```js
if (sessions.get(id) === session) { /* socket + state + delete + onExit broadcast */ }
```

Note the existing guard on `:189` (`session.exited && exitCode === undefined`) is dead code: node-pty always supplies `exitCode`, so it never fires and never prevents this.

A regression test that would catch it: reuse `tests/code-session.test.ts`'s fake-nvim script, `kill` the session, immediately `start` again, then fire the first proc's exit and assert `state()` still holds the new session, the state file still exists, and `killAll()` kills the new proc.

### B2 (blocker for the acceptance stage, dev-only) The agent tool and the PTY host disagree on the workspace root under `npm run desktop:dev`, so F7 and F8 cannot pass in the documented harness

`package.json:22` (`desktop:dev` sets only `LH_DEV_URL`), `electron/main.cjs:130` (`userData` becomes `<userData>-dev`) + `:751` (`dataDir: DATA_DIR()`), versus `src/agent/tools/open-in-editor.ts:90` (`deps.dataDir ?? PATHS.data`) and `config.ts:17-19` (`LH_DATA_DIR` unset becomes `<repo>/data`).

Why: in dev the window is not served by the spawned standalone server, so nothing sets `LH_DATA_DIR` for `next dev`. Electron therefore writes the workspace to `~/.config/LearnHarness-dev/data/code/scratch` while the agent (running inside `next dev`) reads `<repo>/data/code/scratch`. I confirmed the agent-side directory does not exist (`ls data` shows only `chats`, `graph`, `jobs`) and that no script or env file supplies `LH_DATA_DIR` to `next dev`.

Repro: `npm run desktop:dev`, open Code, `:w hello.py`, then ask the agent to `open_in_editor` `hello.py`.
Expected: the file appears in nvim (F8), and a follow-up `read` of the workspace path (F7) works. Actual: the tool throws "No coding editor is running, so no file can be shown. ... Workspace: /<repo>/data/code/scratch", and the teacher never learns the real path, so F7 is unreachable too. Packaged mode is consistent (`electron/main.cjs:231` passes `LH_DATA_DIR: DATA_DIR()` to the server child), so this does not affect the shipped AppImage, only the harness `build.md` tells the tester to use.

Minimal fix (parent's call, one line either way): export `LH_DATA_DIR` in the `desktop:dev` script for both children, or have the shell publish the real data dir to the dev server. Also worth a comment in `build.md`'s acceptance notes, which currently only warns about the *path* by name.

---

## Finding

1. **`start()` reuse ignores the requested geometry** (`electron/code-session.cjs:143`). Trigger: `/code` reloaded while nvim is alive (`start` returns `reused: true`), or the window was resized in between; the pty keeps the old cols/rows and the fresh xterm never resends them, because the only fit that changes dimensions happens *before* `term.onResize` is subscribed (`terminal-pane.tsx:115` vs `:141`). Minimal fix: when reusing, call `resize(id, cols, rows)` with the incoming (clamped) values.
2. **The desktop-only notice flashes in the desktop app on every `/code` visit** (`components/code-view.tsx:22,40`). `hasBridge` starts `null`, which is falsy, so the SSR payload for Electron contains "The coding workspace runs inside the LearnHarness desktop app", and it stays until the dynamic imports, font load and `start()` round-trip finish. Trigger: open Code in the packaged app. Minimal fix: render a neutral "starting" placeholder for `null` and gate the notice on `hasBridge === false`.
3. **The 64 KB write cap truncates silently** (`electron/code-session.cjs:28,224`). Trigger: bracketed-paste more than 64 KiB into the terminal; the tail is dropped with no user-visible message (and a `slice` cut on a surrogate pair would also emit a lone half). Documented in `build.md`, but the cap is applied *after* the whole string has crossed IPC, so it buys nothing except the truncation itself; chunking `write` in 64 KiB pieces would keep both properties.
4. **`killAll` is not wired to `window-all-closed`** (`electron/main.cjs:654-668`), although plan step 3 lists it. On Linux this is covered incidentally (`window-all-closed` calls `app.quit()` then `before-quit`), so F10 holds there; on macOS the window closing leaves nvim and the login shell running with no UI, because the app stays resident. `killServer` has the same three hooks and the same gap, so at least the parity with `killServer` is exact. No `SIGTERM`/`SIGINT` handler on either.
5. **Test quality: three of the four new suites would pass with the feature broken in the ways I found.** (a) `tests/code-view.test.tsx:26-33` asserts substrings of `code-view.tsx`'s source text, so it passes if `TerminalPane` renders nothing, never spawns, or leaks. (b) `tests/code-ipc.test.ts` injects a fake `sessions` object, so it passes if the registry spawns nothing, and it asserts no argument validation because validation lives below the layer it mocks. (c) No test drives `TerminalPane` at all: unmount cleanup, focus release, `window.lh.code.focus` calls, fit and webgl fallback are all unasserted. (d) `tests/code-session.test.ts:160-172` proves `kill` removes the state file but nothing about `killAll`, and nothing covers the kill-then-restart sequence that is B1. Concrete gap to close first: B1's test.
6. **The parity test is real but partial** (`tests/code-session.test.ts:41-58`). `resolveNvimBinary`, `sanitizeScope`, `workspaceRoot`, `editorSocketPath`, `editorStatePath` are compared across the two implementations, but `clampCell` is asserted against hardcoded values rather than compared (`:74-80`), and `MAX_WRITE_CHARS`, `shellBinary` and `resolveWorkspacePath` exist on one side only. So a future change to the clamp's `max` default or the write cap in either file drifts silently.
7. **Unrelated churn in `package.json`**: `micromark-extension-math` was moved in the dependency list with no behavioural change (`git diff package.json:62`). Harmless, but it is scope the plan did not ask for, and it widens the diff for the next reader.

---

## Note

- **Initial focus lands on the shell, not nvim.** Both panes call `term.focus()` at the end of boot (`terminal-pane.tsx:180`); whichever resolves last wins, and the shell is second in the tree (`code-view.tsx:42-44`). Typing right after opening `/code` therefore goes to bash. Not a spec violation (F3 says "with the editor focused"), but the tester must click the editor before grading F3, and `build.md` should say so.
- **The "broken native addon" degradation shows raw Electron text, not the honest notice.** If `createCodeSessions` throws, `registerCodeIpc` never runs, yet `window.lh.code` still exists, so `CodeView` takes the bridge branch and the pane prints `Error invoking remote method 'lh:code:start': ... No handler registered for 'lh:code:start'` (`main.cjs:749-790`, `terminal-pane.tsx:184-187`). The comment at `main.cjs:744-748` claims the panes fail "with their own error text".
- **`setIgnoreMenuShortcuts(true)` also disables Reload, DevTools, Fullscreen, zoom and Quit accelerators** while a terminal has focus, because it disables the whole application menu. That is inherent to D6 and fine for typing, but it means `Ctrl+R` in the shell reaches the shell (correct) and the developer has no keyboard reload until they click outside the pane. Worth one line in the acceptance notes.
- **`start()` unlinks the socket file before spawning without checking for a live owner** (`code-session.cjs:174`). After a hard crash (`SIGKILL`ed Electron) an orphan nvim still holds that path; the next start binds a fresh socket and the orphan becomes unreachable forever, invisible to `killAll`.
- `readEditorState` reads `pid` and nothing uses it (`open-in-editor.ts:63-74`); harmless dead data, but it is not what tells the tool the editor is alive, the socket is.
- macOS-only path, out of scope per plan: on window close with a terminal focused, no React cleanup runs, so `focus(false)` is never sent; the stale `codeFocusedWindows` entry is harmless because the flag is per-`webContents` and `did-finish-load` clears a recycled id, but the set grows by one dead id per close cycle.

---

## Verified

| Command | Result |
|---|---|
| `NODE_ENV=test npx tsx --test tests/code-session.test.ts tests/code-ipc.test.ts tests/code-view.test.tsx tests/open-in-editor-tool.test.ts` | 21/21 pass, 0 fail |
| `npm run typecheck` | exit 0, no output |
| `npm run lint` | exit 0, 1 warning: pre-existing `tests/source-name-ui.test.tsx:26` |
| node one-liner: fake-pty kill/restart then stale `onExit` | reproduced B1: `state()` empties, `.editor.json` removed, new proc not killed by `killAll` |
| node + real `nvim` + real `node-pty`, dataDir `/tmp/lh-review-e2e` | reproduced B1 end to end: `E247` on `--remote`, `write`/`resize` false, orphan nvim after `killAll` |
| node + real `nvim`: SIGHUP to exit latency | 1012 ms, which is the B1 window |
| read `node_modules/@xterm/addon-fit/src/FitAddon.ts`, `@xterm/addon-webgl/src/WebglAddon.ts` | NaN/undefined guard and DOM-renderer fallback confirmed |
| `grep setIgnoreMenuShortcuts node_modules/electron/electron.d.ts` | present at `:19129`, Electron 44.9.3 |
| `fc-list \| grep -i jetbrains` | `JetBrainsMono Nerd Font Mono` installed |
| `git diff package-lock.json` | only `"libc"` metadata normalisation, zero package removals |

Not run, and why: `npm run build` (not in my allowed list; no build artifact is in question for correctness), and any live Electron run (`npm run desktop:dev`) because it needs a display and a GUI session; B2 is decided from code plus the absent directory, not from a live run, and that is the one claim above I would want a live `open_in_editor` call to confirm.

Cleanup: the /tmp probe directories and the stray nvim processes from my repro were killed and removed; `git status --porcelain` after the audit is byte-identical to before it.