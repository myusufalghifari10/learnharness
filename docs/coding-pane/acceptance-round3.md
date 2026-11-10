# Acceptance round 3: F3 (`Ctrl+/`) and F5 (resize) re-grade, plus regression sweep

Date: 2026-11-11 (local) · Branch `local-searxng-search` (no commits) · Electron 44.9.3 (Node 24.22.0) · Next 16.4.3
Grader: `tester` (read-only on source; this file, `/tmp` scratch, and the app's own dev workspace/data are the only writes)
Spec: `docs/coding-pane/spec.md` (F3/F5 re-graded; F4 and F7 read in their reworded form)

Verdicts are only what I observed on the running app. Where a check could not be run, it says BLOCKED, not PASS.

## Runbook actually used

```bash
cd ~/Github\ Repository/learnharness

# app (dev), same harness as round 1
LH_DATA_DIR=./data nohup npx next dev > /tmp/lh-next.log 2>&1 &            # GET / -> 200
LH_DEV_URL=http://localhost:3000 LH_DATA_DIR=./data \
  nohup npx electron . --remote-debugging-port=9222 > /tmp/lh-dev.log 2>&1 &
curl -s http://127.0.0.1:9222/json/version                                  # Chrome/152.0.7977.167

# UI driver: agent_browser attached over CDP (real click / key / screenshot)
#   { args: ["--session","lhcode","--cdp","9222","open","http://localhost:3000/code"] }
#   click [data-testid="open-code"], click ".xterm-screen", press Control+/, keyboard type, screenshot

# REAL window resize on Wayland (Electron ignores window.resizeTo; wmctrl/xdotool are dead here)
hyprctl dispatch 'hl.dsp.window.float({ window = "address:0x…" })'          # tiled windows resize badly
hyprctl dispatch 'hl.dsp.window.resize({ x = 1000, y = 700, window = "address:0x…" })'

# out-of-band ground truth for the editor (xterm renders to a canvas: no DOM text)
S=data/code/scratch/.nvim-scratch.sock
nvim --server $S --remote-expr 'json_encode({"cols":&columns,"lines":&lines,"ft":&filetype,"wins":winnr("$"),"mode":mode()})'

# byte-level proof of what Ctrl+/ puts on the pty (in the app's shell pane)
dd bs=1 count=1 of=/tmp/raw1f.bin 2>/dev/null     + Ctrl+/ + Enter
od -An -tx1 /tmp/raw1f.bin                        # -> 1f
```

Workspace root: `<repo>/data/code/scratch` (`LH_DATA_DIR=./data`, so editor and agent agree).
Window sizes were changed at the OS level (Hyprland floating window 724×784 → 1000×700 → 1500×950 → 1050×720).

## Verdicts

| # | Feature | Expected (spec) | Observed | Verdict | Evidence |
|---|---|---|---|---|---|
| F3 | LazyVim keybindings survive the host | `Ctrl+/` toggles LazyVim's terminal; `Ctrl+W s` splits; app shortcuts do not fire while typing; typing works in both panes | **Byte proof (new):** in the shell pane `dd bs=1 count=1 of=/tmp/raw1f.bin` + `Ctrl+/` captured **exactly one byte `1f`** (`od -An -tx1` → `1f`, decimal 31). A parallel `cat -v` capture shows `^_` for every `Ctrl+/` press (31-byte file: `^_`, typed text, `^_`, `^_`), which is `cat -v`'s rendering of 0x1f. **Real LazyVim (new):** with the editor focused, `Ctrl+/` opened `term://…/fish` (`&filetype=snacks_terminal`, `term_list` buffer, `mode=t`), `winnr("$")` 1→2→3; screenshot shows the LazyVim terminal pane inside the editor. **No regression:** `Ctrl+W` then `s` → `winnr("$")`=2 with the app window alive (HTTP 200, one CDP page); `Ctrl+C` in the shell → `^C` and a fresh prompt; `Ctrl+D` → `cat` ended and the prompt returned; `Ctrl+B` with a terminal focused left the sidebar at 288 px while the same chord outside the terminal closed it to 0 (control test); plain typing works in the shell (`dd …`, `stty size`, `pwd`) and in nvim (`i` + `typed-into-nvim` + `Esc` → `getline(1)` = "typed-into-nvim", `mode()` = n) | **PASS** | `/tmp/raw1f.bin` = `1f`; `/tmp/f3bytes-r3.txt` (`5e 5f` …); `/tmp/lh-r3-f3.png`, `/tmp/lh-r3-shell2.png`; remote-expr outputs |
| F5 | Resize is honoured by both PTYs | window resize reflows nvim and the shell, no clipping | Four OS-level sizes, measured ~1.2 s after each: **1400×900** → nvim `152×31`, editor canvas 1094 px in a 1112 px pane; **shrink 1000×700** → nvim `96×23`, canvas 691 px in a 712 px pane, `scrollWidth-innerWidth`=0, screenshot shows content inside the pane; **grow 1500×950** → nvim `166×33`, canvas 1195 px; shell `stty size` = **10 rows 166 cols**, `tput cols/lines` = 166/10; **second shrink 1050×720** → nvim `103×24`, shell `stty size` = **7 rows 103 cols**. Both directions, both PTYs | **PASS** | `/tmp/lh-r3-f5-shrink.png`, `/tmp/lh-r3-f5-grow.png`, `/tmp/lh-r3-f5-shrink2.png`; `stty size` outputs; remote-expr readings |
| F1 | Code view reachable, layout | door → `/code`, editor above terminal, no overflow, sidebar works | `[data-testid="open-code"]` click → `/code`; `code-view`, `code-pane-editor`, `code-pane-shell` present; `scrollWidth-innerWidth`=0 at every size tried; sidebar 288 px and toggling | PASS | screenshots above + DOM probes |
| F2 | Real Neovim + LazyVim | dashboard with Nerd Font icons, `:Lazy` loads the user's plugins, real config | dashboard rendered with devicons (New File/Projects/Find Text/Recent Files/Config); LazyVim reports **32 plugins** (`luaeval("#require('lazy').plugins()")` = 32, `~/.local/share/nvim/lazy` = 32); `stdpath("config")` = `/home/yusuf/.config/nvim` | PASS | screenshots + remote-expr |
| F4 | Real shell in the workspace (reworded: configured shell) | `pwd` = workspace, arithmetic in `$SHELL` | fish (`/usr/sbin/fish -l`); `pwd` → `/…/data/code/scratch`; `math 1+1` → `2` | PASS | `/tmp/lh-r3-f4.png` |
| F6 | Workspace persistence | files survive a quit/relaunch | `echo r3-persist > persisted-r3.txt` in the shell (md5 `a57920a8a6556a46c35c20561fce1e6f`); `window.close()`; relaunch; `getcwd()` = workspace, `persisted-r3.txt`, `hello.py`, `world.py` all present | PASS | md5 + `ls -a` before/after |
| F7 | Agent reads the workspace (reworded) | read tool returns the file; chat form only when a model is configured | **Seam: PASS** — `readTool.execute` on `/…/data/code/scratch/persisted-r3.txt` returned `"r3-persist\n"`, `isError: false`. **Chat form: BLOCKED** — this dev data root has **no `data/settings.json` at all**, so no model slot is configured; `POST /api/chat` was rejected at the input boundary (`400 {"error":"input must be an object"}`) before any model gate, and `/api/models` only returns the catalog | **PASS (seam) / BLOCKED (chat form)** | `/tmp/f8-r3.mts` output; `POST /api/chat` 400 |
| F8 | Agent opens a file in the running editor | opens in the live nvim; refuses escapes; no second nvim | `open_in_editor("persisted-r3.txt")` → "Opened persisted-r3.txt in the coding editor." and nvim `bufname("%")` became `/…/scratch/persisted-r3.txt`; `"../outside.txt"` and `"/etc/passwd"` → `Refused: … outside the coding workspace`; `"nope.py"` → `File not found in the coding workspace` | PASS | `/tmp/f8-r3.mts` output + remote-expr |
| F9 | Honest degradation (browser) | notice, no panes, no console error | plain Chromium on `/code`: `window.lh` undefined, `code-bridge-notice` rendered ("The coding workspace runs inside the LearnHarness desktop app…"), 0 panes, `scrollWidth-innerWidth`=0 | PASS | eval probe |
| F10 | No orphan processes | quitting kills nvim and the shell | after **each** of two `window.close()` quits: no `nvim --listen`, no `fish -l`, no `electron`, socket + `.editor.json` removed, port 9222 closed | PASS | `pgrep`/`ss` sweeps |

**Counts: 9 PASS (F1, F2, F3, F4, F5, F6, F8, F9, F10), 1 partially PASS + BLOCKED (F7), 0 FAIL, 0 SKIP.**

## What changed versus my round-1 run

- F3 `Ctrl+/`: was **0 bytes** in the byte probe and no terminal in nvim. Now **exactly `0x1f`** reaches the pty and LazyVim's terminal opens. The fix is real, not a side effect of a different harness (same CDP keyboard path, same pane, same `dd`/`cat -v` probes).
- F5: was a canvas frozen at 706 px with nvim stuck at `98×26`. Now every OS-level resize moves pane, canvas, nvim and the shell's `stty size` together, in both directions.

## Notes (not verdicts)

- **How to resize Electron on this Wayland session:** `window.resizeTo()` is ignored (still 928 px after the call), and a **tiled** Hyprland window took a negative width (`[-3, 784]`, pushed off-screen) when resized by `hyprctl`. The working recipe is: float the window, move it on-screen, then `hl.dsp.window.resize({x,y,window})`. Whoever repeats this should not conclude "resize is broken" from the tiled attempt.
- **Why the first byte probe looked empty:** `cat -v` in a canonical-mode terminal needs a newline before `dd`/`cat` returns anything, so an early `dd bs=1 count=1` wrote 0 bytes until I sent `Enter` after the `Ctrl+/`. The raw proof above is the corrected form; `cat -v`'s `^_` and the `1f` hex agree.
- **Key events are still CDP-injected**, not from a physical keyboard. Every chord tested behaves consistently (`Ctrl+W`, `Ctrl+C`, `Ctrl+D`, `Ctrl+B`, `Ctrl+\`, `Ctrl+/`, plain letters), and `setIgnoreMenuShortcuts` covers the menu-owned chords, so the remaining doubt is small; a 30-second human check of `Ctrl+/` and `Ctrl+W s` would close it entirely.
- **Scratch artifacts I left behind:** the dev workspace now holds `persisted-r3.txt` next to the earlier `hello.py`/`world.py`; one chat record `chat_mwb3s06v_da6a1e40` was created by the F7 probe (its `/api/chat` call 400'd); `/tmp` holds `raw1f.bin`, `f3bytes-r3.txt`, `f8-r3.mts`, screenshots. Nothing was written to source, tests, or docs other than this file.
- **Unsaved nvim buffer at quit:** the app terminated nvim with an unsaved buffer without hanging or prompting, and the process disappeared cleanly (F10).
- `next dev` rewrote `AGENTS.md` again (its own generated block); I reverted it with `git checkout -- AGENTS.md`. `git status` now shows only the feature files and `docs/coding-pane/`.

## Commands run (all this session)

```bash
LH_DATA_DIR=./data npx next dev &                                      # 200
LH_DEV_URL=… LH_DATA_DIR=./data npx electron . --remote-debugging-port=9222 &
agent_browser --cdp 9222: open /code, click door + .xterm-screen, press/keyboard type, screenshot, eval
nvim --server data/code/scratch/.nvim-scratch.sock --remote-expr '…'   # cols/lines/ft/wins/mode/bufname/getcwd
nvim --server … --remote-expr 'luaeval("#require(\"lazy\").plugins()")' # 32
grep + od on /tmp/raw1f.bin (1f) and /tmp/f3bytes-r3.txt (5e 5f …)
dd bs=1 count=1 of=/tmp/raw1f.bin  + Ctrl+/ + Enter                   # 1 byte, 0x1f
hyprctl dispatch hl.dsp.window.{float,move,resize}                     # 1000x700, 1500x950, 1050x720
npx tsx /tmp/f8-r3.mts                                                 # open_in_editor + read seam
echo r3-persist > persisted-r3.txt ; md5sum …                          # persistence fixture
window.close() ×2 ; pgrep -af 'nvim --listen|fish -l|electron \.' ; ss -ltn | grep -E '3000|922'
pkill -f 'next dev' ; git checkout -- AGENTS.md ; git status --porcelain
```

## Release verdict: **ship**

Both round-3 FAILs are now PASS on the fixed code, with numbers rather than impressions: `Ctrl+/` delivers exactly `0x1f` to the pty and opens LazyVim's terminal, and every window resize reflows both PTYs (nvim `152×31 → 96×23 → 166×33 → 103×24`; shell `10×166 → 7×103`). The eight features that passed in round 1 still pass, quitting still leaves no orphans, and the browser path still degrades honestly.

Not blocking release: F7's chat form is BLOCKED until a model is configured in the data root being tested (the read-tool half is proven). The one thing machine testing cannot settle is the *feel* of a physical keyboard in the pane; the byte-level and state-level evidence make that a preference check, not a risk gate.
