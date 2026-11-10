# Review 1 — security, sandbox, packaging (coding workspace)

Scope: `docs/coding-pane/{plan,spec,build,context-electron,research}.md` + the working-tree diff and
untracked files (`git status`). Read-only audit; the only file written is this report. Anything I could not
execute is marked UNVERIFIED; anything I inferred is marked SPECULATION.

---

## Review

### Correct

1. **Every new `lh:code:*` request channel carries the repo's trust check.** `electron/code-ipc.cjs:33,38,43,48,53,58`
   all gate on the injected `isTrusted` before touching the session manager, and the predicate wired at
   `electron/main.cjs:775` is the same one the other desktop channels use
   (`trustedAppWindows.has(...) && trustedSender(event, new URL(url).origin, BrowserWindow)`), i.e.
   `senderFrame === sender.mainFrame` + exact app origin (`electron/chatgpt-ipc.cjs:25-30`). No channel
   reaches the pty manager unchecked; `lh:code:data`/`lh:code:exit` are push-only (no handler exists).
   `tests/code-ipc.test.ts:57-69` actually asserts the refusal (calls recorded `[]`), not just the happy path.
2. **The renderer cannot name the binary, the cwd, the env or the argv.** `start({kind, scope, cols, rows})`
   is the only argument surface: `kind` is whitelisted to `editor|shell` (`electron/code-session.cjs:141`),
   `scope` must match `^[A-Za-z0-9_-]{1,32}$` or falls back to `scratch` (`:30`), geometry is clamped
   (`:58`), argv is fixed to `["--listen", socket]` / `["-l"]` (`:161,164`), cwd is `workspaceRoot(dataDir, scope)`
   and env is `sessionEnv(process.env)` (`:177`). Verified by reading the handler bodies; no field of the IPC
   payload reaches `spawn()` unvalidated.
3. **The scope string cannot traverse or go absolute.** `path.join(dataDir, "code", sanitizeScope(scope))`
   with a pattern that admits no `.` or `/`; `"../escape"`, `""`, `42` and a 40-char string all collapse to
   `scratch` (`tests/code-session.test.ts:60-68` pins CJS↔TS parity on exactly those fixtures).
4. **The workspace path check is separator-safe.** `resolveWorkspacePath` uses `path.relative` + a `startsWith("..")`
   refusal (`src/core/code-editor.ts:91-98`), not a string prefix on the absolute path, so
   `/data/code/scratch-evil/x` cannot pass as `/data/code/scratch`. Probed live: `"../x"`, `"/etc/passwd"`,
   `"a/../../b"`, `""` all refuse. (The realpath gap is Bug 2 below.)
5. **`open_in_editor` cannot run commands.** It spawns an argv array (no shell) and uses only `--remote`
   (`src/agent/tools/open-in-editor.ts:116`); `--remote-send`/`--remote-expr`/`--remote-ui` are never used.
   Neovim documents `--remote {file}` as "all arguments after --remote will be used as file names"
   (`/usr/share/nvim/runtime/doc/remote.txt:42-52,73`), so a path cannot become an Ex command. Absolute paths
   from `path.resolve` can never start with `-`, so `--server`/`--remote` values cannot be re-read as flags.
6. **Environment sanitisation is deliberate and correct where it is applied.** `sessionEnv` strips
   `ELECTRON_RUN_AS_NODE`, `LH_DESKTOP_API_SECRET`, `LH_DESKTOP_SERVER`, `NVIM_APPNAME`, pins
   `TERM`/`COLORTERM`, and `shellBinary` refuses a `SHELL` that is not absolute (`electron/code-session.cjs:66-84`)
   so `SHELL="--rcfile …"` cannot become an argv element. Pinned by `tests/code-session.test.ts:70-87`.
7. **Packaging mechanism is sound, and I verified it two ways.** (a) Node-API: a real spawn under Electron's
   runtime works — `ELECTRON_RUN_AS_NODE=1 npx electron -e "require('node-pty').spawn(...)"` →
   `{"node":"24.22.0","modules":"149","napi":"10","out":"ABI_OK"}`. (b) The `!**/*` → explicit-positive
   mechanism really does re-include a dep into the asar: inspecting the existing
   `dist/linux-unpacked/resources/app.asar` with `@electron/asar` lists exactly the 17 allow-listed
   packages (`node_modules/{electron-updater,fs-extra,jose,…}`), so `node_modules/node-pty/**/*` will land.
   (c) `asarUnpack` validates: `node --test tests/desktop-platform.test.ts` → 18/18, including
   `validateConfiguration` against the installed `app-builder-lib` schema.
8. **No server-side require of node-pty, so no `outputFileTracingIncludes` is needed.** `grep -rn node-pty`
   over `src/ app/ components/ electron/` finds exactly one require: `electron/code-session.cjs:94`, lazily,
   inside `createCodeSessions`. `.next/standalone/node_modules` contains no `node-pty` after `next build`.
   `next.config.ts:118-125` therefore needs (and got) no change.
9. **The `/code` route leaks nothing to an unauthenticated caller.** `app/code/page.tsx` is
   `force-dynamic` and renders `<CodeView />` with no props; the client component carries the literal scope
   `"scratch"` only (`components/code-view.tsx:20`). No `PATHS`, no `LH_DATA_DIR`, no socket path, no secret
   enters the client bundle — `components/code*` import only xterm, `cn` and `./focus.ts`.
10. **Degradation is honest and durable.** `createCodeSessions` + `registerCodeIpc` are inside one `try`
    (`electron/main.cjs:749-787`); a missing/broken addon sets `codeSessions = null` and logs
    `coding workspace unavailable: <stack>` via `log()`, which also appends to `userData/logs/main.log`
    (`electron/main.cjs:192-215`). Because `require("node-pty")` is lazy, the failure cannot kill boot.
    The panes then surface the rejection text (`components/code/terminal-pane.tsx:184-186`), so the failure
    is visible, not silent. `tests/code-session.test.ts` + `tests/code-view.test.tsx` cover the two halves.
11. **The renderer-compromise escalation is real but bounded by existing guards**, all of which I read:
    demo iframes are `sandbox="allow-scripts"` without `allow-same-origin` (`components/artifacts/demo-card.tsx:216`),
    mermaid renders with `securityLevel: "strict"` (`components/mermaid-render.ts:29`), permissions are an
    allow-list of `media|clipboard-sanitized-write|local-fonts` from the app origin only
    (`electron/main.cjs:346-361`), navigation is pinned and `window.open` is denied (`:364-374`), and the
    window is `contextIsolation: true, sandbox: true` (`:315-322`).

### Bug

**Bug 1 — the agent tool and the PTY host disagree about the workspace root in dev; `open_in_editor` is dead
in the documented acceptance environment, and in plain `npm run dev` it trusts a file inside the git tree.**
`src/agent/tools/open-in-editor.ts:103` + `config.ts:17-19` vs `electron/main.cjs:68,129-131` + `package.json:29`.

- Expected: `open_in_editor` reads the state file the PTY host wrote (plan D7, spec F8).
- Actual: two different roots.
  - Electron main: `DATA_DIR() = <userData>/data`, and with `LH_DEV_URL` set the whole userData is moved to
    `<userData>-dev` (`electron/main.cjs:129-131`), so the editor writes
    `…/LearnHarness-dev/data/code/scratch/.editor.json`.
  - The server: `DATA_ROOT = process.env.LH_DATA_DIR ?? <repo>/data` (`config.ts:17-19`). Only the packaged
    server child gets `LH_DATA_DIR` (`electron/main.cjs:231`, `startServer` env). `desktop:dev` is
    `concurrently "next dev" "LH_DEV_URL=… electron ."` (`package.json:29`) — `next dev` inherits no
    `LH_DATA_DIR`, and the repo has no `.env*` file that would add one (verified: `ls -a | grep '^\.env'`
    is empty).
- Repro: `npm run desktop:dev` → sidebar → Code → wait for the LazyVim dashboard → ask the agent to open a
  workspace file. Expected "opened"; actual `No coding editor is running, so no file can be shown.` (thrown at
  `src/agent/tools/open-in-editor.ts:105-109`). F7's `read` half is unaffected only because the agent can be
  handed absolute paths; F8 has no such escape hatch.
- Suspected cause: the tool resolves `PATHS.data` at module load in the server process, while the workspace is
  a main-process path. The plan's D4 says the workspace lives "with the app" and the tool reads main's state
  file — nothing pins the two to one root outside the packaged wiring.
- Security tail of the same root cause: in plain `npm run dev` (no Electron) the tool will read
  `<repo>/data/code/scratch/.editor.json`, a file inside the git working tree. A checked-out repository
  (or a `data/` symlink) can therefore plant a state file that steers the tool's spawn (see Finding 1). The
  packaged app is not affected.
- No test catches this: `tests/open-in-editor-tool.test.ts` always injects `deps.dataDir`, and nothing asserts
  that main's `DATA_DIR()` and `PATHS.data` agree.

**Bug 2 — `resolveWorkspacePath` is lexical only: a symlink inside the workspace escapes the confinement that
spec F8 promises, and nvim then writes its swap/undo state outside the workspace.**
`src/core/code-editor.ts:91-98`, used at `src/agent/tools/open-in-editor.ts:110`.

- Expected (F8): "a path outside the workspace is refused with an error". The function's own docstring
  (`src/core/code-editor.ts:86-90`) claims the check is safe because it "only ever hands the path to nvim".
- Actual: no `realpath` before the comparison. Probed live on the real module:
  `resolveWorkspacePath('/data/code/scratch', 'link/id_rsa')` → `/data/code/scratch/link/id_rsa`, and
  `fs.access` then succeeds through the link, so `exec(nvim, [... "--remote", "/data/code/scratch/link/id_rsa"])`
  runs and Neovim opens the target.
- Repro: in the workspace shell pane run `ln -s ~/.ssh link`; then get the agent to call
  `open_in_editor({ path: "link/id_rsa" })` (a prompt-injected instruction inside any ingested PDF/web page
  can do this — the model chooses the path). Expected refusal; actual: the key is displayed in the editor and
  LazyVim creates swap/undo artefacts next to the target.
- Impact, stated honestly: the file content is NOT returned to the model (the tool returns only
  "Opened …" + the workspace path at `src/agent/tools/open-in-editor.ts:117-119`), so this is not a read
  oracle. It is a confinement bypass plus a write outside the workspace (swap files), and it defeats the one
  boundary the tool advertises.
- Minimal fix: `realpath` the resolved path (and its parent directory) before the containment check, and keep
  the existing `path.relative` separator-safe comparison; refuse when the real path is outside the real root.
  A test with a real `ln -s` fixture belongs in `tests/open-in-editor-tool.test.ts`.

### Finding

1. **The state file's `socket` is used verbatim — a workspace-writable file chooses the address the server
   spawns nvim against.** `src/agent/tools/open-in-editor.ts:74-84` (parse, no constraint) → `:116`
   (`["--server", state.socket, ...]`). Trigger: any writer of the workspace (the learner's own shell,
   a cloned practice repo, a checkout in dev where the root is `<repo>/data`) drops
   `.editor.json = {"socket":"127.0.0.1:9229"}` or a path to an unrelated unix socket; the agent's next
   `open_in_editor` call spawns `nvim --server 127.0.0.1:9229 --remote <file>`, i.e. the server process dials
   an attacker-chosen address and speaks msgpack to it. No command reaches the client (Bug-paragraph 5
   above), and the same-user model means no privilege boundary is crossed — but the tool should not read its
   spawn target from a mutable file. Minimal fix: accept the state only when
   `state.socket === editorSocketPath(root, state.scope)` (the helper already exists in
   `src/core/code-editor.ts:34-36`).
2. **`defaultExec` hands the desktop API secret to the spawned nvim client.** `src/agent/tools/open-in-editor.ts:56-62`
   calls `execFile` without an `env` option, so the child inherits the *server* env, which by construction
   contains `LH_DESKTOP_API_SECRET` and `LH_DESKTOP_SERVER` (`electron/main.cjs:222-237`). The PTY host
   deliberately strips exactly those two (`electron/code-session.cjs:66-72`); this path does not. Trigger: any
   code that reads the client's env (`nvim --remote` still starts a real nvim, so user config/plugins load).
   Not exploitable without attacker code on the learner's machine — defence in depth, and the fix is one
   `env:` key built from the same sanitiser. (SPECULATION: whether `--remote` runs the full config; I did not
   trace nvim's startup for the remote path.)
3. **Packaging: `node_modules/node-pty/**/*` + `asarUnpack` ships ≈58 MB of foreign-platform binaries into
   every install.** `electron-builder.yml:91,96-97`. Measured in `node_modules/node-pty`: total 63 MB, of
   which `prebuilds/` is 58 MB — `win32-x64` 30 MB, `win32-arm64` 28 MB, `darwin-arm64` 136 KB,
   `darwin-x64` 64 KB — and 53 MB of that is Windows `.pdb` debug symbols
   (`du -ch node_modules/node-pty/prebuilds/*/*.pdb` → 53M). There is no `prebuilds/linux-x64` at all, so a
   Linux build needs only `build/Release/pty.node` (124 KB). Because the `asarUnpack` glob covers the whole
   package, the unpacked payload carries all four platform trees on every OS. Against a documented war on
   asar bloat (the 502 MB asar described at `electron-builder.yml:45-58`) this is a regression, and the same
   block also re-includes `node_modules/node-addon-api/**/*` (432 KB of C++ headers, build-time only, never
   required at runtime — `node-pty/lib/utils.js` only requires the `.node`). Minimal fix: ship
   `node_modules/node-pty/lib/**/*` + `node_modules/node-pty/build/Release/**/*`, unpack only
   `node_modules/node-pty/build/Release/**/*`, drop the `node-addon-api` positive (or scope it to
   `darwin`/`win32` if a prebuild path is ever needed). UNVERIFIED for Windows: I did not confirm which
   `conpty*`/`winpty*` files `scripts/prebuild.js` copies into `build/Release` there.
4. **The panes subscribe after the pty has already produced output, so the first screen is lost.**
   `components/code/terminal-pane.tsx:118` (`await bridge.start(...)`) precedes `:132` (`bridge.onData(...)`).
   `start` spawns synchronously in main and the pty begins emitting immediately
   (`electron/code-session.cjs:177-187`), and `webContents.send` calls for a message with no renderer
   listener are dropped. Trigger: first visit to `/code` (and every remount) — nvim's LazyVim dashboard paint
   and the shell's prompt banner are emitted before the subscription exists; the pane stays blank until
   something forces a redraw. `fit.fit()` after mount usually supplies the SIGWINCH that saves it, but that is
   luck, not design. Minimal fix: register `onData`/`onExit` before `start`, or replay a buffered tail from
   main. No test would catch this (unit tests never drive the real IPC ordering).

### Note

- **The new bridge turns any app-origin XSS into host RCE.** That is the documented design (the pane is a
  full shell), and the existing containment (sandboxed demo iframes without `allow-same-origin`, mermaid
  `securityLevel: "strict"`, pinned navigation, denied `window.open`, narrow permission allow-list) all hold
  as of this read. Recorded because the blast radius of a future renderer bug changed with this diff: it now
  includes `lh:code:start`.
- **The `nvim --listen` socket is a same-user command channel** (`--remote-send`/`--remote-expr` are not the
  app's, but any local process of the same user can use them). It is confined by directory permissions rather
  than by the socket's own mode: `mkdirSync(root, { recursive: true, mode: 0o700 })`
  (`electron/code-session.cjs:168`) gives `<data>/code/<scope>` 0700 under umask 022 (checked, `0022`), so
  other users cannot traverse to it. Not a hole, but it means the socket's safety depends on that mkdir staying
  restrictive; `mkdirSync` does not *chmod* a directory that already exists with looser modes.
- **`.editor.json` is written 0600 and the socket is unlinked before spawn**
  (`electron/code-session.cjs:169,205-209`). `rmSync` unlinks a symlink rather than following it, so a planted
  `.nvim-scratch.sock` symlink cannot be used to delete an arbitrary file.
- **Pty output is broadcast to every window** (`electron/main.cjs:752-758,761-767`). Correct with one app
  window; if a second window is ever added, both receive all sessions' bytes and each pane filters by id.
- **`path.relative(...).startsWith("..")` also refuses legitimate names beginning with `..`** (probed:
  `"..foo"` throws). Conservative, harmless, documented here so nobody "fixes" it into a prefix bug.
- **Pre-existing, unchanged by this diff: the standalone payload contains the whole repo.** `.next/standalone/`
  already holds `tests/` (260 files), `docs/`, `skills/`, `electron/`, `tsconfig.tsbuildinfo`; the feature adds
  two `.cjs` files and four test files to that payload. `scripts/build-server.mjs` removes only `dist` and
  `node_modules/electron`. No secret rides along (verified: no `data/`, no `auth.json` in `.next/standalone`).
- **`npmRebuild` is unset, so `electron-builder` will node-gyp rebuild node-pty in place** on every
  `desktop:dist` (research.md §1.5). Harmless for N-API but it means the packaging machine needs a toolchain;
  Linux has no prebuild, so a plain `npm ci` also compiles. UNVERIFIED: no `electron-builder` run was executed
  in this audit (dist is a build side effect).
- **`open_in_editor` is always-on** like `read`/`ls`/`grep` (not in `TOGGLE_TOOLS`,
  `components/settings/agent-section.tsx:94`). Consistent with the existing learner-fs posture, so not a
  finding — noted only because it is the most privileged of that set.

### Verified

| command | result |
|---|---|
| `git status --porcelain` / `git log --oneline -5` | 11 modified, 10 untracked; no commits made |
| `node --test tests/code-ipc.test.ts` | 5/5 pass |
| `node --test tests/code-session.test.ts tests/open-in-editor-tool.test.ts tests/code-view.test.tsx` | 16/16 pass |
| `node --test tests/desktop-platform.test.ts` | 18/18 pass (incl. `validateConfiguration` with the new `asarUnpack`) |
| `ELECTRON_RUN_AS_NODE=1 npx electron -e "require('node-pty').spawn('/bin/bash',…)"` | `{"node":"24.22.0","modules":"149","napi":"10","out":"ABI_OK"}` — native addon loads and forks under Electron 44 |
| `node --import tsx -e "…resolveWorkspacePath fixtures…"` | `hello.py` ok; `../x`, `/etc/passwd`, `a/../../b`, `""`, `..foo` refuse; `link/id_rsa` **accepted** (Bug 2) |
| `node -e "@electron/asar listPackage('dist/linux-unpacked/resources/app.asar')"` | 381 entries, the 17 allow-listed `node_modules` packages present → explicit positives do land in the asar |
| `du -sh node_modules/node-pty/*`, `du -ch …/*/*.pdb`, `ls …/prebuilds` | 63 MB total, 58 MB prebuilds (53 MB `.pdb`), no `linux-x64` prebuild |
| `grep -rn node-pty src app components electron` | only `electron/code-session.cjs:94` (lazy) → no tracer include needed |
| `ls -d .next/standalone/{data,auth.json}` | absent (guards hold) |
| `cat /usr/share/nvim/runtime/doc/remote.txt` | `--remote` treats arguments as file names only |
| `read electron/{main,preload,code-ipc,code-session,chatgpt-ipc}.cjs`, `src/{core/code-editor,agent/tools/open-in-editor}.ts`, `app/code/page.tsx`, `components/code*`, `electron-builder.yml`, `next.config.ts`, `config.ts`, the five touched tests | read in full |

Not run (out of bounds for this audit): `electron-builder`/`desktop:dist`, `npm run build`, `npm test` (full
suite), a live Electron window, a real `nvim --server --remote` round-trip. Findings that depend on those are
marked UNVERIFIED above.
