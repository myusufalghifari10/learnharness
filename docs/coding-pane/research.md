# Research: embedding a real Neovim editor in the Electron 44 + Next 16 desktop app

Research date: 2026-11-11. Scope: external evidence only. No repo edits were made beyond this file.
Tag legend: **VERIFIED** = 2+ independent sources or 1 primary source plus corroboration. **UNVERIFIED** = single source, or my inference from source code/packaging behaviour. Inferences are labelled as such.

## Pinned environment (read from this repo, 2026-11-11)

| Fact | Value | Evidence |
|---|---|---|
| Electron | 44.9.3 installed (`node_modules/electron/package.json`), `abi_version` = **149** | local |
| Electron 44.9.3 upstream facts | Chromium 152.0.7977.167, **Node 24.22.0**, `modules` (NODE_MODULE_VERSION) **149**, released 2026-10-21 | https://releases.electronjs.org/releases.json |
| electron-builder | 26.16.1 (exact pin) | `package.json` |
| Next / React / TS | next 16.4.3, react 19.2.8, typescript 5.6 | `package.json`, `node_modules/*/package.json` |
| Local Node | v22.23.4 (CachyOS, Arch-based, Wayland) | `node --version`, `/etc/os-release` |
| App license | AGPL-3.0-only | `package.json` |
| Server process model | main.cjs spawns `.next/standalone/server.js` via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (Electron's Node 24) | `electron/main.cjs:204-229` |
| Server shipping | `.next/standalone/**` rides as `extraResources` to `Resources/server`, i.e. **unpacked, outside the asar** | `electron-builder.yml` |
| asar contents | `"!**/*"` then only `electron/**`, `package.json`, and an explicit electron-updater dep tree. **node_modules is otherwise excluded** | `electron-builder.yml` |
| App menu | Edit roles (cut/copy/paste/selectAll/undo/redo), View (`reload`, `toggleDevTools`, owned zoom `Ctrl+0/+/-`), `togglefullscreen`, `windowMenu`, `quit` | `electron/main.cjs:586-632` |
| Permission policy | allow-list `{media, clipboard-sanitized-write, local-fonts}`, own origin only. **`clipboard-read` is NOT granted** | `electron/main.cjs:353-362` |

---

## 1. node-pty

**1.1 Current stable: `node-pty@1.1.0`, published 2025-12-22, MIT, single runtime dep `node-addon-api@^7.1.0`.**
VERIFIED: npm registry document for `node-pty` (`dist-tags.latest = 1.1.0`, `time["1.1.0"] = 2025-12-22T13:51:43Z`, `license: MIT`), cross-checked against the published tarball's own `package.json`.
Beta line at the same time: `1.2.0-beta.18`, published 2026-10-23 (same registry, `dist-tags.beta`).

**1.2 Prebuilt binaries: yes for macOS/Windows, NO for Linux in 1.1.0.**
VERIFIED by unpacking both tarballs from the registry (primary artifact):
- `node-pty-1.1.0.tgz` → `prebuilds/` contains exactly `darwin-arm64` (`pty.node`, `spawn-helper`), `darwin-x64` (`pty.node`, `spawn-helper`), `win32-arm64`, `win32-x64`. **There is no `linux-x64` directory.**
- `node-pty-1.2.0-beta.18.tgz` → `prebuilds/` contains `darwin-arm64`, `darwin-x64`, **`linux-x64` (`pty.node`)**, **`linux-arm64`**, `win32-arm64`, `win32-x64`.

Consequence for 1.1.0 on this machine: `npm install` runs `install: "node scripts/prebuild.js || node-gyp rebuild"`; `scripts/prebuild.js` exits 1 when `prebuilds/<platform>-<arch>` is missing, so **node-gyp compiles from source on Linux x64**. VERIFIED (script body read from the 1.1.0 tarball).
Consequence for 1.2.0-beta.18: the prebuild exists, the install script exits 0, **no compiler needed**. VERIFIED (same method).

**1.3 Linux build dependencies beyond gcc/make/python3: none, per the project's own docs.**
VERIFIED (node-pty README, https://github.com/microsoft/node-pty#dependencies): Linux needs `make python build-essential`; macOS needs Xcode; Windows needs Python + VS C++ + Windows SDK + Spectre libs. node-pty's `binding.gyp` links `-lutil` on Linux (part of glibc, nothing extra to install) and only builds `spawn-helper` on macOS.
Additional requirement from the tooling side: `@electron/rebuild` requires **Node >= 22.12.0** (https://github.com/electron/rebuild#what-are-the-requirements). Local Node is 22.23.4, so satisfied. VERIFIED.
On CachyOS the practical package set is `base-devel` (gcc, make, patch, pkgconf) plus `python3`; both are usually already present.

**1.4 Electron 44 compatibility: node-pty is Node-API (node-addon-api), so the ABI question is mostly moot.**
- node-pty's `binding.gyp` depends on `node_addon_api_except` (i.e. N-API), not NAN. VERIFIED (binding.gyp in the 1.1.0 tarball).
- Node-API is "independent from the underlying JavaScript runtime ... ABI stable across versions of Node.js". VERIFIED, official: https://nodejs.org/api/n-api.html (and https://github.com/nodejs/abi-stable-node).
- Two independent real-world migrations state the same conclusion for node-pty specifically: "node-pty 1.1.0 is Node-API (node-addon-api ^7) ... so it needs no Electron-ABI rebuild" (https://github.com/HarnessMD/munder-difflin/pull/252) and "beta39 is where node-pty switched from nan to node-addon-api. Node-API is ABI-stable across Node and Electron, so the rebuild was producing a binary functionally [identical]" (https://github.com/coder/xum/pull/4309). VERIFIED (2 independent sources).
- Electron 44.9.3 ships `NODE_MODULE_VERSION` 149 (Node 24.22.0), while a local `node-gyp rebuild` under system Node 22 targets ABI 127. That mismatch is irrelevant for an N-API addon but fatal for a NAN addon. VERIFIED for the versions; the "irrelevant for N-API" step follows from the Node-API guarantee above.

**1.5 electron-builder 26.16.1 rebuild story: yes, it rebuilds automatically, unless you turn it off.**
VERIFIED against the *installed* `app-builder-lib` 26.16.1 (not docs):
- `configuration.d.ts`: `npmRebuild?: boolean` with `@default true`; `buildDependenciesFromSource?: boolean` with `@default false`.
- `out/packager.js` → `installAppDependencies()`: returns early if `prepackaged` or the framework does not need it; logs "skipped dependencies rebuild" and returns when `npmRebuild === false`; otherwise calls `installOrRebuild(...)`.
- `out/util/yarn.js` → `rebuild()`: logs `executing @electron/rebuild` and calls `@electron/rebuild` with `{ buildPath, electronVersion, arch, platform, buildFromSource, projectRootPath, mode }`, `buildFromSource = config.buildDependenciesFromSource === true` (so `false` by default, which means @electron/rebuild is allowed to download a prebuild before falling back to source).
- CLI command exists: `npx electron-builder install-app-deps` ("Install app deps") in the installed 26.16.1 binary.
Practical: `installAppDependencies` rebuilds the project's `node_modules` **in place** against the target Electron (`buildPath: appDir`), and only afterwards does the `files` filter decide what ships. With this repo's `"!**/*"` filter those rebuilt modules never enter the asar, so the rebuild is a dev-tree side effect that still costs time on every `desktop:dist`. Putting `"postinstall": "electron-builder install-app-deps"` is the documented way to keep the dev tree matched at install time instead (https://www.electron.build/docs/). Because node-pty is N-API, a binary rebuilt for Electron ABI 149 also keeps working under a later plain `node` run, so the in-place rewrite is harmless here.

**1.6 asarUnpack: not strictly required (Electron can extract-and-dlopen), but you should not rely on that.**
- Electron's asar docs list `process.dlopen` ("used by `require` on native modules") under *Extra Unpacking on Some APIs*, i.e. Electron copies the `.node` to a temp file and loads it from there: https://www.electronjs.org/docs/latest/tutorial/asar-archives. VERIFIED.
- electron-builder 26.16.1 auto-unpacks any module directory containing `.dll/.exe/.dylib/.so/.node` (`out/asar/unpackDetector.js`, `isLibOrExe`), so `node-pty` is unpacked automatically **if it ships inside the asar at all**. VERIFIED (installed source).
- This repo is the special case: `"!**/*"` precedes every positive, so nothing from `node_modules` reaches the asar unless explicitly re-included (the same trick used for `electron-updater`). If node-pty is required from the **main process**, it needs both a positive include and an `asarUnpack` entry. If node-pty is required from the **standalone server**, it ships under `Resources/server/node_modules/node-pty/...` (no asar at all) and needs no asar work. VERIFIED for the mechanism (electron-builder.yml + app-builder-lib source); the two placement consequences are inference (labelled).

**1.7 Host process: Electron main or an `ELECTRON_RUN_AS_NODE` child both work, and so does a plain `node` child.**
- `ELECTRON_RUN_AS_NODE=1` "Starts the process as a normal Node.js process", gated by the `runAsNode` fuse (https://www.electronjs.org/docs/latest/api/environment-variables). VERIFIED.
- Because the child is still the Electron binary, it loads Electron's Node (24.22.0) with Electron's ABI; main-process loading is the same runtime. With Node-API, a binary compiled against Node 22 headers loads in all three hosts. VERIFIED for the mechanism (Node-API guarantee + Electron docs); the "same binary, hence same ABI" step is reading Electron's docs plus `abi_version` 149.
- node-pty explicitly supports Electron usage and ships an example that runs node-pty in the main process with xterm.js in the renderer over IPC: https://github.com/microsoft/node-pty/tree/main/examples/electron (README: "using xterm.js on the renderer process and node-pty on the main process with IPC"). VERIFIED.
- Caveat that matters here: their `main.cjs` comment says the `runAsNode` fuse must stay enabled, which is consistent with the spawn model. VERIFIED (repo).

**1.8 Repo-specific warning: Next's tracer cannot see node-pty's native binary.**
node-pty loads its addon through a runtime-built path: `require(dir + '/' + name + '.node')` over `['build/Release', 'build/Debug', 'prebuilds/<platform>-<arch>']` (`lib/utils.js` in the 1.1.0 tarball). Static tracing therefore sees no `.node` file, so `.next/standalone` would contain node-pty's JS but not `build/Release/pty.node`, and the server would die with `Failed to load native module: pty.node`. Mitigation is the documented escape hatch `outputFileTracingIncludes` (present in Next 16.4.3: `node_modules/next/dist/server/config-shared.d.ts:1787`, documented at `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md`). **UNVERIFIED** as a live failure: not tested here (no installs allowed). This is the first thing to verify empirically.

---

## 2. @xterm/xterm

**2.1 Package name: `@xterm/xterm`. The unscoped `xterm` and `xterm-*` packages are deprecated.**
VERIFIED: xterm.js 5.4.0 release notes ("The package has been migrated to the `@xterm` scope ... the old `xterm` and `xterm-*` packages are now deprecated and will no longer be maintained ... mainly for security reasons ... typosquatting"), https://github.com/xtermjs/xterm.js/releases/tag/5.4.0 ; npm registry confirms the scoped names publish today while unscoped `xterm` is frozen.

**2.2 Current version: `@xterm/xterm@6.0.0`, published 2025-12-22, MIT.**
VERIFIED (npm registry, `dist-tags.latest = 6.0.0`; tarball `package.json`). A `6.1.0-beta.337` exists (2026-11-08) but is a beta. Package shape: `main: lib/xterm.js`, `module: lib/xterm.mjs` (ESM via esbuild, PR #5092), `types: typings/xterm.d.ts`, **no `exports` map**, CSS at `css/xterm.css`. VERIFIED (tarball).

**2.3 Breaking changes in 6.0.0 that matter for an editor pane.**
VERIFIED from https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 :
- **The canvas renderer is gone**: PR #5105 "Remove the canvas renderer ... this addon no longer exists and we recommend using either the DOM renderer or WebGL". Corroborated by npm: `@xterm/addon-canvas` latest is 0.7.0 from 2024-04-05 with `peerDependencies: {"@xterm/xterm": "^5.0.0"}` and no 6.x release. **Do not install addon-canvas.**
- `windowsMode` and `fastScrollModifier` removed (PR #5462).
- `overviewRulerWidth` moved into `overviewRuler` (PR #5107).
- Viewport/scrollbar rewrite (PR #5096, "potential breaking change").
- **Alt+arrow no longer mapped to ctrl+arrow** (PR #5346); embedders must add those bindings themselves. Directly relevant to section 3.
- Additions that help here: synchronized output (DEC mode 2026), OSC 52 support (PR #4220), ESM build.

**2.4 Addons required for a usable editor pane, all MIT, all published 2025-12-22 in lockstep with 6.0.0.**
VERIFIED (npm registry for each package, plus tarball `package.json`): `@xterm/addon-fit@0.11.0`, `@xterm/addon-webgl@0.19.0`, `@xterm/addon-unicode11@0.9.0`, `@xterm/addon-web-links@0.12.0`, `@xterm/addon-search@0.16.0`, `@xterm/addon-clipboard@0.2.0` (runtime dep `js-base64@^3.7.5`). None of them declare `peerDependencies`, so npm will not enforce the xterm version; version alignment has to be trusted, which is why the 6.0.0 date is the useful signal.

Two gotchas found in the shipped code:
- **`addon-unicode11` requires `allowProposedApi: true`.** Its `activate()` calls `terminal.unicode.register(...)`, and the `unicode` getter in `src/browser/public/Terminal.ts` starts with `this._checkProposedApi()`, which throws `You must set the allowProposedApi option to true to use proposed API` when the option is false (6.0.0 typings also document the option as default `false`). VERIFIED (tarball source: `Terminal.ts`, `typings/xterm.d.ts:24-32`, addon `Unicode11Addon.ts`).
- **`addon-clipboard` does NOT need `allowProposedApi`.** It registers OSC 52 through `term.parser.registerOscHandler(52, ...)`, and the `parser` getter does *not* call `_checkProposedApi()` (only `unicode` and `markers` do). VERIFIED (same files).
- `@xterm/addon-web-fonts@0.1.0` (2026-01-04) exists but declares `peerDependencies: {"@xterm/xterm": "^6.1.0-beta.86"}`, so it is **not** usable with 6.0.0 even though its README says "requires xterm.js v5+". VERIFIED (registry + tarball README). Plan manual font preloading instead (section 5).

**2.5 Bundling in Next 16 with React 19.**
- `ssr: false` with `next/dynamic` works **only inside a Client Component**; using it in a Server Component errors. VERIFIED against the installed docs: `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` ("`ssr: false` is not allowed with `next/dynamic` in Server Components. Please move it into a Client Component."). This matches Next 15/16 behaviour and is required anyway because xterm touches `document` at import time.
- CSS from `node_modules` is importable anywhere: "Since Next.js 9.5.4, importing a CSS file from `node_modules` is permitted anywhere in your application" (`node_modules/next/dist/docs/01-app/01-getting-started/11-css.md:356-358`). So `import "@xterm/xterm/css/xterm.css"` inside the client component is fine. VERIFIED.
- xterm ships ESM (`module: lib/xterm.mjs`) with no `exports` map, so deep CSS imports resolve; no `transpilePackages` is needed for the package itself. **UNVERIFIED** as a build result (not built here); the package metadata (VERIFIED) is the reason to expect it to work.
- Practical shape: `"use client"` wrapper, `const TerminalPane = dynamic(() => import("./terminal-pane"), { ssr: false, loading: ... })`, and instantiate the `Terminal` inside `useEffect` after the container has dimensions.

---

## 3. Key handling (making LazyVim keybindings survive the host app)

**3.1 `attachCustomKeyEventHandler` is the per-terminal hook, and it runs before xterm's own key processing.**
VERIFIED from the 6.0.0 typings (`typings/xterm.d.ts:1049-1072`): "Attaches a custom key event handler which is run before keys are processed, giving consumers of xterm.js ultimate control as to what keys should be processed by the terminal and what keys should not ... returns whether the event should be processed by xterm.js." Returning `false` means xterm ignores the key; returning `true` lets xterm send its mapping. Calling `event.preventDefault()` / `stopPropagation()` there is the documented way to claim a chord for the app shell.

**3.2 Electron consumes application-menu accelerators in the MAIN process before the renderer sees keydown. This is the single biggest threat to a terminal pane in this repo.**
VERIFIED mechanism, official: `before-input-event` "Calling `event.preventDefault` will prevent the page `keydown`/`keyup` events **and the menu shortcuts**", and `webContents.setIgnoreMenuShortcuts(ignore)` exists to "Ignore application menu shortcuts while this web contents is focused" (https://www.electronjs.org/docs/latest/api/web-contents).
VERIFIED in the wild: three independent projects report exactly this failure mode.
- "Electron resolves application-menu accelerators in the main process before the renderer's keydown, so the keystroke was consumed by the role and never reached xterm.js. As a result `\x03` (ETX -> SIGINT) was never written to the PTY" (https://github.com/Untrivial-ai/agent-orchestrator/pull/3678).
- "Ctrl+C is owned by `role: "copy"`; [the app] cannot ... forward it as SIGINT (0x03) to a terminal pane's child process" (https://github.com/getpaseo/paseo/issues/4234).
- Same diagnosis and the `before-input-event` fix proposed (https://github.com/OrchestratorInc/agent-orchestrator/issues/3659).

**3.3 The exact chords this app's own menu registers (so they will be swallowed).**
VERIFIED against the Electron v44.9.3 role table (`lib/browser/api/menu-item-roles.ts` at tag v44.9.3), cross-referenced with the template in `electron/main.cjs:586-632`:

| Role in this app's menu | Registered accelerator (CmdOrCtrl = Ctrl on Linux) | What it steals from Neovim |
|---|---|---|
| `copy` | `Ctrl+C` | SIGINT (and vim `CTRL-C` to leave insert mode) |
| `paste` | `Ctrl+V` | vim visual-block mode / shell quoted-insert |
| `cut` | `Ctrl+X` | vim decrement / shell prefix |
| `selectAll` | `Ctrl+A` | vim increment / tmux prefix / readline home |
| `undo` | `Ctrl+Z` | shell suspend (SIGTSTP) / vim suspend |
| `redo` | `Shift+Ctrl+Z` (Ctrl+Y on Windows) | redo bindings |
| `reload` | `Ctrl+R` | vim redo |
| `forceReload` | `Shift+Ctrl+R` | (not a vim default, still a reload trap) |
| `toggleDevTools` | `Ctrl+Shift+I` (non-mac) | `gI`-adjacent chords, plugin binds |
| `togglefullscreen` | `F11` | (usually unbound in vim, still consumed) |
| `close` / `minimize` / `windowMenu` | `Ctrl+W`, `Ctrl+M`, window menu | `Ctrl+W` is vim's window-prefix, the worst one |
| owned zoom | `Ctrl+0`, `Ctrl+Plus`, `Ctrl+-` | `Ctrl+-` / `Ctrl+0` vim motions |

Mitigations, in order of robustness:
1. `win.webContents.setIgnoreMenuShortcuts(true)` while the terminal pane has focus (documented API above), restoring `false` on blur. Kills every row in that table while typing.
2. `win.webContents.on('before-input-event', ...)` + `event.preventDefault()` for a targeted allow/deny list (same docs, same layer).
3. Do not put conflicting accelerators on the menu at all: on Linux the Edit roles are only needed for text fields; a custom Edit menu with `registerAccelerator: false` is possible, but then `Ctrl+C` stops working in normal inputs too. This is a product trade-off, not a research call.

**3.4 How the reference implementations solve it.**
- **VS Code**: a per-command allow list, `terminal.integrated.commandsToSkipShell` (default is a hard-coded list of "commands integral to the VS Code experience"), the nuclear override `terminal.integrated.sendKeybindingsToShell` ("dispatch most keyboard shortcuts to the shell ... will disable shortcuts like Ctrl+F to open find"), `terminal.integrated.allowChords`, and `terminal.integrated.allowMnemonics` which is **off by default** because "these key events are often important hotkeys in shells ... note that this will disallow any Alt key events to go to the shell" (i.e. the Linux/Windows menu mnemonics swallow Alt). VERIFIED: https://code.visualstudio.com/docs/terminal/advanced
- **Hyper**: `this.term.attachCustomKeyEventHandler(this.keyboardHandler)` where `keyboardHandler(e) { return !e.catched; }` and `e.catched` is set by its Mousetrap-based keymap layer, i.e. "the outer command layer stamps the event, the terminal refuses it". VERIFIED from source: https://raw.githubusercontent.com/vercel/hyper/canary/lib/components/term.tsx (lines 214, 419-422). Note Hyper is still on xterm 5 and loads `CanvasAddon` / `windowsMode`, so its code is not a drop-in on 6.0.0.
- **Tabby**: not verified in this pass. Do not cite it.

**3.5 What is NOT solvable.**
- **Hyprland binds are consumed by the compositor.** The bind system documents consumption explicitly: dispatchers can return `ok`, and "when the `auto_consuming` flag is set, `hl.bind` checks that value to determine whether the keypress should be consumed or passed on ... otherwise, it will pass `p` to the active window" (https://wiki.hypr.land/configuring/core/binds/). Default behaviour is consume; only `auto_consuming` + `return { ok = false }` passes a key through. Any chord the user binds in `hyprland.conf` (typically `SUPER+*`) never reaches Electron. VERIFIED (Hyprland wiki).
- **Wayland denies global key grabs to applications by design.** Independent reports: "This is a Wayland security design, applications cannot grab global keyboard shortcuts directly. The compositor must mediate all global keybindings" (https://github.com/cjpais/Handy/issues/949, listing Sway/Hyprland/wlroots), "On Wayland, apps cannot register global hotkeys. The compositor owns global keybindings" (https://github.com/silverstein/minutes/issues/64), and an empirical Electron 39 + Hyprland 0.56 report where `globalShortcut.register(...)` returns `true` yet "the compositor never delivers the key" (https://github.com/TheOrcDev/videorc/pull/1206). VERIFIED (3 independent sources). Consequence: no app-side fix, only documentation ("bind this in Hyprland instead").
- **Electron main-process menu accelerators when `setIgnoreMenuShortcuts`/`before-input-event` are not used**: same as 3.2, unsolvable by the renderer.
- **`Alt+<key>` under a window manager that maps Alt to menu mnemonics** (X11 mostly; less relevant on Wayland/Hyprland): VS Code's `allowMnemonics` note is the evidence that this is a known, app-level trade-off. VERIFIED (VS Code docs).
- Other real limits worth stating in-app: IME/compose input, dead keys and `Ctrl+Alt` AltGr layouts produce platform-dependent `event.key`/`code` values; xterm maps keys via `code` on Linux (`e.key` on Windows) per VS Code's keybinding notes (https://github.com/microsoft/vscode/wiki/Keybinding-Issues). VERIFIED (single authoritative project wiki, treat as UNVERIFIED-grade for the claim about xterm specifically).

---

## 4. Clipboard + Wayland: OSC 52 vs wl-copy

**4.1 Neovim already has both paths, and on this machine the simpler one is `wl-copy`.**
VERIFIED against Neovim's own docs (https://neovim.io/doc/user/provider.html):
- Clipboard tool priority: `pbcopy`, then **`wl-copy`/`wl-paste` (if `$WAYLAND_DISPLAY` is set)**, then `wayclip`, `xsel`, `xclip`, `lemonade`, `doitclient`, `win32yank`, `putclip`, `clip`, `termux`, `tmux`, then `osc52` (last, "if supported by your terminal").
- "The presence of a working clipboard tool implicitly enables the `+` and `*` registers."
- So `set clipboard+=unnamedplus` works with zero app code as soon as `wl-clipboard` is installed and `WAYLAND_DISPLAY` reaches the child. node-pty passes the parent environment through (`opt.env = opt.env || process.env` in `lib/unixTerminal.js`), so an Electron app launched from the Wayland session propagates `WAYLAND_DISPLAY` to nvim. VERIFIED for the code, inference for the session propagation.

**4.2 OSC 52 in Neovim: bundled provider, auto-detected only in the TUI.**
VERIFIED (same page): "Nvim bundles a clipboard provider that allows copying to the system clipboard using OSC 52 ... When Nvim is running in the TUI, it automatically detects host terminal support for OSC 52 ... **NOTE:** Using a terminal multiplexer (e.g. tmux) may inhibit automatic OSC 52 support detection." Disable detection with `vim.g.termfeatures.osc52 = false`; force the provider with `vim.g.clipboard = 'osc52'` (equivalent to `require('vim.ui.clipboard.osc52').copy/paste`). Pasting has an explicit caveat: "not all terminal emulators support reading from the system clipboard ... so using OSC 52 for pasting may not be possible".

**4.3 OSC 52 in xterm.js 6.0.0: `@xterm/addon-clipboard@0.2.0` only, write path only in this app.**
VERIFIED by reading the addon's shipped bundle:
- `activate()` does `terminal.parser.registerOscHandler(52, data => this._setOrReportClipboard(data))`; the parser splits `selection;base64`, decodes with js-base64, and calls the provider.
- `BrowserClipboardProvider` is `async writeText(kind, text) { if (kind !== 'c') return; await navigator.clipboard.writeText(text) }` and `async readText(kind) { if (kind !== 'c') return ''; return navigator.clipboard.readText() }`. Only the system (`c`) selection is supported; others are silently empty.
- Reporting a query (`?`) calls `terminal.input("]52;<sel>;<b64>", false)`, i.e. the reply goes back into the pty.
Note for readers of the 6.0.0 changelog: the line "#4220 Add support to ANSI OSC52" describes this **addon-level** mechanism, not core behaviour. The 6.0.0 `typings/xterm.d.ts` exposes no OSC 52 or clipboard API at all (grep for `osc52` and `clipboard` returns nothing), and the core `InputHandler` registers OSC handlers for 0/1/2/4/8/10/11/12/104/110/111/112 only, never 52. So OSC 52 exists in xterm.js 6.0.0 only if `addon-clipboard` is loaded. VERIFIED (typings + `src/common/InputHandler.ts` + the addon bundle).
Consequences in **this** app: `navigator.clipboard.writeText` maps to Electron's `clipboard-sanitized-write` permission, which the repo **grants**; `navigator.clipboard.readText` maps to `clipboard-read`, which the repo **does not grant** (allow-list is `{media, clipboard-sanitized-write, local-fonts}`). So OSC 52 copy-out can work, OSC 52 paste-in will be rejected by the app's own policy. VERIFIED for the permission names (Electron 44.9.3 `electron.d.ts` enumerates `'clipboard-read' | 'clipboard-sanitized-write' | ...`) and for the repo policy; the "maps to" step is Chromium permission mapping (inference, labelled).

**4.4 Decision matrix (facts, not a product call).**

| Path | Works when | Cost / risk |
|---|---|---|
| `wl-copy` / `wl-paste` (nvim default when `WAYLAND_DISPLAY` set) | pty is **local** (this app: local pty, local nvim) | Requires `wl-clipboard` on PATH; it is **GPL-3.0-or-later** (https://github.com/bugaevc/wl-clipboard README), so require it as a system dependency and do not bundle it into the AppImage without its license |
| OSC 52 via `addon-clipboard` | works across ssh/tmux/remote, terminal-mediated | Needs the addon, `navigator.clipboard` permissions, is capped by xterm's 10 MB OSC payload ("xterm.js limits OSC payload to 10 MB", `typings/xterm.d.ts`), and read-back needs `clipboard-read` plus terminal support |
| Neovim's `+`/`*` registers with no tool and no OSC 52 | never | `has('clipboard')` is false and yanks stay inside nvim |

**4.5 Wayland-specific clipboard caveats.**
- OSC 52 goes through the browser clipboard, so it needs a focused, visible document and the `clipboard-sanitized-write` permission; the pty path (`wl-copy`) bypasses the browser entirely and works regardless of window focus. UNVERIFIED (inference from the permission model; not measured).
- `wl-copy` is a separate process talking to the compositor, so the clipboard survives app restarts only as long as that process lives. **UNVERIFIED**: I could not fetch the `wl-copy(1)` man page (not in the repo tree) to quote the fork/serve behaviour.

---

## 5. Nerd Font rendering in the canvas/WebGL terminal

**5.1 What must be configured.**
- `fontFamily`: quote families with spaces, e.g. `'"JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", monospace'`. Known-good naming shown by a real deployment: "JetBrainsMono Nerd Font Mono" (https://forum.proxmox.com/threads/change-fonts-of-xterm-js.121134/). Basic CSS quoting, UNVERIFIED as a "must" but universally used.
- `fontSize`, `lineHeight`, `letterSpacing` are all real options in 6.0.0 (`typings/xterm.d.ts:123,145,150`). VERIFIED.
- `customGlyphs` (default true) controls box-drawing / block-element glyph rendering (`typings/xterm.d.ts:87`). VERIFIED.
- `rescaleOverlappingGlyphs` exists in 6.0.0 (`typings/xterm.d.ts:231`) and is the knob for wide icon glyphs overflowing their cell; a real project reports it "would also keep wide icon glyphs inside their cell" (https://github.com/inkeep/open-knowledge/issues/2397). VERIFIED (option) / UNVERIFIED (efficacy in our setup).
- **`@xterm/addon-unicode11@0.9.0` is required for correct East-Asian/emoji widths**, and it forces `allowProposedApi: true` (section 2.4). VERIFIED.

**5.2 The real pitfall: font metrics are measured and cached on first use, synchronously.**
VERIFIED, from the xterm authors themselves (`@xterm/addon-web-fonts` README, https://www.npmjs.com/package/@xterm/addon-web-fonts): "xterm.js ... heavily relies on exact measurement of character glyphs ... both is done in synchronous code and cached. This logic only works properly, if a font glyph is available on its first usage, otherwise the browser will pick a glyph from a fallback font messing up the metrics. For webfonts and xterm.js this means that we cannot rely on the default loading strategy of the browser, but have to preload the font files before using that font in xterm.js."
The matching symptom class is documented upstream: wide Nerd Font glyphs "cut to single width" (https://github.com/xtermjs/xterm.js/issues/3342), and a project-level write-up of the same bug ("The bundled font only starts loading when a Nerd Font glyph first appears ... the wrong width stays cached for the life of the terminal", https://github.com/ryan-stoffel/parallax/pull/482). VERIFIED (3 sources).
Mitigation for 6.0.0, since `addon-web-fonts` needs 6.1 betas: either
(a) prefer a **system-installed** Nerd Font (Arch: `ttf-jetbrains-mono-nerd` / `ttf-nerd-fonts-symbols`) so there is no webfont load at all, or
(b) if bundling a font, `await document.fonts.load('12px "JetBrainsMono Nerd Font"')` (and `document.fonts.ready`) **before** `new Terminal(...).open(el)`, and re-measure afterwards if the family changes.
UNVERIFIED as a working recipe in this app (not executed).

**5.3 Renderer choice after 6.0.0.**
WebGL (`@xterm/addon-webgl@0.19.0`) is the only GPU renderer left; the DOM renderer is the built-in fallback. WebGL keeps a glyph texture atlas, so after a font or font-size change call `term.clearTextureAtlas()` (`Terminal` API list, https://xtermjs.org/docs/api/terminal/classes/terminal/) and handle context loss: the addon exposes `onContextLoss`, and the documented pattern is `webglAddon.dispose()` then fall back (Hyper does exactly this, `term.tsx:224-234`). VERIFIED (typings expose `onContextLoss`, `textureAtlas`, `onChangeTextureAtlas`; Terminal API includes `clearTextureAtlas`).

---

## 6. Terminal resize

**6.1 The kernel contract: setting the pty size sends SIGWINCH to the foreground process group.**
VERIFIED, primary: `TIOCSWINSZ` man page, "When the window size changes, a SIGWINCH signal is sent to the foreground process group" (https://man7.org/linux/man-pages/man2/TIOCSWINSZ.2const.html). node-pty's Unix path is `UnixTerminal.prototype.resize = function (cols, rows) { ... pty.resize(this._fd, cols, rows) ... }` (`lib/unixTerminal.js` in the 1.1.0 tarball), and the native side issues that ioctl. Nothing else is required on the app side: no manual SIGWINCH, no `stty`.
Pass the initial size at spawn (`pty.spawn(file, args, { cols, rows, name: 'xterm-256color', cwd, env })`) so the child's first ioctl matches reality, then keep it in sync.

**6.2 Wiring.**
`term.onResize(({cols, rows}) => ptyProcess.resize(cols, rows))` plus `term.resize(cols, rows)` from the fit addon. xterm's own advice in the typings: "It's best practice to debounce calls to resize, this will help ensure that the pty can respond to the resize event before another one occurs" (`typings/xterm.d.ts`, `resize()` docblock). VERIFIED.

**6.3 The fit-addon timing pitfall, from the addon's own source (`@xterm/addon-fit@0.11.0`, `src/FitAddon.ts`).**
VERIFIED by reading the shipped source:
- `proposeDimensions()` returns `undefined` when the terminal is not activated, when `!terminal.element || !terminal.element.parentElement`, or when the measured cell size is `0x0` (font not measured yet / element not rendered).
- `fit()` returns silently if `dims` is undefined **or** if `cols`/`rows` are `NaN`. There is no exception, so a mis-timed `fit()` looks like "nothing happens".
- `proposeDimensions()` computes geometry from `window.getComputedStyle(parent).height/width` through `parseInt`. A parent whose computed height is `auto` yields `NaN`, which then trips the `isNaN` guard in `fit()`.
- 0.11.0 reads `this._terminal.options.overviewRuler?.width`, which is the 6.x option shape (5.x used `overviewRulerWidth`), confirming the addon is built for 6.0.0. VERIFIED.
Practical rules: call `fit()` only after `open()` and after the container has a definite pixel height (`flex-1` + `min-h-0` inside a fixed-height pane, not `height: auto`); re-fit on `ResizeObserver` with a short debounce; expect the first `fit()` before fonts load to be wrong (section 5.2); ignore the `undefined` return rather than treating it as success.

---

## 7. Licensing (app is AGPL-3.0-only)

| Component | License | Effect on an AGPL app |
|---|---|---|
| `node-pty` (any version 1.x) | **MIT** | none, permissive |
| `@xterm/xterm` 6.0.0 | **MIT** | none |
| `@xterm/addon-fit`, `-webgl`, `-unicode11`, `-web-links`, `-search`, `-clipboard` | **MIT** | none |
| `@xterm/addon-web-fonts` | **MIT** (but peer-incompatible with 6.0.0) | none |
| `js-base64` (dep of addon-clipboard) | **BSD-3-Clause** (registry: latest 3.9.6, 2026-11-01) | none |
| **LazyVim** | **Apache-2.0** | compatible; ship the license + any NOTICE when distributing its config |
| **Neovim** | **Apache-2.0**, except parts contributed under the **Vim license** (charityware) | compatible with GPL/AGPL; keep license texts if you redistribute the binary |
| **wl-clipboard** (if you bundle it) | **GPL-3.0-or-later** | the only real copyleft item in this stack: fine as a user-installed system dependency (separate program), a distribution obligation if bundled |

Details and sources:
- node-pty MIT, xterm MIT and every addon MIT: VERIFIED from the npm registry documents (each package's `license` field) and the LICENSE files inside the tarballs.
- LazyVim Apache-2.0: VERIFIED, https://raw.githubusercontent.com/LazyVim/LazyVim/main/LICENSE (full Apache 2.0 text).
- Neovim: VERIFIED, https://github.com/neovim/neovim/blob/master/LICENSE.txt, "Neovim is licensed under the terms of the Apache 2.0 license, except for parts of Neovim that were contributed under the Vim license"; the same file lists bundled libraries including `xdiff: LGPL v2` and `(Deprecated) unibilium: LGPL v3`.
- Apache-2.0 into a GPLv3-family work: FSF, "This is a free software license, compatible with version 3 of the GNU GPL" (https://www.gnu.org/licenses/license-list.html#apache2). VERIFIED. AGPLv3 is GPLv3 plus the network paragraph, so the same combination rule applies; that last step is my reading of AGPLv3 section 13, labelled inference.
- Vim license: FSF, "This is a free software license, partially copyleft but not really. It is compatible with the GPL, by an explicit conversion clause" (https://www.gnu.org/licenses/license-list.html#Vim). VERIFIED.
- wl-clipboard GPL-3.0-or-later: VERIFIED, https://github.com/bugaevc/wl-clipboard README ("available under the GNU General Public License version 3 or later").
- LGPL bits (`xdiff`, `unibilium`) live inside the Neovim executable, which this app would ship as a separate program, so no linking obligation flows into the Electron app. **UNVERIFIED** legally (no counsel consulted); the architectural separation is what matters.

**Nothing copyleft is required in the npm dependency set.** The AGPL exposure in this feature is: (a) if the app ships a bundled `wl-clipboard` or Neovim binary, carry their licenses and, for the GPL program, its source offer; (b) if LazyVim configs ship, include Apache-2.0 + NOTICE.

---

## 8. Neovim control surface for a later phase (note only, not implemented)

VERIFIED from https://neovim.io/doc/user/remote.html :
- `nvim --listen {addr}` starts a server on a named pipe or socket; `nvim --server {addr} --remote {file}` edits in the running instance.
- `--remote-send {keys}`: "Send `{keys}` to server and exit. The `{keys}` are **not mapped**. Special key names are recognized, e.g. `<CR>` results in a CR character."
- `--remote-expr {expr}`: "Evaluate `{expr}` in server and print the result on stdout."
- `--remote-ui`: "Display the UI of the server in the terminal. Fully interactive: keyboard and mouse input are forwarded to the server."
- `--server` is required for all of the above; each invocation is a short-lived CLI client.

Practical limits (documented facts plus labelled inference):
- `--remote-send` cannot return a result and does not run mappings, so a "call this vim function" workflow must go through `<Cmd>...` or `--remote-expr`. Documented.
- `--remote-expr` returns a **stringified** value on stdout; there is no structured return, no streaming, and no events. Documented (single-value, stdout).
- Latency: every call pays process spawn + msgpack RPC handshake. **UNVERIFIED** (not measured). For keystroke-rate or high-frequency state queries the right surface is msgpack-RPC over the `--listen` socket (Neovim's RPC API, https://neovim.io/doc/user/api.html), not the CLI.
- The genuinely interesting alternative for a later phase is `--listen` + `nvim_ui_attach` (ext-UI), which replaces the pty entirely and lets the client draw cells itself. That is a large architectural change (an ext-UI client instead of xterm), so it belongs in a separate decision.

---

## Recommendation

### Exact packages to install (peer-set coherent, all MIT except where noted)

```
dependencies:
  node-pty                 1.1.0            (MIT; stable; N-API; Linux builds from source)
  @xterm/xterm             6.0.0            (MIT)
  @xterm/addon-fit         0.11.0           (MIT)
  @xterm/addon-webgl       0.19.0           (MIT)
  @xterm/addon-unicode11   0.9.0            (MIT, needs allowProposedApi: true)
  @xterm/addon-clipboard   0.2.0            (MIT, OSC 52; write path only under this app's permissions)
  @xterm/addon-web-links   0.12.0           (optional, MIT)
  @xterm/addon-search      0.16.0           (optional, MIT)
devDependencies:
  @electron/rebuild        4.2.1            (MIT, 2026-10-06; only if you want an explicit rebuild step)
```

Explicitly **do not** install: `xterm` (deprecated name), `xterm-addon-*` (deprecated names), `@xterm/addon-canvas` (removed in 6.0.0), `@xterm/addon-web-fonts` (peer requires `@xterm/xterm ^6.1.0-beta.86`).

### One decision the parent has to make, with the facts attached

**node-pty 1.1.0 (stable) vs 1.2.0-beta.18.** 1.1.0 has no Linux prebuild, so `npm install` compiles with node-gyp (needs `base-devel` + `python3`, both normal on CachyOS). 1.2.0-beta.18 ships `prebuilds/linux-x64/pty.node`, so no compiler, but it is a beta of a package that VS Code depends on, and semver-major-ish churn is real (1.2.0 has been in beta since at least 2026-01). Recommendation: **pin 1.1.0**, accept the source build; it is one-time per install and the toolchain is already present.

**node-pty placement.** Two viable hosts, both correct, different plumbing:
- **Electron main**: needs a positive include in `electron-builder.yml` (`node_modules/node-pty/**/*`) plus `asarUnpack`, because the current `"!**/*"` filter excludes all node_modules; then a preload/IPC bridge to the renderer.
- **The `ELECTRON_RUN_AS_NODE` server** (already the app's logic host): node-pty ships unpacked inside `Resources/server/node_modules`, so no asar work, but requires `outputFileTracingIncludes` in `next.config.ts` so the tracer keeps `build/Release/pty.node`, plus a transport (WebSocket/SSE) between renderer and server.

Both satisfy the N-API ABI story (section 1.4). The parent should pick based on where the pty lifecycle belongs, not on compatibility.

### Non-negotiable follow-ups discovered here

1. **Menu accelerator conflict is a blocker for a usable vim pane.** This app's menu registers `Ctrl+C/V/X/A/Z`, `Ctrl+W`, `Ctrl+R`, `Ctrl+Shift+I`, `F11`, `Ctrl+0/+/-`. In a focused terminal that means no SIGINT, no visual block, no `Ctrl+W` window prefix. Mitigation must be designed in from the start (`setIgnoreMenuShortcuts(true)` while the pane is focused, or `before-input-event`), otherwise LazyVim bindings will appear "broken" in a way that looks like an xterm bug.
2. **`clipboard-read` is not in the permission allow-list**, so OSC 52 paste cannot work; add it or document "paste via keyboard shortcut" instead.
3. **`allowProposedApi: true` is required** the moment `addon-unicode11` is loaded.
4. **Font must be measured before it renders**: prefer a system-installed Nerd Font, or preload with `document.fonts.load` before `open()`.
5. **Trace include for the `.node`** if node-pty lives in the server.

---

## Sources

Kept:
- https://registry.npmjs.org/{node-pty,@xterm/xterm,@xterm/addon-*} and the published tarballs: the authoritative version/license/prebuild/dependency facts; every version number in this brief comes from here.
- https://nodejs.org/api/n-api.html and https://github.com/nodejs/abi-stable-node: Node-API ABI-stability guarantee, the reason node-pty needs no Electron-specific build.
- https://raw.githubusercontent.com/microsoft/node-pty/master/examples/electron/README.md (via github.com/microsoft/node-pty/tree/main/examples/electron): official Electron usage pattern, node-pty in main + xterm in renderer over IPC.
- https://github.com/microsoft/node-pty#dependencies: Linux build prerequisites (make, python, build-essential).
- https://github.com/electron/rebuild (README): rebuild tool requirements (Node >= 22.12.0), prebuild-install behaviour, `--build-from-source`.
- Installed `app-builder-lib` 26.16.1 sources (`out/packager.js`, `out/util/yarn.js`, `out/asar/unpackDetector.js`, `out/configuration.d.ts`): electron-builder's real rebuild and unpack behaviour for our exact version.
- https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules and https://www.electronjs.org/docs/latest/tutorial/asar-archives: ABI/rebuild framing and the `process.dlopen` asar caveat.
- https://www.electronjs.org/docs/latest/api/environment-variables: `ELECTRON_RUN_AS_NODE` semantics and its fuse.
- https://raw.githubusercontent.com/electron/electron/v44.9.3/lib/browser/api/menu-item-roles.ts: exact accelerators for every role our menu uses.
- https://raw.githubusercontent.com/electron/electron/main/docs/api/web-contents.md (the source of https://www.electronjs.org/docs/latest/api/web-contents): `before-input-event` and `setIgnoreMenuShortcuts` semantics.
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 and /5.4.0: breaking changes (canvas renderer removal, alt-arrow removal, scope migration).
- https://xtermjs.org/docs/api/terminal/classes/terminal/ and the 6.0.0 `typings/xterm.d.ts`: `attachCustomKeyEventHandler`, `resize`, `allowProposedApi`, `rescaleOverlappingGlyphs`, `clearTextureAtlas`.
- The 6.0.0 tarball's `src/browser/public/Terminal.ts`: which getters enforce proposed API (unicode, markers) and which do not (parser).
- https://www.npmjs.com/package/@xterm/addon-web-fonts (README in the tarball): the font-measurement hazard, stated by the xterm authors.
- https://github.com/xtermjs/xterm.js/issues/3342 and https://github.com/ryan-stoffel/parallax/pull/482: real instances of Nerd Font glyph-width breakage.
- https://code.visualstudio.com/docs/terminal/advanced: `commandsToSkipShell`, `sendKeybindingsToShell`, `allowMnemonics`, `allowChords`.
- https://raw.githubusercontent.com/vercel/hyper/canary/lib/components/term.tsx: the `e.catched` + `attachCustomKeyEventHandler` pattern (and evidence Hyper is still on xterm 5).
- https://github.com/Untrivial-ai/agent-orchestrator/pull/3678, https://github.com/getpaseo/paseo/issues/4234, https://github.com/OrchestratorInc/agent-orchestrator/issues/3659: the Ctrl+C swallowed by `role: "copy"` failure mode.
- https://wiki.hypr.land/configuring/core/binds/: bind consumption semantics (`auto_consuming`, `return { ok = false }`).
- https://github.com/cjpais/Handy/issues/949, https://github.com/silverstein/minutes/issues/64, https://github.com/TheOrcDev/videorc/pull/1206: Wayland denies global key grabs; Electron `globalShortcut` silently ineffective on Hyprland.
- https://neovim.io/doc/user/provider.html: clipboard tool priority (`wl-copy` before `osc52`), `g:clipboard`, `vim.ui.clipboard.osc52`, tmux detection caveat.
- https://neovim.io/doc/user/remote.html: `--listen`, `--server`, `--remote-send` (keys not mapped), `--remote-expr` (prints to stdout), `--remote-ui`.
- https://man7.org/linux/man-pages/man2/TIOCSWINSZ.2const.html: SIGWINCH on window-size change.
- https://raw.githubusercontent.com/LazyVim/LazyVim/main/LICENSE, https://github.com/neovim/neovim/blob/master/LICENSE.txt, https://www.gnu.org/licenses/license-list.html (Apache-2.0, Vim), https://github.com/bugaevc/wl-clipboard#license.
- Local Next 16.4.3 docs: `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` (`ssr: false` only in Client Components), `.../11-css.md` (CSS from node_modules), `.../output.md` (`outputFileTracingIncludes`).

Dropped:
- electron-builder v26 doc pages: the site now serves v27 docs and `/v26/native-modules.html` 404s; the installed `app-builder-lib` source is a stronger source for 26.16.1 anyway.
- `xterm-webfont` (npm): superseded by the official addon, and that addon is 6.1-only; no need for a third-party dependency.
- Medium/dev.to listicles on "build a terminal in Electron": no versioned facts.
- Neovim `--remote-*` deprecation claims found in unofficial posts: not present in the current official `remote.txt`, so not repeated here.

## Gaps (what could not be confirmed)

1. **No empirical validation was possible** (read-only research). Untested: node-pty compile on this machine, `outputFileTracingIncludes` actually carrying `pty.node`, the Electron menu accelerator behaviour on Hyprland specifically, and Next+Turbopack bundling of `@xterm/xterm` 6.0.0.
2. **Menu-accelerator swallow on Linux/Wayland**: the three community reports are Windows-specific fixes plus one general statement of ownership; Electron's docs prove menu shortcuts are resolved in the same pre-renderer layer as `before-input-event`, but I did not find a Linux/Hyprland-specific reproduction. Settle it with a 10-line spike: menu with `role: "copy"`, xterm focused, log `term.onData` while pressing Ctrl+C.
3. **`wl-copy` lifetime semantics** (does it fork and keep serving the selection?): the `wl-copy(1)` man page is not in the upstream repo tree and I could not fetch it. Settle with `man wl-copy` locally.
4. **node-pty 1.2.0 stable timeline**: beta.18 was 2026-10-23 and the line has been beta for most of 2026; no release date is published.
5. **`js-base64` version resolution**: addon-clipboard 0.2.0 bundles its own copy (3.7.8 in the bundle) and declares `^3.7.5`, so npm will resolve 3.9.x; BSD-3-Clause either way, but the resolved version is not pinned here.
6. **`@xterm/addon-search@0.16.0`, `addon-web-links@0.12.0`, `addon-webgl@0.19.0` were not source-read**, only metadata-checked (version, date, license). Their API compatibility with 6.0.0 rests on the same-day lockstep release, not on reading their code.
7. **Tabby's key-handling approach** is unverified in this pass and deliberately not described.
