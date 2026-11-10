# Scope: Electron shell + packaging (main.cjs, preload.cjs, browser-service, electron-builder, build/smoke scripts, next.config)

Branch: local-searxng-search (no commits made). All claims below were verified by opening the
file at the cited lines unless explicitly marked UNVERIFIED.

## Files Retrieved

- `electron/main.cjs` (1-760) · the whole shell: helper mode, single instance, server spawn, window, menu, IPC handlers, updater.
- `electron/preload.cjs` (1-106) · the entire renderer bridge surface.
- `electron/browser-service-readiness.cjs` (1-94) · CDP readiness probe (pure, no Electron import).
- `electron/chatgpt-ipc.cjs` (1-43) · inherited Node-IPC bridge to the server child + `trustedSender`.
- `electron/attachment-picker.cjs` (1-14) · `lh:attachment:pick` implementation.
- `electron/desktop-api.cjs` (1-25) · `x-learnharness-desktop` header injection.
- `electron/subscription-ipc.cjs` (1-45), `electron/web-subscription-browser.cjs` (1-19) · subscription control channels.
- `electron-builder.yml` (1-194) · files/extraResources/mac/win/linux/publish.
- `scripts/build-server.mjs` (1-91) · standalone payload curation + leakage guards.
- `scripts/smoke-server.mjs` (1-194) · packaged-server boot gate.
- `scripts/after-pack.cjs` (1-27) · mac-only icns swap.
- `next.config.ts` (1-123) · standalone output, trace includes/excludes, serverExternalPackages.
- `src/agent/subagents/headless.ts` (110-250) · the CLIENT side of the browser-service sidecar (spawn, handshake parse, puppeteer connect).
- `scripts/smoke-demo-runtime.mjs` (1-30, 120-210) · second, harder consumer of the same handshake.
- `components/sidebar.tsx` (56-88) · the `window.lh` TypeScript declaration that any new bridge member must be added to.
- `package.json` (1-100) · scripts, deps, `main`, electron 44.9.3 / electron-builder 26.16.1.

## Key Code

### 1. Dev vs packaged boot; who runs the Next server

Dev (two paths):

1. `npm run dev` → plain `next dev` (no Electron at all). `package.json:24`.
2. `npm run desktop:dev` → `concurrently "next dev" "LH_DEV_URL=http://localhost:3000 electron ."`. `package.json:29`.

In dev the shell spawns nothing: `const devUrl = process.env.LH_DEV_URL; const url = devUrl ?? ...` and the whole
`startServer` block is inside `if (!devUrl)` (`electron/main.cjs:653-680`). Dev also gets its own userData dir:

```js
// electron/main.cjs:117-119
if (process.env.LH_DEV_URL) {
    app.setPath("userData", `${app.getPath("userData")}-dev`);
}
```

and a different preload surface flag: `additionalArguments: ["--lh-web-subscriptions"]` (`electron/main.cjs:320`).

Packaged: main allocates a free port, then spawns the standalone server as its own child:

```js
// electron/main.cjs:202-231
function startServer(port) {
    const child = spawn(
        process.execPath,
        process.platform === "darwin"
            ? ["--require", path.join(process.resourcesPath, "server-title-guard.cjs"), serverEntry()]
            : [serverEntry()],
        { cwd: path.dirname(serverEntry()), env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_ENV: "production",
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
            LH_DATA_DIR: DATA_DIR(),
            LH_AUTH_FILE: AUTH_FILE(),
            LH_DESKTOP_SERVER: "1",
            LH_DESKTOP_API_SECRET: desktopAPISecret,
        }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
```

Yes: `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (`electron/main.cjs:205`, `:215`). Entry:
`process.resourcesPath/server/standalone/server.js` (`electron/main.cjs:61-65`). Ready = poll `GET /`
until any status (`waitUntilUp`, `electron/main.cjs:251-266`, `tries = 150` at 200ms ≈ 30s). Teardown:
`killServer()` SIGTERM then SIGKILL after 3s (`electron/main.cjs:274-288`), wired to `before-quit`,
`process.exit`, `SIGHUP` (`electron/main.cjs:637-641`).

Auth: keys are NOT injected into the child env. The child receives `LH_AUTH_FILE` and reads/writes the
file itself (`electron/main.cjs:186-190` comment block). Renderer→server API auth is a per-launch secret
sent as a header by the session webRequest hook (`electron/main.cjs:655-661`, `electron/desktop-api.cjs:7-24`):
only same-origin `/api*`, main frame, trusted window.

### 2. Browser-service sidecar

Spawn side (server process, TS): `src/agent/subagents/headless.ts:180-190`.

```ts
const appArgs = process.versions.electron ? ["--browser-service"] : [
    path.join(/* repo root */), "--browser-service",
];
const proc = spawn(binary, appArgs, { env: browserServiceSpawnEnv(process.env), stdio: ["ignore","pipe","pipe","ipc"] });
```

Binary resolution: `process.execPath` when running inside Electron, else the `electron` package path
(`src/agent/subagents/headless.ts:152-161`). Env sanitizer strips `ELECTRON_RUN_AS_NODE`, `LH_DEV_URL`,
`LH_DESKTOP_API_SECRET`, `LH_DESKTOP_SERVER` (`headless.ts:139-148`).

Handshake, helper side (`electron/main.cjs:79-111`): the flag branch runs BEFORE the single-instance lock
and before the LH_DEV_URL redirect. It requires a live parent IPC channel, hides the dock, picks a free
port, appends `remote-debugging-port`, waits for app-ready, loads `about:blank` in a hidden window,
then probes `http://127.0.0.1:<port>/json/version` with `waitForBrowserService` (`electron/browser-service-readiness.cjs:11-93`,
5s deadline / 500ms request timeout / 50ms retry, validates the `webSocketDebuggerUrl` is
`ws://127.0.0.1:<port>/devtools/browser/<id>` with no credentials/search/hash) and only then prints:

```js
// electron/main.cjs:105
if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
```

Lifetime: `process.once("disconnect", parentClosed)` (`electron/main.cjs:92`) aborts the AbortController
and `app.quit()`; any other error logs `browser-service failed:` and `app.exit(1)` (`electron/main.cjs:106-109`).

Client side: parse `^BROWSER_SERVICE_CDP (\d+)$` (`headless.ts:126-131`), 15s timeout then `proc.kill()`
and `resolve(null)` (`headless.ts:192-216`), then `puppeteer.connect({ browserWSEndpoint })` (`headless.ts:219-231`).
The process is cached in a module-level `browserServiceProc` and its port stashed on `__cdpPort`
(`headless.ts:163-173, 216`); `browser.close()` only disconnects.

How the renderer learns port/token: it does NOT. There is no IPC channel, no token, and no
`LH_BROWSER_*` env. Port discovery lives entirely inside the Next server process (child stdout parse),
CDP is loopback-only, and the only "token" in the system is `LH_DESKTOP_API_SECRET`, which the sanitizer
explicitly deletes from the helper env (`headless.ts:145-147`). CONFIRMED by grep: no `BROWSER_SERVICE_CDP`
reference exists in `preload.cjs`, `components/`, or `app/`.

Failure surface: helper spawn/connect failure returns `null` from `connectBrowserService`, and
`withBrowserPage` falls back to a per-job system-Chrome `puppeteer.launch` (`headless.ts:238-262`); if that
also fails the agent surfaces `NO_CHROME_MESSAGE` (`headless.ts:112-116`). The failure never reaches a
renderer channel; it appears as an agent tool error.

### 3. Every preload channel and its ipcMain counterpart

Preload entries (`electron/preload.cjs`):

| bridge member | preload line | channel | direction | main handler |
|---|---|---|---|---|
| `platform` | 41 | none (constant `process.platform`) | n/a | none |
| `getPathForFile(file)` | 44 | none (`webUtils.getPathForFile`) | n/a | none |
| `chooseAttachmentFolder()` | 46 | `lh:attachment:pick` (invoke, arg `"folder"`) | R→M | `electron/main.cjs:713-715` → `electron/attachment-picker.cjs:6-12` |
| `subscriptionTransport` / `openSubscriptionBrowser(action)` | 47-50 | `lh:subscriptions:web-browser` (invoke) | R→M | `electron/main.cjs:708-711` (dev-only, throws when `!devUrl`) |
| `chatgpt.status/login/cancel/select/disconnect/logout/consent` | 52-58 | `lh:chatgpt:control` (invoke, `{op,...}`) | R→M | `electron/main.cjs:691-695` → `chatGPTControl` (`chatgpt-ipc.cjs:31-42`) |
| `chatgpt.onChange(cb)` | 59-63 | `lh:chatgpt:changed` (`ipcRenderer.on`, returns unsubscribe) | M→R | sent at `electron/main.cjs:667` |
| `subscriptions.status/login/cancel/respond/open/retry/disconnect/consent` | 66-73 | `lh:subscriptions:control` (invoke, `{op,...}`) | R→M | `electron/main.cjs:697-706` → `subscriptionControl` (`subscription-ipc.cjs:27-44`) |
| `subscriptions.onChange(cb)` | 74-78 | `lh:subscriptions:changed` (`on` + unsubscribe) | M→R | sent at `electron/main.cjs:676` |
| `expandWindow()` | 80 | `lh:expand-window` (send) | R→M | `electron/main.cjs:742-749` |
| `onZoom(cb)` | 81-85 | `lh:zoom` (`on` + unsubscribe) | M→R | sent at `electron/main.cjs:382, 580` |
| `getZoom()` | 86 | `lh:zoom:get` (invoke) | R→M | `electron/main.cjs:741` |
| `onUpdateStatus(cb)` | 87-91 | `lh:update-status` (`on` + unsubscribe) | M→R | sent at `electron/main.cjs:454` |
| `installUpdate()` | 92 | `lh:update-install` (send) | R→M | `electron/main.cjs:724` |
| `getUpdateState()` | 93 | `lh:update:get` (invoke) | R→M | `electron/main.cjs:725-728` |
| `checkForUpdates()` | 94 | `lh:update:check` (invoke) | R→M | `electron/main.cjs:729-732` |
| `onOpenSettings(cb)` | 95-105 | `lh:open-settings` (`on`, buffered) | M→R | sent at `electron/main.cjs:557` |

No handler exists for `lh:chatgpt:changed`, `lh:subscriptions:changed`, `lh:zoom`, `lh:update-status`,
`lh:open-settings` on the ipcMain side: they are push-only. Only `lh:update-install` and
`lh:expand-window` are `send`/`on`; every other request/response is `invoke`/`handle`.

The pattern a NEW channel must follow (all four steps exist in the code, no exceptions):

1. Name it `lh:<area>:<verb>`, and keep `preload.cjs` and `main.cjs` strings identical (the preload header
   says so: `electron/preload.cjs:31` "Channel names are mirrored in electron/main.cjs · keep them in sync").
2. Renderer→main request: `ipcRenderer.invoke(...)` in preload, `ipcMain.handle(...)` in `main()`.
   Fire-and-forget: `ipcRenderer.send(...)` + `ipcMain.on(...)`.
3. Main→renderer push: `win.webContents.send(channel, payload)` and in preload an `on` wrapper that
   returns an unsubscribe closure (`preload.cjs:59-63, 81-85, 87-91`).
4. Inside every `handle` body, trust-check first, verbatim pattern (`electron/main.cjs:691-692`):

```js
if (!trustedAppWindows.has(BrowserWindow.fromWebContents(event.sender)) || !trustedSender(event, new URL(url).origin, BrowserWindow)) return { error: "Untrusted desktop request." };
```

`trustedAppWindows` is populated in `createWindow` (`electron/main.cjs:342-343`); `trustedSender`
compares `event.senderFrame === event.sender.mainFrame` and the origin (`chatgpt-ipc.cjs:25-30`).
Handler registration happens ONLY in `main()`, i.e. never in helper mode (`electron/main.cjs:635-...`).
`lh:zoom:get` and `lh:expand-window` are the two handlers WITHOUT the trust check (they take no
arguments and mutate only the caller's own window).
Finally, the TS side must extend the global `window.lh` interface in `components/sidebar.tsx:59-88`.

### 4. electron-builder.yml: files / asarUnpack / extraResources / rebuild

- `files` (`electron-builder.yml:40-95`): `"!**/*"` first, then positives `electron/**/*`, `package.json`,
  then an explicit allow-list of `node_modules/<pkg>/**/*` for electron-updater's tree and `jose`.
  The long comment at `:45-71` documents why: electron-builder's dep collector would otherwise pack the
  entire production dependency tree (a measured 502MB asar).
- `asarUnpack`: ABSENT. Grep over the repo (excluding node_modules) finds no `asarUnpack` and no
  `app.asar.unpacked`. The comment at `:69-71` says the unpacked dir "dies with it".
- `extraResources` (`:96-116`): `docs/compaction-accounting.md` → `licenses/pi-compaction.md`;
  `from: .next, to: server, filter: ["standalone/**/*"]` (from the PARENT dir on purpose, see `:98-105`);
  mac-only `electron/server-title-guard.cjs` → `server-title-guard.cjs` (`:117-124`).
- `npmRebuild` / `electron-rebuild` / `buildDependenciesFromSource`: NOT configured anywhere. Grep for
  those keys matches only `package-lock.json:777` (an `electron-rebuild` bin of some transitive package)
  and `dist/builder-effective-config.yaml` contains no `npmRebuild` line. So the builder default applies;
  the default being `true` is UNVERIFIED here (not read from app-builder-lib source in this pass).

What a new native module (node-pty) plus an extra binary would require, mechanically:

- The native module must be reachable by whatever process requires it. If main.cjs requires it, the asar
  must contain it, so `files` needs an explicit `node_modules/node-pty/**/*` positive (the bare
  `electron/**/*` and `package.json` positives cannot re-include a dep, `:60-71`), AND the `.node` must be
  unpacked, so `asarUnpack: ["node_modules/node-pty/**"]` must be added (key currently absent).
- If instead it is required by the server child, electron-builder's packer is not involved; the file must
  survive `next build` tracing: `serverExternalPackages` in `next.config.ts:118-125` (native bindings are
  listed there precisely because bundling breaks the `.node` require, see the `@napi-rs/canvas` and
  `@resvg/resvg-js` entries) plus an `outputFileTracingIncludes` glob (the canvas/resvg entries at
  `next.config.ts:96-101` are the template).
- An extra standalone binary: existing precedent is `extraResources` (mac-only file at `:117-124`, whole
  `.next` tree at `:110-116`). A cross-platform binary would need `extraResources` entries per platform
  section (`mac:`/`win:`/`linux:`), and code would read it from `process.resourcesPath`.
- ABI: pty addons are compiled per Electron ABI. Nothing in this repo forces a rebuild today; if
  `npmRebuild` defaults to true, electron-builder will attempt one and needs a toolchain on every CI job
  (`.github/workflows/release.yml` builds per OS).
- mac: `hardenedRuntime: true` + `notarize: true` (`:158-166`) mean a new `.node` outside the asar must be
  signed/entitled consistently; `build/entitlements.mac.plist` exists but was not inspected in this pass.

### 5. Window + menu construction; accelerators; key handling

- Window: `createWindow(url)` at `electron/main.cjs:290-394`. `contextIsolation: true, sandbox: true,
  nodeIntegration: false`, preload `electron/preload.cjs` (`:315-322`). macOS `titleBarStyle: "hiddenInset"`
  + `trafficLightPosition {x:16,y:22.5}`; other platforms `titleBarStyle: "hidden"` + `titleBarOverlay`
  + `autoHideMenuBar: true` (`:303-314`). `minWidth 640`, `minHeight 600`, `show:false` + `ready-to-show`
  (`:327-339`). Permission handler allows only `media`, `clipboard-sanitized-write`, `local-fonts` from
  the app origin (`:346-361`). `will-navigate` pinned, `setWindowOpenHandler` always deny + `openExternal`
  (`:364-374`).
- Menu: `installMenu()` at `electron/main.cjs:585-632`, called once from `main()` (`:719`).
  Template: app menu (about, "Check for Updates…", hide, hideOthers, quit: `:586-601`), Edit roles
  (`:602`), View (`:604-630`), `{ role: "windowMenu" }` (`:629`).
- Accelerators actually declared: `CommandOrControl+0` (`:613`), `CommandOrControl+Plus` (`:618`),
  `CommandOrControl+-` (`:623`). Everything else is OS-default role behavior:
  `reload` (Cmd/Ctrl+R) `:605`, `toggleDevTools` `:606`, `togglefullscreen` `:628` (F11 on
  Win/Linux, Ctrl+Cmd+F on mac), `quit` `:600`, `windowMenu` `:629` (which is what contributes the
  default Cmd/Ctrl+W close item).
- Explicit Ctrl+W handling: NONE. Grep for `accelerator` returns only the three zoom entries above; grep
  for `Ctrl+W`/`close` handlers returns nothing in main.cjs. Window close goes through the default role
  and `window-all-closed` (`electron/main.cjs:636-643`).
- `before-input-event`: YES, one handler, `electron/main.cjs:384-392`. It only reacts to keyDown with
  meta/control and keys `=`, `+`, `-`, `0`, and calls `event.preventDefault()`. Comment at `:377-380`
  notes menu-claimed keys never reach this handler. This is the single existing precedent for raw key
  interception in the shell, and it applies to the app window only (the helper window at `:100-102` gets
  no listener).
- Zoom: `ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]` (`:407`), `zoomStep`/`applyZoom`
  (`:570-582`), factor broadcast on `did-finish-load` (`:381-383`).

### 6. Packaged-server smoke test

`scripts/smoke-server.mjs`. Wired into `desktop:dist` between `build-server.mjs` and `electron-builder`
(`package.json:30`). With `--electron` it uses Electron's bundled Node via `createRequire(...)("electron")`
plus `ELECTRON_RUN_AS_NODE: "1"` (`scripts/smoke-server.mjs:41-42, 120`); otherwise host Node.

It spawns `.next/standalone/server.js` with `cwd` = standalone, `PORT` = kernel free port,
`HOSTNAME` = 127.0.0.1, `LH_DATA_DIR` = throwaway `mkdtemp`, `LH_AUTH_FILE` = `{}` file
(`scripts/smoke-server.mjs:119-132`). Assertions, in order:

1. Pre-flight runtime gates BEFORE boot: `verifyDemoRuntime(STANDALONE, RUNTIME)`,
   `verifyProviderRuntime`, `verifyCompressionRuntime` (`:88-93`).
2. `GET /` reaches 200 within `BOOT_TIMEOUT_MS = 30_000`, polling every 500ms, and not after the child
   exited early (`:159-171`).
3. Every route in `PROBES = ["/api/graph", "/api/models", "/api/settings"]` returns 200 (GET-only, no
   side effects) (`:44`, `:173-178`).
4. On failure: print a 16KB rolling log tail of the child's stdout/stderr (`:98-116, 188-192`).
5. `finally`: SIGTERM, SIGKILL after 3s, temp dir removed (`:143-157`). Exit 1 on any failure.

Nothing here touches Electron windowing, menu, or the browser-service helper; the helper is covered by
`scripts/smoke-demo-runtime.mjs` with `--browser` (`scripts/smoke-demo-runtime.mjs:143-206`), which is a
separate script not in the `desktop:dist` chain.

## Architecture (data flow)

```
packaged boot:   Electron main (app.asar: electron/**, package.json, electron-updater, jose)
                   -> freePort() -> spawn(process.execPath, [server.js], ELECTRON_RUN_AS_NODE=1, ipc)
                   -> Resources/server/standalone/server.js  (extraResources, NOT in asar)
                        -> exit => main logs "server exited"; killServer on every quit path
                   -> waitUntilUp(url) -> createWindow(url) -> loadURL("http://127.0.0.1:<port>")

dev boot:        next dev (port 3000) + electron . with LH_DEV_URL -> no spawn, userData "-dev"

renderer:        sandboxed, contextIsolation -> window.lh (preload contextBridge only)
                   invoke/handle  -> main handlers (trust-checked) -> chatgpt/subscriptions/updater/window
                   on/send        -> zoom, update-status, open-settings, changed-events

auth:            per-launch LH_DESKTOP_API_SECRET -> session webRequest injects x-learnharness-desktop
                   on same-origin /api* main-frame requests only; child also gets LH_AUTH_FILE

browser helper:  Next server process (no Electron API) -> spawn(app binary, ["--browser-service"], ipc)
                   -> helper: remote-debugging-port, hidden window, readiness probe
                   -> stdout "BROWSER_SERVICE_CDP <port>" -> puppeteer.connect over ws loopback
                   -> IPC disconnect = helper quits (no orphans)

packaging:       next build (output standalone) -> build-server.mjs (copy static/public, refuse data/ and
                 secrets, drop standalone dist/ + node_modules/electron) -> smoke-server.mjs
                 -> electron-builder (files allow-list -> asar; .next -> Resources/server; afterPack icon)
```

## Risks / open questions (for the implementer, not solutions)

1. `files` allow-list is load-bearing and order-sensitive (`electron-builder.yml:45-71`). Any new shell
   dependency (node-pty) silently vanishes from the asar unless an explicit `node_modules/<pkg>/**/*`
   positive is added AFTER `"!**/*"`. The `.next`-side path has the mirror-image trap
   (`next.config.ts:34-71`: broad excludes stripped pi-ai/pi-agent-core, and `"**/data/**/*"` still prunes
   gcp-metadata in the native tracer).
2. `asarUnpack` does not exist yet; a native `.node` loaded by main cannot dlopen from the read-only asar
   (`electron/main.cjs:11-14` comment states this explicitly). Whether node-pty ships a prebuilt binary
   for Electron 44's ABI, and whether `npmRebuild` (unset) will trigger a compile in CI, is UNVERIFIED.
3. The helper-mode early return (`electron/main.cjs:79-111`) means the shell has TWO mutually exclusive
   boot paths in one file. Anything that must exist in both (e.g. a new IPC handler) must be placed inside
   `main()`, because helper mode never reaches it. A PTY spawned from main will also not exist in the
   `--browser-service` helper instance.
4. Kill ordering matters in two documented places: `installUpdateNow` kills the server before
   quit-and-install (`electron/main.cjs:474-482`, comment at `:427-434`), and `killServer` is registered
   on three quit paths. A PTY holding child processes needs the same treatment plus reaping on
   `window-all-closed` (currently only `chatgpt?.pause()`/`subscriptions?.pause()`, `:636-643`).
5. `minWidth: 640` / `SIDEBAR_AUTOCLOSE = 928` are duplicated constants across `electron/main.cjs:45` and
   `components/sidebar.tsx:54` (both comments say "keep in sync"). A side-by-side coding pane adds another
   width threshold; there is no shared constant.
6. `before-input-event` (`electron/main.cjs:384-392`) currently swallows nothing but Cmd/Ctrl +/-/0. A
   terminal pane needs raw keys, and the sandboxed renderer with `sandbox: true` means the bridge must
   stay `invoke`/`send`; there is no existing precedent for high-frequency streaming IPC (every current
   channel is request/response or low-rate push), so throughput and coalescing are untested territory.
7. Dev-mode parity gap: in dev there is no spawned child, so `LR_DESKTOP_SERVER`, `LH_AUTH_FILE` and
   `LH_DESKTOP_API_SECRET` do not exist, and `lh:subscriptions:web-browser` is dev-only
   (`electron/main.cjs:708-711`). Any new pane channel must behave sensibly with `devUrl` set.
8. `lh:zoom:get` and `lh:expand-window` skip the trust check (`electron/main.cjs:741-749`). Copying that
   omission for a channel that takes arguments would be a hole.
9. Verification tooling is thin for shell code: `scripts/smoke-server.mjs` never launches Electron's UI.
   Tests that do exist run main.cjs under a fake `require` (`tests/browser-service-lifetime.test.ts:28-70`),
   which is the only harness pattern available for the shell.
10. `docs/coding-pane/` did not exist before this file; nothing anywhere references a coding pane yet
    (grep found no `coding-pane` string in the repo).

## Start Here

`electron/main.cjs:79-130` first (the helper/dev/packaged three-way branch, which decides where any new
process and IPC must live), then `electron/main.cjs:635-760` (the whole `main()`: handlers, menu install,
window creation order). Then `electron/preload.cjs:41-106` as the exact template for the new bridge, and
`electron-builder.yml:40-124` for the packaging edits a native module forces.
