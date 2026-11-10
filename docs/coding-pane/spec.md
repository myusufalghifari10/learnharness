# Spec: coding workspace (Neovim/LazyVim) in LearnHarness

Each feature is graded end to end by `tester` against the running app (Electron dev/packaged).
Verdict vocabulary: PASS / FAIL / BUG / BLOCKED / SKIP(reason).

---

**F1 Code view exists and is reachable**
Expected: sidebar shows a `Code` door; clicking it navigates to `/code`; the page fills the content slot
with a workspace: an editor pane on top and a terminal pane below, no layout overflow, sidebar still works.
Exercised by: UI flow (click `Code` door → assert editor pane and terminal pane are present).

**F2 The editor is the user's real Neovim + LazyVim**
Expected: the editor pane renders the LazyVim dashboard (or the LazyVim UI for the opened buffer) with Nerd
Font icons, using `~/.config/nvim`; no plugin/config file of the repo is used. Opening
`~/.config/nvim/lua/config/lazy.lua` edits the real file.
Exercised by: UI flow (focus editor, `:Lazy` opens lazy.nvim; `<leader>ff` opens Telescope file picker).

**F3 LazyVim keybindings survive the host app**
Expected: with the editor focused, `Ctrl+W` then `s` splits the window (the app window does not close),
`<leader>ff` opens Telescope, `Ctrl+/` toggles LazyVim's terminal, `Esc` returns to normal mode,
`i a b Esc` inserts text, and the app's own shortcuts (`Ctrl+B` sidebar) do not fire while typing.
Exercised by: UI flow (send those chords, assert the resulting nvim state via screen text).

**F4 The terminal pane is a real shell in the workspace**
Expected: the terminal pane is focused by clicking it, `pwd` prints the workspace directory, and arithmetic
works in the configured shell (`$SHELL`; fish here, `math 1+1` prints `2`, bash would use
`echo $((1+1))`).
Exercised by: UI flow (click terminal, type `pwd` + Enter, read output, then the shell's arithmetic form).

**F5 Resize is honoured by both PTYs**
Expected: resizing the window (or toggling the sidebar) reflows nvim (`:messages`/statusline fills the new
width, no garbled wrapped layout) and the shell prompt reflows without duplicated output.
Exercised by: UI flow (resize window, screenshot before/after; run `stty size` in the shell and compare to
the pane's rows/cols).

**F6 Workspace persistence**
Expected: files created in the workspace survive an app restart; reopening `/code` starts nvim in the same
directory with the file still present. `data/code/scratch/` (or `$LH_DATA_DIR/code/scratch`) is the root.
Exercised by: UI flow (`:w hello.py` in nvim then quit the app, relaunch, `:e hello.py` shows the content)
plus a filesystem check of the workspace root.

**F7 The agent can read the workspace**
Expected: the agent's read tool returns the content of a file the user created in the workspace (the read
tool is allowed: the workspace is not a sensitive path, unrestricted default policy), and a chat turn that
asks the agent to read it surfaces that content in the answer when a model is configured.
Exercised by: HTTP call (`POST /api/chat` with a prompt that triggers `read` on the workspace file) or the
chat UI flow; when the dev data root has no model configured, the read-tool seam itself is run and the chat
form is reported BLOCKED, never silently passed.

**F8 The agent can open a file in the running editor**
Expected: the `open_in_editor` tool, called with a workspace-relative path, makes the already-running nvim
display that file (buffer name changes); a path outside the workspace is refused with an error, and with no
running editor the tool returns a clear refusal instead of spawning a second nvim.
Exercised by: CLI command (`node --import tsx -e '…tool invoke…'`) against a live editor, plus the chat UI
flow where the agent calls it.

**F9 Honest degradation without the desktop bridge**
Expected: loading `/code` in a plain browser (`next dev`, no `window.lh.code`) renders a clear
"runs inside the desktop app" notice and no console error, and the rest of the app keeps working.
Exercised by: UI flow (`/code` in the browser) and an SSR render test.

**F10 No orphan processes**
Expected: quitting the app terminates its nvim and shell processes; no `nvim --listen <workspace sock>` or
child shell survives.
Exercised by: CLI command (`pgrep -af` filtered by the workspace socket path, before/after quit).

---

## Deliberately not specified

File tree, multi-tab, AI write tool, font/path settings UI, Windows/macOS, auto-update behaviour.
