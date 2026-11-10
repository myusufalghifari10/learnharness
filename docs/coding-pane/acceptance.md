# Acceptance: coding workspace (real Neovim/LazyVim + shell) in LearnHarness

Date: 2026-11-11 (local) · Branch `local-searxng-search` (no commits made) · Electron 44.9.3 · Next 16.4.3
Grader: `tester` (read-only on source; this file + `/tmp` scratch are the only writes)
Spec: `docs/coding-pane/spec.md` F1–F10. Verdicts are only what I observed on the running app.

## Runbook actually used

```bash
cd ~/Github\ Repository/learnharness

# 1) Next dev server (the app's logic host; also the F9 browser target)
LH_DATA_DIR=./data nohup npx next dev > /tmp/lh-next.log 2>&1 &
# ready in 2 s: curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/  -> 200

# 2) Electron shell, attached over CDP so real keyboard/mouse events reach xterm
LH_DEV_URL=http://localhost:3000 LH_DATA_DIR=./data \
  nohup npx electron . --remote-debugging-port=9222 > /tmp/lh-dev.log 2>&1 &
# CDP up in 2 s: curl -s http://127.0.0.1:9222/json/version

# 3) UI driver (agent_browser, CDP attach; never the CLI via bash)
#    { args: ["--session","lhcode","--cdp","9222","open","http://localhost:3000/"] }
#    window was 724x784 at boot; widened with window.resizeTo(1440,900) when a
#    normal-width window was needed (below 928 px the sidebar auto-closes).

# 4) Out-of-band ground truth for the editor (xterm is a canvas: no DOM text)
S=data/code/scratch/.nvim-scratch.sock
nvim --server $S --remote-expr 'json_encode({"mode":mode(),"buf":bufname("%"),"wins":winnr("$"),"cols":&columns,"lines":&lines})'
```

Workspace root (dev): `<repo>/data/code/scratch` (confirmed by `getcwd()` and the shell prompt).
Electron userData is overridden by `LH_DATA_DIR=./data`, so editor and agent agree (B2 fix holds).

## Verdicts

| # | Feature | Expected (spec) | Observed | Verdict | Evidence |
|---|---|---|---|---|---|
| F1 | Code view reachable | sidebar `Code` door → `/code`, editor pane on top, terminal below, no overflow, sidebar works | door clicked (`e18`), URL became `/code`; `[data-testid=code-view]` present; `code-pane-editor` at y=92 h=557 and `code-pane-shell` at y=695 h=154 (stacked); `document.documentElement.scrollWidth - innerWidth = 0`; sidebar kept its 288 px, toggle still works | PASS | `/tmp/lh-f1-code.png`, `get url` → `http://localhost:3000/code`, DOM probe output |
| F2 | Real Neovim + LazyVim | LazyVim dashboard with Nerd Font icons from `~/.config/nvim`; `:Lazy` opens lazy.nvim; `<leader>ff` opens the picker; the real config file opens | dashboard rendered with devicons; `:Lazy` → "Total: 32 plugins / Loaded (18)" (matches `~/.config/nvim`); `<leader>ff` → `&filetype = snacks_picker_input`, "Files 775/775"; `:e ~/.config/nvim/lua/config/lazy.lua` → `bufname("%")` = `/home/yusuf/.config/nvim/lua/config/lazy.lua`, `ft=lua`, 53 lines; `stdpath("config")` = `/home/yusuf/.config/nvim` | PASS | `/tmp/lh-f1-code.png`, `/tmp/lh-f2-lazy.png`, `/tmp/lh-f2-picker.png`, remote-expr outputs |
| F3 | LazyVim keybindings survive the host | `Ctrl+W s` splits without closing the window, `<leader>ff` opens the picker, `Ctrl+/` toggles LazyVim's terminal, `Esc`, `i…Esc` insert, app shortcuts don't fire while typing | **Works:** `Ctrl+W` then `s` → `winnr("$")` 1→2 and the app window stayed alive (1 CDP page, `/code` still 200); `<leader>ff` picker opened; `i` `ab` `Esc` → `getline(1)="ab"`, `mode()=n`; `Ctrl+B` with the editor focused left the sidebar width at 263 px (dispatcher stood down). **Fails:** `Ctrl+/` produces nothing — `winnr("$")` stayed 2, no terminal window, and a byte-level probe (`cat -v > /tmp/f3bytes.txt`) captured **0 bytes** while the same probe captured a typed `A` (`/tmp/f3b.txt`, 1 byte) and `Ctrl+_` also captured 0 (`/tmp/f3d.txt`). The nvim mapping exists: `maparg("<C-/>","n")` = `LazyVim/lua/lazyvim/config/keymaps.lua:195`, `maparg("<C-_>","n")` = `:196` | **FAIL** | outputs above + `/tmp/lh-f3-cat.png` |
| F4 | Real shell in the workspace | click terminal, `pwd` = workspace, arithmetic prints `2` | fish (`$SHELL`) started in `/…/data/code/scratch`; prompt shows `learnharness/data/code/scratch`; `math 1+1` → `2`; `Ctrl+C` cancelled a line; `Ctrl+D` ended `cat` | PASS | `/tmp/lh-f4-math.png`, `/tmp/lh-f4-shell.png` |
| F5 | Resize honoured by both PTYs | resizing the window reflows nvim and the shell, no garble | mounted at 724 px window → canvas 706 px, nvim `98x26`. `resizeTo(1440,900)` → pane 1440 px but canvas stayed **706 px** and nvim stayed **98x26** for 10+ s; clicking the pane did not refit. Shrink case (1500→1000 px): pane 1000, canvas still 1483, nvim still `206x29`, and the pane visibly clips (cut dashboard logo, content extending past the right edge) | **FAIL** | `/tmp/lh-f5-shrink.png`, `/tmp/lh-f5-resize.png`, DOM probes + remote-expr readings |
| F6 | Workspace persistence | files survive an app restart, nvim reopens in the same directory | `:w hello.py` wrote `data/code/scratch/hello.py` (`aXYb`). Real quit (`window.close()`): socket + `.editor.json` removed, nvim/fish gone. Relaunch → new nvim with `getcwd()` = `/…/data/code/scratch`; `ls` still shows `hello.py`, `world.py`; `hello.py` md5 `c1cf2e90312987d3e5d34f353fa4c626` unchanged | PASS | `md5sum`, `ls -a`, `getcwd()` after relaunch |
| F7 | Agent can read the workspace | a chat turn that asks the agent to read a workspace file returns its content | **Not gradeable as a turn:** `POST /api/chats` then `POST /api/chat` returned **503** `{"error":"No model configured — set up your models first","code":"models_not_configured","missing":["strong"]}` — `data/settings.json` in this dev data root has no model slot (the packaged app's userData does). The permission path itself is proven: the read tool run through the agent seam on `/…/data/code/scratch/hello.py` returned `"aXYb\n"`, `isError:false` | **BLOCKED** | 503 body; `/tmp/f7-read.mts` output |
| F8 | Agent can open a file in the running editor | tool opens a workspace file in the live nvim; outside-workspace path refused; no editor → clear refusal, no second nvim | against the live editor: `open_in_editor("hello.py")` → "Opened hello.py in the coding editor."; `open_in_editor("world.py")` → nvim `bufname("%")` became `/…/scratch/world.py`; `"../outside.txt"`/`"/etc/passwd"` → `Refused: … outside the coding workspace`; `"nope.py"` → `File not found`; after quitting the app → "No coding editor is running…" and `pgrep` showed **zero** new nvim processes | PASS | `/tmp/f8-call.mts` JSON output + remote-expr |
| F9 | Honest degradation without the bridge | plain browser renders the "desktop app" notice, no console error | plain Chromium on `http://localhost:3000/code`: `window.lh` undefined, `data-testid="code-bridge-notice"` rendered with "The coding workspace runs inside the LearnHarness desktop app…", 0 panes, no overflow; console only React DevTools info + HMR | PASS | DOM probe + `console` output |
| F10 | No orphan processes | quitting terminates nvim and the shell | after each of two `window.close()` quits: `ps` shows no `/usr/sbin/nvim`, no `fish -l`, no electron; socket and `.editor.json` removed. Final sweep after closing everything: no listeners on 3000/922x, no nvim/electron/next processes | PASS | `ps -eo pid,comm` sweeps before/after |

**Counts: 7 PASS, 2 FAIL, 1 BLOCKED, 0 SKIP.**

## Failures (for `debugger`)

### F3 — `Ctrl+/` never reaches the pty (spec clause unmet)

Repro:
1. Open `/code` in Electron, click the editor pane, press `Ctrl+W` then `s` → split appears (`winnr("$")`=2). Everything else in F3 works.
2. Press `Ctrl+/` (LazyVim's terminal toggle). Expected: a terminal window appears (`winnr("$")` grows, `&filetype` becomes a terminal buf). Actual: nothing.
3. Byte-level: in the shell pane run `cat -v > /tmp/x`, press `Ctrl+/`, then `Ctrl+D` → `/tmp/x` is 0 bytes. Same probe with a typed `A` yields 1 byte, so the probe itself is sound. `Ctrl+_` (the other LazyVim binding) is also 0 bytes.
4. `Ctrl+C`, `Ctrl+D`, `Ctrl+W` all reach the pty, so the bridge is healthy — only the `ctrl + "/"` (and `ctrl + "_"`) chord is lost.

Likely cause: xterm 6 has no key mapping for Ctrl+Slash, and the pane installs no `attachCustomKeyEventHandler` (`grep attachCustomKeyEventHandler components/code/terminal-pane.tsx` → nothing), so the keystroke dies in xterm and is never written to the pty.
Suggested fix: in `components/code/terminal-pane.tsx`, `term.attachCustomKeyEventHandler` mapping `event.ctrlKey && (event.key === "/" || event.key === "_")` to writing `"\x1f"` to the session (and returning false so xterm does not also process it). Pin it with a unit test on the handler + a manual byte check.
Caveat: all key events here came through CDP injection; a physical-keyboard confirmation would remove the last doubt, but every other chord behaves, so the asymmetry is real.

### F5 — the terminal panes never refit after mount (resize ignored)

Repro:
1. Open `/code` at the app's default window (724×784). Measure: `.xterm canvas` width 706 px, nvim `&columns=98`, `&lines=26`.
2. `window.resizeTo(1440,900)` (or drag the window). Pane width becomes 1440 px, **canvas stays 706 px**, nvim stays `98x26` after 10+ s. Clicking the pane does not refit either.
3. Shrink case: from a 1500 px window (canvas 1483, pty `206x29`) resize to 1000 px → pane 1000, canvas still 1483, pty still `206x29`; the pane clips (dashboard logo cut, text runs past the right edge).

Expected: SIGWINCH-driven reflow (fit → `onResize` → IPC → ioctl). Actual: the fit runs once at mount and never again on window/pane size change, so the user gets an editor stuck at its initial size (small window → tiny editor with dead space; shrink → clipped content).
Suggested fix: call `fit()` from a `ResizeObserver` on the **pane** (the flex child, not the xterm host whose size is content-driven) plus a `window` resize listener, debounced; and assert `term.cols/rows` change in a test. Note one earlier observation where the canvas *did* reach 1483 px at a 1500 px window, so the current trigger is not the resize event itself — start by adding a log to the fit path.

## Notes (not verdicts)

- **Reload repaints.** `Page.reload` on `/code` → both panes come back painted (LazyVim dashboard + fish banner), i.e. the reuse replay works. Seen in `/tmp/lh-note-reload.png`.
- **`Ctrl+R` while a terminal is focused does not reload the app** (menu accelerators are released by design) — it goes to the shell/editor. Reload must be done from an unfocused area; the dev flow still needs `Ctrl+Shift+R` or the menu.
- **First paint:** I never saw the "desktop only" notice flash in 4 loads (screenshots 1–2 s after load show panes directly), but I did not capture a sub-second timeline, so the placeholder fix is *not* independently graded here (it is render-tested in `tests/code-gate.test.tsx`).
- **No runtime errors.** `/tmp/lh-dev3.log` has no `code-session` failure, no unhandled exception; the renderer console shows only the pre-existing dev CSP warning.
- **`<leader>ff` roots at the repo checkout in dev** because the workspace lives inside the repo (`snacks` picks the git root). Packaged builds put the workspace under userData, so this is a dev-only artefact.
- **`AGENTS.md` is modified in the worktree** (`# This is NOT the Next.js you know` → `## …`, 1 line). `next dev` regenerates its own block; I did not edit it. Revert before committing if you want a clean diff.
- F4's literal check in the spec (`echo $((1+1))`) is **bash syntax**; this app spawns `$SHELL`, which here is fish, so that exact command errors while `math 1+1` prints `2`. The spec line should say "arithmetic works for the configured shell" or name the shell.

## Commands (all run this session)

```bash
LH_DATA_DIR=./data npx next dev &                                   # 200 in 2 s
LH_DEV_URL=… LH_DATA_DIR=./data npx electron . --remote-debugging-port=9222 &
agent_browser --cdp 9222 open http://localhost:3000/ ; click "CODE" ; snapshot/eval/screenshot
window.resizeTo(1440,900) / (1000,800) via page eval, then DOM probes
nvim --server data/code/scratch/.nvim-scratch.sock --remote-expr '…'   # mode/bufname/wins/columns/getcwd
nvim --server … --remote-expr 'maparg("<C-/>","n")'                    # LazyVim binding exists
cat -v > /tmp/f3bytes.txt   + Ctrl+/  vs  + "A"                        # 0 bytes vs 1 byte
POST /api/chats, POST /api/chat (from the app page)                    # 503 models_not_configured
npx tsx /tmp/f8-call.mts ; npx tsx /tmp/f7-read.mts                    # tool seam: open / read
window.close() ×3 ; ps -eo pid,comm | grep -E 'nvim|electron|next'     # quit / orphan sweeps
ss -ltnp | grep -E ':3000|:922[0-9]'                                   # none left after cleanup
```

## Coverage

10 / 10 features exercised: 7 PASS, 2 FAIL (F3, F5), 1 BLOCKED (F7, no model configured in the dev
data root). Nothing SKIPped. Cleanup: all Electron instances, `next dev`, nvim and fish killed; browser
sessions closed; scratch files left in `/tmp` only.

## Release verdict: **do not ship yet**

The feature is genuinely usable end to end — the user's own LazyVim runs inside the app, the shell shares
the workspace, files persist across restarts, the agent can read the workspace and open files in the live
editor, a plain browser degrades honestly, and quitting leaves no orphan processes. But two day-one
usability defects remain: the terminal never re-fits when the window changes size (F5), and `Ctrl+/`, one
of LazyVim's most-used chords, does nothing (F3). Both look like small, local fixes (a `ResizeObserver`
fit, a custom key handler), so one more `debugger` round is enough before a re-grade; F7 needs a model
configured in the dev data root before its chat half can be graded.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Acceptance run only: I started the app (next dev + electron with CDP), drove /code with agent_browser, asserted nvim state through its --listen socket, exercised the agent tool seam from /tmp scripts, and wrote exactly one file (docs/coding-pane/acceptance.md). No source, test or docs file was edited; no git command mutated the tree."
    }
  ],
  "changedFiles": [
    "docs/coding-pane/acceptance.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    { "command": "LH_DATA_DIR=./data npx next dev & curl -o /dev/null -w %{http_code} http://localhost:3000/", "result": "passed", "summary": "200 after 2s" },
    { "command": "LH_DEV_URL=… LH_DATA_DIR=./data npx electron . --remote-debugging-port=9222", "result": "passed", "summary": "CDP up in 2s; window http://localhost:3000/" },
    { "command": "agent_browser --cdp 9222: snapshot/click/eval/keyboard/press/screenshot", "result": "passed", "summary": "F1/F2/F3/F4/F5/F6/F9 flows driven with real input events" },
    { "command": "nvim --server data/code/scratch/.nvim-scratch.sock --remote-expr '…'", "result": "passed", "summary": "ground truth: LazyVim dashboard, 32 plugins, split 1→2, bufname, getcwd, 98x26 vs 206x29" },
    { "command": "cat -v > /tmp/f3bytes.txt + Ctrl+/ (vs typed A)", "result": "failed", "summary": "0 bytes for Ctrl+/ and Ctrl+_, 1 byte for typed text → F3 FAIL" },
    { "command": "window.resizeTo(1440,900) then DOM probe + remote-expr", "result": "failed", "summary": "pane 1440px but canvas stayed 706px, nvim stayed 98x26 → F5 FAIL" },
    { "command": "POST /api/chats + POST /api/chat from the app page", "result": "failed", "summary": "503 models_not_configured (missing strong) → F7 BLOCKED" },
    { "command": "npx tsx /tmp/f7-read.mts ; npx tsx /tmp/f8-call.mts", "result": "passed", "summary": "read tool returns aXYb; open_in_editor opens world.py in the live nvim and refuses escapes/missing/no-editor" },
    { "command": "window.close() x3 then ps/ss sweeps", "result": "passed", "summary": "no nvim/fish/electron leftovers; socket+state cleaned; py files persisted" },
    { "command": "pkill -f 'next dev' ; ss -ltnp", "result": "passed", "summary": "no listeners on 3000/922x after cleanup" }
  ],
  "validationOutput": [
    "F1: get url -> http://localhost:3000/code; code-pane-editor y=92 h=557, code-pane-shell y=695 h=154; scrollWidth-innerWidth=0",
    "F2: lazy.nvim 'Total: 32 plugins'; <leader>ff -> filetype snacks_picker_input; :e ~/.config/nvim/lua/config/lazy.lua -> bufname=/home/yusuf/.config/nvim/lua/config/lazy.lua ft=lua 53 lines",
    "F3: Ctrl+W s -> winnr 1->2, app alive; i ab Esc -> getline(1)=ab mode=n; Ctrl+B -> sidebar width unchanged 263px; Ctrl+/ -> 0 bytes captured vs 1 byte for a typed A",
    "F4: math 1+1 -> 2 in fish at /…/data/code/scratch (spec's $((1+1)) is bash syntax, shell is fish)",
    "F5: mount 706px canvas/98x26 -> window 1440px, canvas 706px, nvim 98x26 after 10s; shrink to 1000px pane leaves canvas 1483 and clips",
    "F6: :w hello.py -> data/code/scratch/hello.py (aXYb); quit clears socket+state; relaunch getcwd=…/scratch, files intact (md5 c1cf2e90…)",
    "F7: /api/chat -> 503 {code: models_not_configured, missing:[strong]}; read tool on hello.py -> 'aXYb\\n', isError false",
    "F8: open hello.py/world.py ok (nvim bufname switched to world.py); ../outside.txt and /etc/passwd refused; no-editor refusal with zero nvim spawned",
    "F9: browser /code -> notice text rendered, 0 panes, console only React DevTools + HMR",
    "F10: after each quit, ps shows no nvim / fish -l / electron; final sweep: no listeners on 3000 or 922x"
  ],
  "residualRisks": [
    "F3 and F5 are FAIL: Ctrl+/ (LazyVim terminal toggle) never reaches the pty, and the panes never re-fit after mount (window resize ignored, content clipped on shrink).",
    "F7 is BLOCKED: no model slot in the dev data root, so the chat-turn half could not be graded; only the read-tool seam was proven.",
    "I drove a real 35B local model server for nothing: the turn never got that far (config gate). No data or settings were changed.",
    "Key events were injected over CDP; a physical-keyboard check of Ctrl+/ would remove the last doubt (every other chord behaved).",
    "next dev rewrote AGENTS.md (one heading line) in the worktree; not my edit — revert before committing."
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds docs/coding-pane/acceptance.md only; the worktree already carried the feature diff from worker/debugger runs.",
  "reviewFindings": [
    "blocker: components/code/terminal-pane.tsx - Ctrl+/ (and Ctrl+_) produce no byte for the pty; LazyVim's <C-/> terminal toggle never fires (F3).",
    "blocker: components/code/terminal-pane.tsx - fit() runs at mount only; window resize does not re-fit, pty stays at its old cols/rows and the pane clips (F5).",
    "blocked: dev data root has no model slot, so a real chat turn returns 503 models_not_configured (F7)."
  ],
  "manualNotes": "Everything else in the spec genuinely works on the running app: real LazyVim (32 plugins) with the user's own config, fish in the shared workspace, persistence across a full quit/relaunch, agent open_in_editor against the live nvim with refusals, honest browser degradation, and zero orphan processes after quit. Runbook: LH_DATA_DIR=./data npx next dev & LH_DEV_URL=… npx electron . --remote-debugging-port=9222, then agent_browser --cdp 9222."
}
```
