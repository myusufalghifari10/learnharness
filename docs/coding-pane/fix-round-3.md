# Fix round 3 — F3 (`Ctrl+/`) and F5 (resize never refits)

Date: 2026-11-11 · Branch `local-searxng-search` (no commits) · Round 3 of the 3-round cap · Scope: only the two
acceptance FAILs from `docs/coding-pane/acceptance.md`.

Files touched: `components/code/terminal-pane.tsx` (wiring), `components/code/keys.ts` (new),
`components/code/pane-size.ts` (new), `tests/code-keys.test.ts` (new), `tests/code-pane-size.test.ts` (new).
Nothing else. No dependency added, no spec line changed, no existing test edited.

---

## F3 — `Ctrl+/` produced no byte at all

**Mechanism (one sentence):** Ctrl+Slash produced nothing because xterm resolves `Ctrl+<key>` from a hard-coded
keyCode table that has no entry for 191 (`/`), so the chord encoded to the empty string and died inside xterm
before `term.onData` could hand it to the pty.

**Evidence, not inference.** I read xterm's own encoder, `node_modules/@xterm/xterm/src/common/input/Keyboard.ts`:

- the ctrl branch is gated on `ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey` and then only accepts
  `keyCode` 65-90 (a-z), 32 (space), 51-55, 56, 219, 220, 221 (`Keyboard.ts:268-296`);
- the only other ctrl mappings are the trailing fallbacks `ev.key === '_'` → `C0.US` and `ev.key === '@'` → NUL
  (`Keyboard.ts:341-349`);
- keyCode **191** appears once in that file, in the `KEYCODE_KEY_MAPPINGS` table (`Keyboard.ts:30`), which is used
  for the Alt branch only. So `Ctrl+/` fell through every branch with `result.key === ""`.

That also explains the acceptance asymmetry: `Ctrl+C`, `Ctrl+D`, `Ctrl+W` all worked (letters and the 219-221
range are in the table) while only the slash chord vanished.

**Fix.** `components/code/keys.ts` — `customKeyBytes(event)`: `keydown`, ctrl-only (no alt, no meta), `key === "/"`
or `key === "_"` → `"\x1f"` (C0.US, the byte Ctrl+/ means, the same one xterm already emits for `_`); everything
else returns `null`. Wired in `terminal-pane.tsx:163-172` with `term.attachCustomKeyEventHandler`: when the rule
matches we write the byte through the existing `bridge.write` path and return `false` so xterm does not also process
it; otherwise we return `true` and xterm keeps its own mapping. Deliberately not claimed: `Ctrl+Shift+/` (`?`),
`Ctrl+Alt+/`, `Alt+/`, `Cmd/Ctrl+Meta+/`, plain `/`, `_`, `Ctrl+C/V/W/A/D/Z/Enter/Space` — all pinned as negative
cases so the handler cannot silently swallow a chord the shell or vim wants.

**Pin.** `tests/code-keys.test.ts` (4 tests, 20 assertions): `Ctrl+/ → 0x1F`, `Ctrl+_ → 0x1F`, 17 negative cases,
keyup/keypress/no-type must not emit.

## F5 — the panes never re-fit after mount

**Mechanism (one sentence):** the refit never happened because the only trigger was a single mount-time
`fit.fit()`, and the later resize path both observed an element whose box is content-driven and swallowed the
throw, so one missed/failed notification left the pty at its launch geometry for the life of the pane.

**Evidence.** Reproduced on the running app over CDP (my own run, not the tester's):

```
MOUNT  {"pane":724,"xterm":708,"canvas":706}  nvim: 98 x 26
GROW   {"paneW":1400,"canvasW":706}           nvim: 98 x 26     <- pane changed, terminal did not
SHRINK {"paneW":900,"canvasW":1382}           nvim: 98 x 26     <- clipped instead
```

Then, instrumented on the live page: a **synthetic** `resize` event on `window` refit correctly (screen 706 →
1382, nvim 98 → 192 cols), while an inline width change on the observed element produced **no** ResizeObserver
callback at all and no console output (`Runtime.consoleAPICalled` + `exceptionThrown` captured, empty). So the
renderer never received the notification that the old code depended on.

**Fix.** Two parts, both small:

1. `components/code/pane-size.ts` — `observePaneSize(element, measure, onFire, opts)`: debounced coalescing
   (120 ms, xterm's own advice), skips an unmeasurable box (0 width/height, hidden pane), optional window
   `resize` listener, injected ResizeObserver constructor, full dispose (timer, observer, listener).
2. `components/code/terminal-pane.tsx` — observes the **pane** section (the flex child that really changes size,
   falling back to the host), refits after layout two ways (one `requestAnimationFrame` + one 180 ms retry,
   because xterm's `fit()` returns silently when the box is momentarily unmeasurable), and adds a **250 ms
   geometry watchdog** that refits whenever the measured box differs from the last fitted box. The watchdog is the
   guarantee; RO/window events only make it instant. A failed fit is now `console.warn`-ed instead of swallowed.

**Pin.** `tests/code-pane-size.test.ts` (5 tests): burst of three notifications → exactly one call, later burst
fires again, window resize coalesces with observer bursts, null/zero/zero-height boxes never fire, dispose
disconnects + removes the listener + cancels a pending fire, and "no observer available" is a no-op.

## Red-without-the-fix proof (both pins)

```
# fix neutered (Ctrl+/ rule disabled; debounce replaced with an immediate fire)
NODE_ENV=test npx tsx --test tests/code-keys.test.ts tests/code-pane-size.test.ts
  not ok 1 - customKeyBytes — the chords xterm cannot encode
  not ok 2 - observePaneSize — the refit trigger
  # tests 9  # pass 4  # fail 5

# fix restored
NODE_ENV=test npx tsx --test tests/code-keys.test.ts tests/code-pane-size.test.ts
  # tests 9  # pass 9  # fail 0
```

## Live proof on the running app (CDP, real pty, real nvim)

```
MOUNT         {"pane":1200,"screen":1181} nvim=164x29
resizeTo1000  {"pane":1000,"screen":979}  nvim=136x27     <- F5: pane, canvas and pty all follow
inline 700    {"pane":700, "screen":684}  nvim=95          <- and back
inline reset  {"pane":1200,"screen":1181} nvim=164

F3, editor pane, synthetic keydown through xterm's textarea (the same element CDP/keystrokes hit):
  run A: before bufname=''            -> after Ctrl+/: term://~/Github Repository/learnharness//…:/usr/sbin/fish
  run B: before bufname='term://…fish' -> after Ctrl+/: ''
```

i.e. Ctrl+/ now toggles LazyVim's terminal **both ways** (`<C-/>`), which is exactly the spec clause that failed.

## What the tester must do differently to re-grade

- **F3**: keep the byte probe (`cat -v > /tmp/x`, press `Ctrl+/`, `Ctrl+D`) and expect the file to contain `^_`
  (0x1F) instead of being empty. The decisive, typing-free assertion is the editor pane:
  `nvim --server <sock> --remote-expr 'bufname("%")'` must become `term://…` after the first `Ctrl+/` and stop
  being `term://…` after the second one (it is a toggle).
- **F5**: `window.resizeTo` is unreliable in this Electron/Hyprland session (one call sticks, the next is ignored),
  so resize the **real window** (drag it, or `hyprctl dispatch resizeactive exact …`) and read `&columns`/`&lines`
  through the nvim socket after each step; the pane width, `.xterm-screen` width and `&columns` must move together.
  A 250 ms watchdog means a single reading right after the drag can be one tick early: wait ~400 ms.

## Commands (this session, verbatim tails)

```
NODE_ENV=test npx tsx --test tests/code-keys.test.ts tests/code-pane-size.test.ts   -> # tests 9  # pass 9  # fail 0
npm test          -> # tests 3617  # pass 3610  # fail 3   (the 3 known pre-existing failures only)
npm run typecheck -> exit 0, no output
npm run lint      -> 1 problem (0 errors, 1 pre-existing warning tests/source-name-ui.test.tsx:26)
npm run build     -> exit 0 ("Compiled successfully", route table still lists ƒ /code); next-env.d.ts reverted
git status --porcelain -> feature files only; AGENTS.md and next-env.d.ts clean
```

The three remaining `npm test` failures are the pre-existing ones (search-expansion "all five saved keys",
settings-pure "classifyKeys", subscription-auth pi-ai exports), untouched.

## Residual risks

1. The 250 ms watchdog costs one `getBoundingClientRect()` per tick per pane (two panes) — negligible, but it is a
   timer that must stay disposed with the pane (it is, in `cleanups`).
2. I could not make this Electron build deliver a ResizeObserver notification for a synthetic layout change, and
   real window resizes in this environment cannot be driven reliably from CDP (`resizeTo` sticks once, then is
   ignored). The refit itself is proven for three distinct geometry changes; the *notification* path is what the
   tester must confirm with a real drag.
3. Dev-only, out of this round's scope, observed while testing: an HMR remount can kill the just-attached session
   (review round 2's N6 reverse-order race) — `kill` from the unmounting pane can land after the new mount's
   `start`. It does not affect a packaged app (no HMR) but it does make dev reloads lose the editor.
4. `Ctrl+Shift+/` (`?`) is deliberately left to xterm; if a future LazyVim version binds it, this rule is the place
   to extend.
