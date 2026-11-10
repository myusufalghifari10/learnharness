# Plan: native coding workspace (real Neovim/LazyVim) inside LearnHarness

Branch: `local-searxng-search` (existing fork work). Owner: parent orchestrator. One writer: `worker`.

## What the system does today (verified)

Next.js 16 app (`app/` server components → `components/` client components) served either by `next dev`
(browser, port 3000) or, when packaged, by a spawned `.next/standalone/server.js` child of Electron main
(`electron/main.cjs:202-231`, `ELECTRON_RUN_AS_NODE=1`, Electron 44.9.3 = Node 24.22.0, ABI 149).
Renderer is sandboxed with `contextIsolation`, and every desktop capability goes through
`window.lh` (`electron/preload.cjs`) → `ipcMain.handle` in `main()` with a trust check
(`electron/main.cjs:691-694`). There is **no** PTY, no shell, no xterm, and no write tool in the agent.

## Chosen architecture (decisions, with reasons)

| # | Decision | Why |
|---|---|---|
| D1 | PTY lives in **Electron main** (`electron/code-session.cjs`), exposed as `window.lh.code`; a browser-only run shows an explicit notice | menu/accelerator control lives in main anyway; the server child crashing must not kill the editor; next route handlers cannot do WebSocket upgrades; matches the repo's single bridge pattern |
| D2 | Real `nvim` binary with the user's own `XDG_CONFIG_HOME`; never bundle or copy a config | user customization applies automatically; no sync |
| D3 | Two PTYs: `editor` (`nvim --listen <sock>`) and `shell` (`$SHELL -l`), both with cwd = workspace | user asked for editor + terminal |
| D4 | Workspace = `<LH_DATA_DIR>/code/<scope>/`, `scope` defaults to `scratch`, created by main | data lives with the app, survives restarts, and the agent's existing `read`/`ls`/`grep` tools already reach it (unrestricted default policy, not a sensitive path) |
| D5 | `@xterm/xterm@6.0.0` + fit + webgl + unicode11 (`allowProposedApi: true`); modules imported inside `useEffect` | 6.0.0 removed the canvas renderer; the repo has no `next/dynamic` precedent, so an effect-scoped import keeps SSR clean |
| D6 | Key fidelity: `webContents.setIgnoreMenuShortcuts(true)` while a terminal has focus, zoom `before-input-event` skipped while focused, renderer global shortcuts suppressed while focused | the app menu owns `Ctrl+C/V/X/A/Z/W/R`, `F11`, `Ctrl+0/+/-`; without this LazyVim looks broken (verified in research.md §3) |
| D7 | AI integration = existing read tools (no change) + one new narrow tool `open_in_editor` that talks to the running nvim over its `--listen` socket using a state file written by main | smallest slice that satisfies "AI can open/read practice files"; the app deliberately has no write tool and this plan does not add one |
| D8 | Font: system Nerd Font (JetBrainsMono Nerd Font Mono is installed), preloaded with `document.fonts.load` before `open()` | xterm measures glyphs synchronously and caches wrong widths otherwise |
| D9 | Packaging: add an explicit `node_modules/node-pty/**/*` positive in `electron-builder.yml` plus `asarUnpack` | the `!**/*` allow-list would otherwise drop it; a `.node` cannot dlopen from asar |

## Order of work

1. **Deps**: `node-pty@1.1.0` (N-API, compiles from source on Linux x64), `@xterm/xterm@6.0.0`,
   `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0`, `@xterm/addon-unicode11@0.9.0`.
2. **PTY core** `electron/code-session.cjs`: pure helpers (`resolveNvimBinary`, `workspaceDir`,
   `editorSocketPath`, `writeEditorState`) + a session manager (`start/write/resize/kill/killAll`,
   data/exit callbacks, `.editor.json` state, env passthrough).
3. **Shell wiring** `electron/main.cjs`: `lh:code:start|write|resize|kill|focus|state`,
   push `lh:code:data|exit`, focus-scoped `setIgnoreMenuShortcuts`, zoom-handler exemption,
   kill-all on `before-quit`/`window-all-closed`; `electron/preload.cjs` exposes `lh.code`.
4. **UI** `app/code/page.tsx` (server) → `components/code/code-view.tsx` + `components/code/terminal-pane.tsx`
   (client, effect-scoped xterm), keyboard-shortcut suppression, sidebar door + `Window.lh` type extension.
5. **Agent tool** `src/agent/tools/open-in-editor.ts` registered in `src/agent/tools.ts`; reads the state
   file, refuses paths outside the workspace, spawns `nvim --server <sock> --remote <path>` with a timeout.
6. **Tests** (see below), then `npm test`, `typecheck`, `lint`, `next build`.
7. Parent only: `build-server.mjs` + `smoke-server.mjs --electron` + `electron-builder --linux AppImage`.

## Files the worker owns

- `electron/code-session.cjs` (new), `electron/main.cjs`, `electron/preload.cjs`, `electron-builder.yml`
- `app/code/page.tsx` (new), `components/code/*` (new), `components/code-view.tsx` (new)
- `components/sidebar.tsx` (nav door + `Window.lh` type only), `components/keyboard-shortcuts.tsx`
  (suppression only), `src/core/keyboard.ts` (new action only if needed)
- `src/agent/tools/open-in-editor.ts` (new), `src/agent/tools.ts` (registration only)
- `package.json` / `package-lock.json` (the five deps)
- tests: new files only

Must NOT touch: `src/server/**` (no server-side PTY), `next.config.ts`, `app/api/**`, `config.ts`,
`src/store/**`, anything under `dist/`, `docs/coding-pane/*`.

## Tests the plan requires

1. `tests/code-session.test.ts` — real `node-pty` spawn under system Node: write `echo` into `bash`, read
   output, resize, kill; plus `resolveNvimBinary` / `workspaceDir` / state-file unit cases.
2. `tests/code-ipc.test.ts` — fake `ipcMain`/`BrowserWindow` harness (precedent
   `tests/browser-service-lifetime.test.ts`): trust check rejects foreign senders, start/write/resize route
   to the session manager, focus toggles `setIgnoreMenuShortcuts`.
3. `tests/open-in-editor-tool.test.ts` — injected exec stub: in-workspace path opens, traversal/absolute
   outside path refused, missing state file returns a clear error.
4. `tests/code-view.test.tsx` — `renderToStaticMarkup` with no bridge: notice rendered, no crash.

## Explicitly out of scope

- A file-tree/buffer sidebar, multiple tabs, split-direction choice, workspace file CRUD, an AI write tool.
- Windows/macOS verification (Linux x64 only), auto-update changes, settings UI for font or nvim path.
- `nvim --listen` msgpack streaming into the React tree (future phase; only the one-shot `--remote` is used).
- Committing/merging: the parent does that after acceptance.

## Verification gates (must all be green before review)

```
npm test
npm run typecheck
npm run lint
npm run build
```
