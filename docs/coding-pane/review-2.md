## Review

Artifact: round-2 audit of the fix diff (`git status --porcelain` = 12 modified + 14 untracked paths, unchanged by this audit). Read-only: no file created, edited, staged, or committed; every experiment ran from `node -e`/`/tmp` scratch and was deleted.

### Correct (what holds before the item-by-item pass)

- The four security/correctness fixes land where the reports say they do: identity guard (`electron/code-session.cjs:209`), realpath confinement (`src/core/code-editor.ts:126-146`), state-file trust (`src/agent/tools/open-in-editor.ts:120-133`), chunked write (`electron/code-session.cjs:240-255`), one shared data-dir rule (`src/core/code-editor.ts:85`, `electron/code-session.cjs:37`, `electron/main.cjs:72`), reuse resize (`electron/code-session.cjs:157`), `killAll` wiring (`electron/main.cjs:663,673-675`).
- No claim in `fix-round-1.md` turned out to be a phantom: every item I could reach in code is present, and every pin I reverted really goes red (item 12 below).
- The fix did **not** weaken an existing assertion: `git diff tests/` is enumeration-only (`"code"`, `"open_in_editor"` in four exact lists), and the two "must change" files were patched exactly as specified (`tests/open-in-editor-tool.test.ts:30`, `tests/code-view.test.tsx:29`), so the report's residual risk #1 is now stale, not real.
- `npm run typecheck` exit 0, `npm run lint` 0 errors / 1 pre-existing warning, 39/39 targeted tests green, 18/18 desktop-platform.

---

### Verified

**1. B1 stale exit — FIXED (reproduced, not taken on faith).** fake-pty seam, `dataDir` in `/tmp`:
`start → kill → start → fire procs[0].onExit` ⇒ `registry ["editor:scratch"]`, `.editor.json` present, stand-in socket file content intact, `write()→true`, `resize()→true`, `procB.writes ["i"]`, `killAll → registry [] , procB.killed true`, second `killAll` a no-op. Stale exit also broadcasts nothing (`onExit` list `[]`), while the live session's real exit still broadcasts `["editor:scratch",3]`. Guard is `electron/code-session.cjs:209`. Reverted copy (guard deleted) reproduces the old failure exactly: survives `false`, stateFile `false`, write `false`, killAll misses.

**2. B2 dev root — FIXED, one residual (Note N3).** `cjs.resolveDataDir` ≡ `core.resolveDataDir` on 4 fixtures incl. `./data` → `/…/learnharness/data`. Production pair: `config.ts:17-19` with `LH_DATA_DIR=./data` → `PATHS.data = /home/yusuf/Github Repository/learnharness/data`; **identical** without the env, so no dev data moves. `main.cjs:72` derives `DATA_DIR()` from the same rule, `package.json:22` exports `LH_DATA_DIR=./data` to `concurrently` (therefore to both `next dev` and `electron .`), and the packaged child still receives `LH_DATA_DIR: DATA_DIR()` (`main.cjs:235`). Old mismatch gone.

**3. Symlink escape — FIXED, no false refusals.** Live `ln -s` fixture, 14 cases: `link/secret.txt` (dir symlink out) refuse, `leaffile` (file symlink out) refuse, `link/does-not-exist-yet.txt` refuse, `sub/sneaky` (nested symlink out) refuse, `../x` / `/etc/passwd` / `a/../../b` / `""` / `..foo` refuse; `hello.py`, `sub/deep/n.py`, `insidelink/deep/n.py` (symlink *inside* the workspace) accept; symlinked **root** accepted for in-tree paths and refused for `../secret2.txt`. With the realpath pass deleted, `link/secret.txt` is returned as accepted ⇒ the pin at `tests/open-in-editor-regressions.test.ts:60` is real.

**4. `.editor.json` trust — FIXED.** `createOpenInEditorTool` with a planted file: honest socket → 1 spawn; `socket=/tmp/attacker.sock`, `socket=127.0.0.1:9229`, `cwd=/tmp`, `socket=editorSocketPath(root,"other")` → all refused with **0 spawns**; a `cwd` reached through a symlink to the root is still accepted (correct, `samePath` realpaths). Check at `open-in-editor.ts:120-133`.

**5. Reuse resize — FIXED.** `start(80×24)` then `start(132×44)` → one `resize(132,44)` on the original pty; repeating `132×44` → no duplicate ioctl; `cols:0, rows:-4` → falls back to current (`clampCell(cols, session.cols)`), no bad ioctl.

**6. Subscribe-before-start / one autofocus / unmount — code argument only (no DOM seam exists).** `components/code/terminal-pane.tsx:123-135`: `sessionId = expectedId` and both `onData`/`onExit` are pushed onto `cleanups` *before* `await bridge.start(...)`; preload registers real `ipcRenderer.on` listeners synchronously, and main's `webContents.send` during the synchronous spawn therefore has a listener. Exactly one pane focuses (`code-view.tsx:42` `autoFocus` is only on the editor; `terminal-pane.tsx:192`). Cleanup (`:201-216`) covers IPC offs, `term.onData`/`onResize` disposables, three DOM listeners, debounce timer, `ResizeObserver`, `bridge.kill`, `releaseTerminalFocus`, `terminal.dispose()`, `host.replaceChildren()` — nothing missing. StrictMode double-effect cannot double-spawn or spuriously kill: cleanup runs synchronously before the dynamic import resolves, so `sessionId` is still `null` and no kill is sent.

**7. CodeGate — FIXED.** `bridge=null|undefined` → `data-testid="code-pending"`, no notice, no panes; `false` → notice; `true` → panes (`tests/code-gate.test.tsx:27-59`, render-based via `renderToStaticMarkup`). `code-view.tsx:22,40` starts at `null`, so the desktop app's first paint is the placeholder and the notice is unreachable unless `window.lh.code` is genuinely absent.

**8. Write chunking — FIXED and code-point safe.** 3-chunk payload with an emoji at the first cap boundary and `𝄞` at the second: chunks `65535,65536,13`, `join === payload`, every chunk ≤ cap, no chunk starts with a low surrogate, none ends with a high one. Implementation (`code-session.cjs:246-252`) decrements `end` when `data.charCodeAt(end-1)` is in `D800–DBFF`, i.e. the split moves *before* the high half; `end` can never collapse to `index` because `end ≥ index+65536`.

**9. Client env — FIXED.** `editorClientEnv` (`code-editor.ts:94-100`) strips `ELECTRON_RUN_AS_NODE`, `LH_DESKTOP_API_SECRET`, `LH_DESKTOP_SERVER`, `NVIM_APPNAME`; `defaultExec` passes it as `{ env }` (`open-in-editor.ts:62-68`), verified end-to-end by the regression test recording the third `execFile` argument. Node's spawn skips `undefined` env values, so the deletes are safe.

**10. Packaging — correct, and the allow-list still validates.** Simulated app-builder-lib's own `minimatchAll` (`node_modules/app-builder-lib/out/util/filter.js`, patterns applied in list order, last decisive match wins) over the real `files` array: `electron/main.cjs` IN, `node_modules/node-pty/lib/index.js` IN, `node_modules/node-pty/build/Release/pty.node` IN, `node_modules/node-pty/prebuilds/win32-x64/pty.node` IN, `…/pty.pdb` **excluded**, `node_modules/node-addon-api/napi.h` **excluded**, `node_modules/next/…` excluded. `node-addon-api` is referenced only by `node_modules/node-pty/binding.gyp:4,54` (gyp-time `node -p require(...)`), nothing under `lib/` requires it, and `build/Release/pty.node` exists locally. `tests/desktop-platform.test.ts` 18/18 including `validateConfiguration`.

**11. `killAll` wiring — FIXED, idempotent.** `main.cjs:663` (window-all-closed, before the darwin-resident branch), plus `:673-675` (`before-quit`, `process exit`, `SIGHUP`). `killAll` is `dispose`-then-`clear`; a second call iterates an empty map (verified) and the late `onExit` of each killed pty is swallowed by the identity guard.

**12. Parity + pins — real.** `tests/code-session-regressions.test.ts:149-156` compares `clampCell` **across the two implementations** for 8 fixtures plus the explicit `max` argument, and `MAX_WRITE_CHARS` equality. Revert simulation on a `/tmp` copy: guard removed → survive/stateFile/write/killAll all fail; reuse resize removed → `resizes == []`; chunking replaced with `slice` → `chunks 1`, reassembly `false`; realpath pass removed → escape accepted; the 4-var env strip removed → `options.env.LH_DESKTOP_API_SECRET` present. All four regression files go red under their reverted code.

**13. No unrelated dependency churn.** `git diff package.json` = 5 feature deps + the `desktop:dev` prefix; `micromark-extension-math` is untouched (the reordering is gone). `package-lock.json` = 6 added `node_modules/*` entries (`@xterm/*`, `node-pty`, `node-addon-api` as node-pty's dependency) plus `"libc"` metadata normalisation; no removed package, no version bump.

**14. CodeView test — render-based for the gate half, still source-text for the wiring half.** `tests/code-gate.test.tsx` genuinely renders all three bridge states; `tests/code-view.test.tsx:26-32` still `readFileSync` + regexes (`<CodeGate bridge={hasBridge}>`, `<TerminalPane kind="editor"`). The claim as written ("render-based now, not source-substring only") is accurate; the wiring pin remains weak (Finding F4).

---

### Bug

**None.** Every blocker and security finding from round 1 is genuinely fixed in the code, and no new must-fix defect surfaced in the areas the fix touched (argument handling, cleanup races, env sanitiser, `LH_DATA_DIR` in packaged mode, the `code-gate.tsx` extraction, CJS/ESM mirror drift).

---

### Finding

**F1 — the acceptance document now contradicts the fixed code in three places** (code is right, doc is wrong; fix before the tester grades).
- `docs/coding-pane/build.md:110` — "each `lh:code:write` payload is truncated to 64 KB — a huge paste loses the tail". False since item 8: the payload now arrives complete in ≤64 KiB chunks. A tester following the doc will report "behaviour differs from build.md", or worse, grade F5 as unverified because the documented cap is gone.
- `docs/coding-pane/build.md:108-109` — "the dev workspace is `…/LearnHarness-dev/data/code/scratch`". False since item 2: with `LH_DATA_DIR=./data` the dev workspace is `<repo>/data/code/scratch`. A tester looking in `~/.config/LearnHarness-dev/data` finds nothing and concludes F6/F7 failed.
- `docs/coding-pane/build.md:39` — still lists the `node_modules/node-addon-api/**/*` positive that item 10 removed.
Minimal fix: three line edits in `build.md` (`plan.md` bars the worker from `docs/`, so this is a parent action). Trace: the fix report's "Deliberately not fixed" and residual-risk sections never mention the two behavioural claims it invalidated.

**F2 — the "one shared data-dir rule" parity test compares two mirrors, not the production pair.** `src/core/code-editor.ts:85` `resolveDataDir` is called from **nothing** in production (only `tests/code-session-regressions.test.ts:159-166`); the agent's real root is the inline rule at `config.ts:17-19` and reaches the tool as `PATHS.data` (`open-in-editor.ts:98`). Concrete divergence I measured: `LH_DATA_DIR="  "` → agent root `/…/learnharness/  `, `resolveDataDir(process.env, userData)` → `/home/me/.config/LearnHarness-dev/data`, i.e. main and the agent split again while the parity suite stays green. Trigger for the realistic case: anyone edits `config.ts`'s `path.resolve`/fallback and no test notices. Minimal fix: either have `config.ts` call `resolveDataDir`, or assert `PATHS.data` in the parity test (`desktop:dev`'s relative form) instead of a second helper.

**F3 — the env strip list is pinned per-variable, not per-parity.** `tests/code-session-regressions.test.ts:175-181` hardcodes the four names it expects `editorClientEnv` to delete; nothing compares `sessionEnv` and `editorClientEnv`. Trigger: add a new secret name (e.g. a future `LH_DESKTOP_TOKEN`) to `sessionEnv` (`code-session.cjs:74-84`) only → every test green, and the `nvim --remote` client inherits it. Minimal fix: `assert.deepEqual(pickStrips(core.editorClientEnv(env)), pickStrips(cjs.sessionEnv(env)))` on one fixture containing every known flag.

**F4 — `tests/code-view.test.tsx:26-32` still passes with the feature broken.** It matches source text, so it is green if `TerminalPane` renders nothing, never spawns, or leaks its pty; only the *gate* decision is behaviour-pinned. Trigger: change `autoFocus` to `false` on both panes, or make `boot()` return immediately — both stay green. Minimal fix: assert `<CodeGate bridge={hasBridge}>` gone-in-favour-of a render test that mounts `CodeView` with a fake `window.lh.code` (needs a DOM harness the repo does not have) or, cheaply, extend `code-gate.test.tsx` with a `bridge=true` case whose child count equals 2.

---

### Note

- **N1 (pre-existing, partly improved).** Reuse has no screen replay. After a renderer reload (`Ctrl+R`) main keeps the pty, the new xterm is blank, and the fix's `resize` only forces a SIGWINCH repaint when the geometry *differs* — same window size ⇒ the editor pane stays blank until the first keystroke. Not introduced here; the fix strictly improves the changed-geometry case.
- **N2.** In plain `npm run dev` the tool still resolves the workspace to `<repo>/data`, so a planted `.editor.json` there remains reachable; the socket/cwd check reduces it to "dial this workspace's own socket path", and `data/` is gitignored (`.gitignore:2`), so it needs a local writer. The round-1 security "tail" is mitigated, not removed.
- **N3.** Only the *script* is pinned: `next dev` + `LH_DEV_URL=… electron .` launched by hand (no `LH_DATA_DIR`) still produces the two roots (`build.md`'s instructions use `npm run desktop:dev`, so the documented path is safe).
- **N4.** `LH_DATA_DIR=./data` inside the script overrides an exported `LH_DATA_DIR`, so a developer who used it for `desktop:dev` silently writes to `<repo>/data` now. Both children agree, so no mismatch — just an override.
- **N5.** `write` is no longer bounded: an N‑byte paste becomes N/64 KiB synchronous `proc.write` calls on the Electron main thread (previously one truncating call). Fine for normal pastes; worth knowing if a paste ever freezes the UI.
- **N6.** Reverse-order race, very unlikely: if a remounting pane's `start` reaches main before the previous pane's `kill` (`terminal-pane.tsx:206`), the reuse returns and the late `kill` then kills the just-attached session. The mount path awaits four dynamic imports before `start`, so `kill` is always sent first in practice.
- **N7.** The `.pdb` exclusion is verified against app-builder-lib's *matcher*, not a built asar; whether electron-builder feeds the same `files`-excluded set into `asarUnpack` is unverified here (an `electron-builder` run would write `dist/`).
- **N8.** `tests/code-session.test.ts:64-70` still asserts `clampCell` against hardcoded values instead of against the mirror; harmless now that `code-session-regressions.test.ts:149-156` does the comparison, but the two files overlap.
- **N9.** The fix report's counts (`pass 34 / fail 5`) and "residual risk 1" are stale: the two gate-blocked files were patched afterwards and the suite is now at the parent's 3592/3-pre-existing state. No action, just do not cite those numbers.
- **N10.** The fix report cites guard lines `:196-215` / `:163-169`; the actual lines are `:209` / `:157`. Cosmetic, but a `debugger` starting from the report will land a dozen lines off.

---

### Verified (commands)

| command | result |
|---|---|
| `NODE_ENV=test npx tsx --test tests/code-session-regressions.test.ts tests/open-in-editor-regressions.test.ts tests/code-gate.test.tsx tests/code-view.test.tsx tests/code-session.test.ts tests/open-in-editor-tool.test.ts tests/code-ipc.test.ts` | 39/39 pass, 0 fail |
| `NODE_ENV=test npx tsx --test tests/desktop-platform.test.ts` | 18/18 pass (incl. `validateConfiguration` with the new `asarUnpack`) |
| `npm run typecheck` | exit 0, no output |
| `npm run lint` | 0 errors, 1 pre-existing warning `tests/source-name-ui.test.tsx:26` |
| `node -e` fake-pty: start→kill→start→stale exit, with a stand-in socket file | session/state/socket survive; `write`/`resize` true; `killAll` kills B; idempotent; stale exit broadcasts nothing, live exit broadcasts `code 3` |
| `node -e` on a `/tmp` copy with the identity guard removed | survives `false`, stateFile `false`, write `false`, killAll misses → pin is real |
| `tsx` fixture: 14 `resolveWorkspacePath` cases with real `ln -s` | escapes refused, legit nested/inside-symlink accepted, symlinked root handled |
| `tsx` on a `/tmp` copy with the realpath pass removed | `link/secret.txt` accepted → pin is real |
| `tsx` `createOpenInEditorTool` with 6 planted state files | honest accepted (1 spawn); foreign socket / tcp target / other cwd / other scope refused with 0 spawns |
| `node -e` clip: 2-emoji, 2-boundary payload | 3 chunks, ordered, ≤cap, no lone surrogates |
| `node -e` reuse geometry (`132×44`, same, `0×-4`) | one `resize(132,44)`, then no duplicate, then clamped |
| `tsx` `resolveDataDir` CJS vs TS on 4 fixtures | identical; `./data` → repo path |
| `LH_DATA_DIR=./data npx tsx config.ts` / without | both `<repo>/data` (no dev data move) |
| `LH_DATA_DIR="  "` config.ts vs `resolveDataDir` | **diverge** (`<repo>/  ` vs `<userData>/data`) → Finding F2 |
| `Minimatch` replay of app-builder-lib's `minimatchAll` over the real `files` array | pdb excluded, prebuilds/`build/Release` included, node-addon-api excluded, other deps unaffected |
| `grep node-addon-api node_modules/node-pty/{lib,scripts,package.json}` | only `binding.gyp:4,54` + the `dependencies` entry → build-time only |
| `git diff package.json` / `git diff package-lock.json` | feature deps + `desktop:dev` only; lockfile = 6 new entries + `libc` normalisation |
| `git status --porcelain` after the audit | byte-identical to before |
| not run | `npm run build` / `electron-builder` / live Electron (would write `.next/`, `dist/`, or need a display). Items 6 (IPC ordering, focus) and the asar/unpack step of item 10 rest on code + matcher simulation, labelled as such above. |