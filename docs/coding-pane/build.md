# Build report — coding workspace (real Neovim/LazyVim + shell) in LearnHarness

Date: 2026-11-11 · Branch: `local-searxng-search` (no commits made) · One writer: `worker`
Sources of truth: `docs/coding-pane/plan.md` (decisions D1–D9), `docs/coding-pane/spec.md` (F1–F10).

## What was built

A new `/code` view hosts the learner's **own** `nvim --listen <sock>` and their login shell, both in
`<LH_DATA_DIR>/code/scratch`, rendered with xterm.js and driven by a node-pty host in **Electron main**.
LazyVim config, keymaps and plugins are inherited untouched (env passthrough, no `NVIM_APPNAME`), and the
agent gains one narrow tool (`open_in_editor`) that shows a workspace file in the already-running editor.

Data shape: a **session registry keyed `<kind>:<scope>`** (`{id, kind, scope, cwd, pid, socket, proc,
exited, cols, rows}`) plus one file record per workspace, `.editor.json = {socket, pid, scope, cwd,
startedAt}`, which is how the agent finds the live editor.

## Files changed

New:

- `electron/code-session.cjs` — pure rules (nvim binary resolution, workspace/socket/state paths, scope
  sanitiser, cell clamp, env sanitiser) + the PTY session manager (`start/write/resize/kill/killAll/state`),
  state-file write/cleanup, socket unlink before spawn.
- `electron/code-ipc.cjs` — `lh:code:{start,write,resize,kill,focus,state}` handlers with the repo's trust
  check, plus the `lh:code:{data,exit}` push channel names.
- `src/core/code-editor.ts` — the ESM half of the path/binary rules (the CJS shell cannot import TS; the
  parity is pinned by a test).
- `src/agent/tools/open-in-editor.ts` — `open_in_editor` tool (workspace-confined, refusal-first).
- `app/code/page.tsx`, `components/code-view.tsx`, `components/code/terminal-pane.tsx`,
  `components/code/desktop-notice.tsx`, `components/code/focus.ts`.

Modified:

- `electron/main.cjs` — creates/tears down the PTY host (`before-quit`, `process.exit`, `SIGHUP`),
  registers the IPC (inside a try/catch: a broken native addon costs the Code view, never the whole app),
  broadcasts pty output, releases menu accelerators while a terminal is focused
  (`setIgnoreMenuShortcuts`), stands the zoom catcher down for that window, clears the claim on every load.
- `electron/preload.cjs` — `window.lh.code` (`start/write/resize/kill/focus/state/onData/onExit`).
- `electron-builder.yml` — explicit `node_modules/node-pty/**/*` positive in `files`, a
  `!node_modules/node-pty/prebuilds/**/*.pdb` exclusion (53 MB of Windows debug symbols), and
  `asarUnpack: node_modules/node-pty/**/*`. `node-addon-api` is build-time only and is not shipped.
- `components/sidebar.tsx` — third door row (`data-testid="open-code"`) + the `Window.lh.code` type.
- `components/keyboard-shortcuts.tsx` — the global dispatcher returns early while a terminal has focus.
- `src/agent/tools.ts` — `open_in_editor` registered in both agent registries.
- `package.json` / `package-lock.json` — `node-pty@1.1.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`,
  `@xterm/addon-webgl@0.19.0`, `@xterm/addon-unicode11@0.9.0`.
- Test pins (approved by the supervisor, add-only, no assertion relaxed): `tests/desktop-platform.test.ts`,
  `tests/file-path-preload.test.ts`, `tests/graph-tools.test.ts`, `tests/question-tools.test.ts` — each
  exact enumeration gained `"code"` / `"open_in_editor"`.

New tests: `tests/code-session.test.ts`, `tests/code-ipc.test.ts`, `tests/open-in-editor-tool.test.ts`,
`tests/code-view.test.tsx`.

## Commands (real output, this session)

```
npm run typecheck                  → exit 0 (tsc --noEmit, no output)
npm run lint                       → exit 0 · 1 problem (0 errors, 1 warning) — pre-existing
                                     tests/source-name-ui.test.tsx:26 no-head-element
npm run build                      → exit 0 · "✓ Compiled successfully in 3.6s" · route table shows
                                     "├ ƒ /code" (dynamic)
git checkout -- next-env.d.ts      → reverted (next build rewrote it, known side effect)
npm test                           → exit 1 · # tests 3592 · # pass 3585 · # fail 3 · # skipped 4
                                     (after the round-1 fixes + the parent's two test patches)
ELECTRON_RUN_AS_NODE=1 npx electron -e "require('node-pty')…spawn('bash'…)"
                                   → {"node":"24.22.0","modules":"149","out":"ELECTRON_ABI_PTY_OK"}
```

That last probe is the packaging risk closed: node-pty 1.1.0 is Node-API, so the binary loads and spawns
under **Electron 44's** Node 24.22 (ABI 149), not just the system Node 22.

Targeted runs while building: `tests/code-session.test.ts` 8/8, `tests/code-ipc.test.ts` 5/5,
`tests/open-in-editor-tool.test.ts` 6/6, `tests/code-view.test.tsx` 2/2.

## The 3 remaining `npm test` failures are PRE-EXISTING (not this feature)

Verified by `git stash push -u` (all my changes removed) → same three suites fail identically:

1. `tests/search-expansion-integration.test.ts:80` — "all five saved keys follow the approved Automatic
   order as keys are removed" (the branch has 6 search keys; `SEARXNG_URL` was added earlier without
   updating this pin).
2. `tests/settings-pure.test.ts:250` — "curated tool ids always render (synthesized when absent)" and the
   suite at `:216` "classifyKeys — the Keys section's two-group projection": same `SEARXNG_URL` delta.
3. `tests/subscription-auth.test.ts:35` — "main loader resolves Pi's import-only PUBLIC package exports and
   native OAuth without a CLI or network": `No "exports" main defined in …/@earendil-works/pi-ai/package.json`.

Untouched, per instruction: not fixed, not skipped, not deleted.

## Spec coverage (implementation status)

| # | Feature | Implemented | Verified how |
|---|---|---|---|
| F1 | Code view reachable from sidebar, editor + terminal panes | yes (`/code`, `open-code` door, stacked panes) | build route table + render test; **live click not yet graded** |
| F2 | Real Neovim + LazyVim config in the pane | yes (spawned with inherited env, cwd = workspace) | unit (fake nvim spawn, state file); **live LazyVim UI not yet graded** |
| F3 | LazyVim keybindings survive the host | yes (`setIgnoreMenuShortcuts`, zoom exemption, dispatcher stand-down, xterm custom key path default-on) | code + audit; **live chord test not yet graded** |
| F4 | Terminal pane is a real shell in the workspace | yes | unit: real pty, `PTY_READY` round-trip, resize |
| F5 | Resize honoured by both ptys | yes (fit addon + ResizeObserver debounce + `onResize` → IPC → ioctl) | unit asserts clamped resize reaches the session; **live reflow not yet graded** |
| F6 | Workspace persistence | yes (`<data>/code/scratch`, recreated per start) | unit asserts dir creation + reuse; **restart not yet graded** |
| F7 | Agent can read the workspace | yes (existing `read/ls/grep` reach it; unrestricted default policy) | not yet exercised by a live turn |
| F8 | Agent can open a file in the running editor | yes (`open_in_editor`, `nvim --server … --remote`) | unit: argv, refusals (outside workspace, no editor, missing file, dead socket) |
| F9 | Honest degradation without the bridge | yes (`CodeDesktopNotice`) | render test + source pin |
| F10 | No orphan processes | yes (`killAll` on three quit paths, per-pane kill on unmount) | unit: kill removes state file and socket; **app-quit check not yet graded** |

Live acceptance (F1–F3, F5–F8, F10 in the running Electron app) is the `tester` stage, not claimed here.

## Known gaps / limits to report

- **Browser mode intentionally has no terminal.** `npm run dev` in a tab shows the notice; every UI
  acceptance step must run in Electron (`npm run desktop:dev` or the packaged app).
- **Dev data root**: `npm run desktop:dev` exports `LH_DATA_DIR=./data`, so the editor and the agent share
  `<repo>/data/code/scratch` in dev (the old `…-dev` mismatch is gone). A hand-launched `next dev` +
  `electron .` without that variable still splits the two roots.
- **No paste cap**: `lh:code:write` splits a payload into ≤64 KiB code-point-safe chunks, so a large paste
  arrives complete and ordered. The cost is N/64 KiB synchronous writes on the main thread.
- **Reuse has no screen replay**: after a renderer reload with the same window size the new xterm can stay
  blank until the first keystroke forces a repaint (the reused pty keeps running).
- **Scope is fixed to `scratch`** in v1 (no per-chat workspaces), and there is **no file tree/tab UI** —
  Neovim's own Telescope/dashboard is the file UI.
- **No AI write tool**: the learner-fs posture stays read-only; the agent can open and read, not author.
- **Keymap coverage is not exhaustive**: chords bound by the compositor (Hyprland `Super+…`) and any
  `Ctrl+<key>` the OS/WM claims are outside the app's reach — same limit every embedded terminal has.
- **Clipboard**: nvim uses `wl-copy` (installed, env passed through); the learner still needs their own
  `clipboard=unnamedplus`. OSC 52 paste is not wired (the app does not grant `clipboard-read`).
- **Windows/macOS** untested (packaging entries were added for Linux/asar only; the `.node` unpack rule is
  platform-neutral).

## Recommended next steps (parent)

1. Launch `npm run desktop:dev`, drive F1–F10 with `tester` (agent_browser `electron` mode).
2. If acceptance is green: `node scripts/build-server.mjs` → `node scripts/smoke-server.mjs --electron` →
   `npx electron-builder --linux AppImage --x64`, then commit the feature on its own branch.
