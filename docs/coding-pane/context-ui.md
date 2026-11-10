Scope: app/ route layer, components/ shell + panes, proxy.ts/next.config.ts/eslint.config.mjs route+import gating (branch `local-searxng-search`, read-only recon).

# Files Retrieved

- `app/layout.tsx` (1-41) — root layout, provider stack, static `dark` class, fonts
- `app/page.tsx` (1-22) — home page (server component, `force-dynamic`)
- `app/chat/new/page.tsx` (1-30) — draft session page (server, reads `?mode=`)
- `app/chat/[id]/page.tsx` (1-41) — session page (server, passes `chatId` down)
- `app/settings/page.tsx` (1-11) — redirect stub, no page surface
- `app/globals.css` (1-130, 300-330, 480-604) — token blocks, `.dark` mirror, `@theme inline`, font ladder, Electron chrome CSS
- `components/sidebar.tsx` (1-200, 200-320, 600-660, 645-755, 860-959) — `SidebarProvider`, `SidebarToggle`, `SessionRow`, sidebar `aside`, `AppShell`, the `Window.lh` declaration
- `components/home.tsx` (1-340) — full-bleed home view, floating header + dock, teach/practice mode switch
- `components/minimal-home.tsx` (1-210, header only skimmed) — alternate home view when graph rendering is off
- `components/chat.tsx` (85-145, 215-262, 1255-1390, 1740-1810, 2352-2422) — chat pane geometry, `ChatActionsContext`, TopBar, dock
- `components/artifacts/index.ts` (1-62) — the artifact renderer registry
- `components/artifacts/tool-call-card.tsx` (1-121) — the only "command-ish output" renderer today
- `components/artifacts/live-tool-card.tsx` (30-65) — in-flight tool card, `<pre>` input
- `components/settings/appearance.tsx` (1-70) — runtime CSS-var application, dark-only note
- `components/keyboard-shortcuts.tsx` (100-165) — global dispatch switch
- `src/core/keyboard.ts` (1-100, 188) — `KeyAction` union + `KEYBOARD_ACTIONS` registry
- `components/server-events.tsx` (30-158) — events hub (`useServerEvent`, `useServerResync`)
- `components/activity-dock.tsx` (1-60, 96-161) — `ActivityProvider` (sidebar-bottom jobs section)
- `electron/preload.cjs` (28-113) — the `contextBridge` surface
- `electron/main.cjs` (680-770) — the ipc handlers behind it
- `eslint.config.mjs` (1-90), `next.config.ts` (1-90), `proxy.ts` (1-16)

# Key Code

## 1. Route inventory (all under `app/`)

Pages only (every route file; all are **server** components — `grep -c '"use client"' app` = 0):

| route | file | kind |
|---|---|---|
| `/` | `app/page.tsx:13-21` | server, `export const dynamic = "force-dynamic"` (`:8`), renders `components/home.tsx` |
| `/chat/new` | `app/chat/new/page.tsx:22-30` | **async** server, `searchParams: Promise<{mode?: string}>` |
| `/chat/[id]` | `app/chat/[id]/page.tsx:7-40` | **async** server, reads `getChat(id)` → `notFound()`, `?prompt=` |
| `/settings` | `app/settings/page.tsx:9-11` | server, `redirect("/chat/new")` — "modal-only, no page" |

Everything else under `app/` is API route handlers (`app/api/**/route.ts`, 36 files, e.g. `app/api/events/route.ts`, `app/api/chats/[id]/stream/route.ts`, `app/api/jobs/route.ts`). There is **no** route-rendered view for graph, chains, or practice; those are component-level branches inside `/`:

- `app/page.tsx:19-20` — server resolves `resolveSettings(record).graph.rendering` and passes it as prop.
- `components/home.tsx:181-196` — `{rendering ? <GraphView …/> : <MinimalHome …/>}`.

Navigation between views is **route-based, no client view switcher**:
- `components/sidebar.tsx:677` `<Link href="/">` (wordmark / home)
- `components/sidebar.tsx:715` `router.push("/chat/new?mode=practice")`
- `components/sidebar.tsx:771` / `:835` `router.push(\`/chat/${target.id}\`)` (session rows)
- `components/sidebar.tsx:619` `if (pathname === \`/chat/${id}\`) router.push("/")` (delete-current → home)
- `components/keyboard-shortcuts.tsx:120-122` `new-session` → `router.push("/chat/new")`; `:126-129` `jump-graph` → `router.push("/")`
- The only in-page "view switch" is teach vs practice mode state (`components/home.tsx:106-108`, buttons at `:302-322`), and the graph-vs-minimal-home branch above. Neither is a pane registry.

## 2. Where a new 'Code' view would be registered

**There is no enum / array / registry of panes or nav items to add to.** Verified: `grep -rn "ViewId\|type View\|viewMode"` over `components lib src app` yields only unrelated matches (`components/settings/subscription-connections.tsx:31,89,98,116` local dialog state). No sidebar nav-item array exists — the sidebar hard-codes its rows as JSX.

The concrete places a new view's identity must be added by hand:

1. Sidebar action rows (hard-coded JSX, two doors):
   `components/sidebar.tsx:702-722` — the `Teaching` / `Practice` buttons (`data-testid="new-session"`, `data-testid="new-session-practice"`). A third door row would sit in this `flex flex-col gap-1.5` block.
2. Sidebar header link + Settings row:
   `components/sidebar.tsx:670-686` (home `Link`), `:855-867` (the Settings button, `onClick={() => open("…")}` from `useSettingsDialog`).
3. Keyboard action registry (the only real "id list" in the app):
   `src/core/keyboard.ts:22-44` — `export type KeyAction = … | "jump-graph" | …`
   `src/core/keyboard.ts:57-88` — `export const KEYBOARD_ACTIONS: readonly KeyActionDef[]` (id, label, scope, binding), plus `KeyScope = "global" | "chat" | "graph"` at `:46-47`.
   Dispatch switch: `components/keyboard-shortcuts.tsx:119-140` (e.g. `case "jump-graph": handlersRef.current.router.push("/")`).
   Cheat-sheet scopes are enumerated at `components/keyboard-shortcuts.tsx:157-163` (`["global","chat","graph"]`).
4. Route registration: a new file (`app/<segment>/page.tsx`) — `app/layout.tsx:26-38` wraps all children in `AppShell`, so a new page inherits sidebar + providers for free. Nothing lists routes centrally; there is no middleware rewrite map (`proxy.ts` matcher is `/api/:path*` only, `proxy.ts:15`).

## 3. Layout & theming

Shell geometry (flex, **not** grid, **not** resizable/splitter):
- `components/sidebar.tsx:186` — `<div className={cn("flex h-dvh", …)}>` inside `SidebarProvider`.
- `components/sidebar.tsx:651-655` — sidebar `<aside className="sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-72" : "w-0">`, inner `flex h-full w-72 flex-col border-r bg-background` at `:655`.
- `components/sidebar.tsx:948-957` — `AppShell`: `SettingsDialogProvider > SessionsSidebar + <FilePathDropZone className="relative min-w-0 flex-1">{children}</FilePathDropZone> + KeyboardShortcuts`. **The content area is `relative min-w-0 flex-1`** — the anchor a full-bleed pane must fill.
- Full-bleed precedent (home): `components/home.tsx:170` `<div className="relative h-dvh">`, `:178` `<main className="absolute inset-0">`, floating header `:200-206` (`pointer-events-none absolute inset-x-0 top-0`), floating dock `:212-214` (`absolute inset-x-0 bottom-0 pb-5` + `mx-auto w-full max-w-[46rem] px-4`).
- Session pane precedent: `components/chat.tsx:1272` `<div className="flex h-dvh">`, `:1273` `<div className="flex min-w-0 flex-1 flex-col">`, TopBar (in flow, `h-15`), scroller, and the dock overlay at `components/chat.tsx:2352-2357` (`pointer-events-none absolute inset-x-0 bottom-0`, `style={{ right: sbInset }}`).
- Width tokens: `components/chat.tsx:97-98` — `const COLUMN = "mx-auto w-full max-w-none px-6"`, `const DOCK = "mx-auto w-full max-w-[46rem] px-4"`.
- Sidebar auto-close threshold: `components/sidebar.tsx:49` `const SIDEBAR_AUTOCLOSE = 928` (mirrored in `electron/main.cjs`).

Theme tokens (single file `app/globals.css`):
- `:root` palette `:32-59` (`--background:#141414`, `--card:#1c1c1c`, `--border:#434343`, `--radius:8px`, `--lh-prose-size`, `--lh-heading-weight`, `--lh-ink-strong/italic`).
- `.dark` mirrors the same values `:72-95`; `@custom-variant dark (&:is(.dark *))` at `:3`.
- `@theme inline` blocks: fonts + type ladder `:114-176` (`--font-ui`, `--font-prose`, `--font-mono`, `--font-sans`, `--text-*`, `--color-background … --color-ring`), streamdown `--color-sidebar` `:305-307`, non-inline `--font-title` `:302-304` (must stay non-inline so runtime overrides work).
- Base layer: `body` bg/fg/font-ui `:183-186`, prose font/family `:192-198, 244`, thin dark scrollbar `:249-270`.
- Electron chrome CSS `:494-565` — `.lh-electron .lh-drag`, `.lh-no-drag`, `.lh-lights-gutter` (92px / `--lh-zoom`), `.lh-wco-gutter`, `.lh-closed-toggle`. Inert in the browser (class added post-mount at `components/sidebar.tsx:117-121`).
- Dark/light: **dark only**. `app/layout.tsx:26` `<html lang="en" className={\`dark ${ui.variable} ${prose.variable}\`}>`; `app/globals.css:33` `color-scheme: dark`. `next-themes` is in `package.json` but has **zero** usages (`grep -rn "next-themes\|useTheme\|ThemeProvider"` → no matches). Runtime adjustments go through `AppearanceProvider` (`components/settings/appearance.tsx:1-184`), which sets CSS vars on `<html>` (`document.documentElement.style.setProperty`) — mode stays dark (`:11-13` comment).
- Fonts attached in `app/layout.tsx:17-18` (`JetBrains_Mono` → `--font-jetbrains`, `Source_Sans_3` → `--font-sans3`); CMU Serif local `@font-face` `app/globals.css:98-105`.
- Styling helpers: `cn()` from `lib/utils`, Radix primitives under `components/ui/*`, `class-variance-authority` (see `package.json`), `components.json` (shadcn config present).

## 4. Terminal-like UI: none exists

- **`ansi-to-react` is a declared dependency with zero usages.** `package.json:40` `"ansi-to-react": "^6.2.6"`; repo-wide grep (`--exclude-dir=node_modules|.git|dist|build|.next`) matches only `package.json:40` and `package-lock.json:25,6675-6677`. No import anywhere in `components/`, `app/`, `lib/`, `src/`, `electron/`.
- No `xterm`, no PTY, no shell/exec IPC. `electron/preload.cjs:41-113` exposes no command-execution channel; `electron/main.cjs:691-742` handles only chatgpt/subscriptions/attachment-pick/update/zoom/expand-window. There is **no `lh:shell`, no `child_process` bridge to the renderer**.
- What renders command-like output today is `ToolCallCard` (`components/artifacts/tool-call-card.tsx`): a `<details>` one-liner (tool name + headline arg, `:66-90`) expanding to Input/Output/Error `<pre className="… font-mono text-[11px] …">{…}</pre>` blocks (`:95-115`). Output normalization is `outputText()` `:45-60` — plain string verbatim, `{text, images}` object, else `JSON.stringify(output, null, 2)`. **Plain text, no ANSI parsing, no streaming cursor.**
- `LiveToolCard` (`components/artifacts/live-tool-card.tsx:30-65`) shows a running part's `<pre>` input only.
- Registration of tool→renderer: `components/artifacts/index.ts:24-62` `artifactRenderers: Record<string, ComponentType<ArtifactPartProps>>` — the documented extension point ("Add your renderer — do NOT edit chat.tsx").
- Closest existing "terminal glyph" flavor: `components/braille-spinner.tsx` (`:5` comment "the terminal's own glyph language"), used at `components/sidebar.tsx:249`.

## 5. `window.lh` / contextBridge

Bridge definition (Electron side): `electron/preload.cjs:41` `contextBridge.exposeInMainWorld("lh", { … })` → `:41-113`. Exposed keys: `platform`, `getPathForFile`, `chooseAttachmentFolder`, optional `subscriptionTransport`/`openSubscriptionBrowser`, `chatgpt{…}`, `subscriptions{…}`, `expandWindow`, `onZoom`, `getZoom`, `onUpdateStatus`, `installUpdate`, `getUpdateState`, `checkForUpdates`, `onOpenSettings`. IPC handlers: `electron/main.cjs:691-742`; `preload.cjs:36-39` also pushes `lh:open-settings`.

TypeScript declaration — **one global, in a component file, no `.d.ts`**:
`components/sidebar.tsx:59-92`
```ts
declare global {
  interface Window {
    lh?: {
      platform?: string;
      getPathForFile?: (file: File) => string;
      chooseAttachmentFolder?: () => Promise<string | null>;
      subscriptionTransport?: "desktop" | "web";
      openSubscriptionBrowser?: (action: string) => Promise<void>;
      chatgpt?: ChatGPTControlBridge;
      subscriptions?: NativeSubscriptionControlBridge;
      expandWindow: () => void;
      onZoom?: (cb: (factor: number) => void) => () => void;
      getZoom?: () => Promise<number>;
      onUpdateStatus?: (cb: (status: UpdateState) => void) => () => void;
      getUpdateState?: () => Promise<UpdateState>;
      checkForUpdates?: () => Promise<void>;
      installUpdate?: () => void;
      onOpenSettings?: (cb: (section: string) => void) => () => void;
    };
  }
}
```
(`grep -rn "interface Window\|declare global"` over `components app lib src` → this file only.)

Every renderer call site (CONFIRMED, repo-wide grep `window.lh`):
- `components/sidebar.tsx:100` `window.lh?.chatgpt` (provider-level subscription → `notifySettingsSaved("keys")`)
- `components/sidebar.tsx:120` `window.lh?.platform` (→ `dataset.lhPlatform`)
- `components/sidebar.tsx:130-131` `onZoom` / `getZoom` (→ `--lh-zoom`)
- `components/sidebar.tsx:161` `window.lh?.expandWindow()` (opening sidebar while narrow)
- `components/attach-files-button.tsx:46` `Boolean(window.lh?.getPathForFile)` (via `useSyncExternalStore`), `:103` `chooseAttachmentFolder`, `:129` `getPathForFile`
- `components/file-path-drop-zone.tsx:62` `getPathForFile`, `:99` label branch on `window.lh?.getPathForFile`
- `components/settings/chatgpt-connection.tsx:47` bridge identity compare (`bridge !== window.lh?.chatgpt`)
- `components/settings/settings-dialog.tsx:92` `window.lh?.onOpenSettings?.((section) => open(section))`
- `components/settings/subscription-client.ts:31` `window.lh?.subscriptionTransport === "web" ? window.lh.openSubscriptionBrowser : undefined`; `:72` `window.lh?.chatgpt`; `:76` `window.lh?.subscriptions`
- `components/settings/subscription-connections.tsx:21` bridge identity compare
- `components/settings/update-settings.tsx:28` `const lh = window.lh`, `:81` `checkForUpdates`, `:98` `installUpdate`
- `components/update-banner.tsx:33` `window.lh?.installUpdate?.()` (comment `:8` "Browser builds have no window.lh and never see a push")

Pattern: every access is optional-chained and guarded for SSR (`typeof window !== "undefined"`, or a `useSyncExternalStore` snapshot with `false` server snapshot); the app must remain fully functional with `window.lh === undefined`.

## 6. Session/chat identity

- Source of truth = the URL. `app/chat/[id]/page.tsx:15-16` awaits `params`/`searchParams`, `getChat(id)` → `notFound()`, then passes `chatId={chat.id}` (`:27`) plus `title`, `kind`, `initialMessages`, `initialError`, `initialConfigured`, `initialPrompt`, `initiallyInFlight`, `initiallyCompacting` (`:27-39`). `key={chat.id}` on `<Chat>` (`:26`) forces a remount per session.
- `Chat` consumes it as a prop: `components/chat.tsx:215-226` (`chatId: string`).
- Children learn it from context, not props: `components/chat.tsx:127-140` `export const ChatActionsContext = createContext<{ chatId: string; syncFromServer; sendText; openSetup } | null>(null)`, provided at `components/chat.tsx:1256-1266`. Readers get it via `useContext(ChatActionsContext)` in artifact cards.
- Fetch key: every network call interpolates `chatId` (`components/chat.tsx:295, 360, 670, 790, 829, 939, 1009, 1061`).
- The sidebar does **not** receive it as a prop; it derives the active session from the path: `components/sidebar.tsx:407` `const pathname = usePathname()`, `:831` `active={pathname === \`/chat/${c.id}\`}`, `:619` same expression for the delete-current case.
- `/chat/new` has **no** session id by design: `components/new-session.tsx` creates the chat on first send (`app/chat/new/page.tsx:8-15` comment), then `router.push(target)`.
- Session list data: `GET /api/chats` via the sidebar's `refresh()` (refetched on `[open, pathname]`, `components/sidebar.tsx:645-648`), kept fresh by the server-events hub (`useServerEvent`, `components/server-events.tsx:132`).

## 7. Constraints affecting a client-only pane

- **`'use client'` boundary:** 96 files under `components/` carry it (e.g. `components/sidebar.tsx:1`, `components/chat.tsx:1`, `components/home.tsx:1`, `components/activity-dock.tsx:1`, `components/server-events.tsx:1`); **0 files under `app/`**. Every `app/**/page.tsx` is a server component, so a new pane is registered by a server page that renders a client component, exactly like `app/page.tsx` → `components/home.tsx`.
- **No `next/dynamic` / `ssr: false` anywhere:** `grep -rn "next/dynamic\|ssr: false"` over `components app lib src` → zero matches. The established SSR-safety idiom is instead: module-scope `typeof window !== "undefined"` guard (`components/sidebar.tsx:57` `IS_ELECTRON`), `useSyncExternalStore` with a server snapshot (`components/attach-files-button.tsx:46`), and "start closed, apply localStorage after mount" (`components/sidebar.tsx:108-136`) to avoid hydration mismatch. A client-only pane should follow that idiom rather than introduce `dynamic(..., {ssr:false})` (which would be the first occurrence in the repo).
- **ESLint import law (hard error, `eslint.config.mjs:44-81`):** `components/**` may import **only** `@/src/core` from `src/`; `app/**` may import only `@/src/core` and `@/src/server`; `src/core` may never import `src/agent|server|store`. Enforced by `import/no-restricted-paths`. So a pane in `components/` cannot reach server code, and shared types must land in `src/core`.
- Otherwise ESLint is deliberately not a style linter (`eslint.config.mjs:9-18`); `nextPlugin.configs.recommended` is the only other rule set.
- **Route gating:** `proxy.ts:5-16` (`export function proxy(request)` + `export const config = { matcher: "/api/:path*" }`) returns 403 unless `desktopAPIAuthorized(request.headers)` — `/api/*` is desktop-window-only; page routes are not gated. Any data endpoint the pane needs must ride `/api/*` and pass that check.
- **Build:** `next.config.ts:17` `output: "standalone"`; `outputFileTracingIncludes/Excludes` (`:60-130`) and `serverExternalPackages` (`:134-141`) matter if the pane's backend needs a native dep (the exclusions are documented as load-bearing).
- **Providers already mounted app-wide** (a pane may subscribe without new plumbing): `ServerEventsProvider` (`components/server-events.tsx:122`, hooks `:120,132,147`), `AppearanceProvider` (`components/settings/appearance.tsx`), `SidebarProvider` (`components/sidebar.tsx:98`), `ActivityProvider` (`components/activity-dock.tsx:96`, `useActivity` `:161`). `AppShell` is rendered once in `app/layout.tsx:34`, so it also mounts `SettingsDialogProvider` (`components/sidebar.tsx:949`).
- **Electron chrome obligations** for any full-bleed pane: the window drag surface is class-based (`app/globals.css:511-528`); a top band needs `lh-drag` (and `lh-lights-gutter` if it reaches the left edge, `:539-544`), and home's precedent puts the drag mask **first** in DOM order (`components/home.tsx:161-172` comment).

# Architecture

Data/shell flow, top to bottom:

1. `app/layout.tsx:22-40` — server root layout. Static `<html class="dark">`, fonts, then the provider chain `ServerEventsProvider > AppearanceProvider > SidebarProvider > ActivityProvider > AppShell{children}`, plus `<UpdateBanner/>` outside it.
2. `SidebarProvider` (`components/sidebar.tsx:98-186`) — the flex frame `flex h-dvh`; owns sidebar open/close (localStorage `lh:sidebar-open`), Electron class/dataset, `--lh-zoom`, narrow auto-close, and the ⌘B event listener.
3. `AppShell` (`components/sidebar.tsx:948-957`) — `<SettingsDialogProvider>` wrapping `SessionsSidebar` + the `relative min-w-0 flex-1` content slot + `KeyboardShortcuts`. Every page's pane renders into that slot.
4. Page (server) → picks data, then renders one client view component: `/` → `Home` (graph or minimal), `/chat/new` → `NewSession` (draft), `/chat/[id]` → `Chat`.
5. Pane internals: `Home` = `relative h-dvh` + `absolute inset-0` main + floating header/dock. `Chat` = `flex h-dvh` → column (`flex min-w-0 flex-1 flex-col`) = TopBar + scroller + dock overlay; overlays (`PlanPopup`, `MermaidOverlay`, dialogs) mount as `absolute inset-0` siblings inside the column.
6. State/data: client views fetch `/api/*` (gated by `proxy.ts`), and stay fresh through the SSE hub (`components/server-events.tsx`, fed by `app/api/events/route.ts`) via `useServerEvent` / `useServerResync`. Session identity travels as a `chatId` prop from the server page, then via `ChatActionsContext`.
7. Desktop integration is optional and one-directional: renderer reads `window.lh` (typed only in `components/sidebar.tsx:59-92`), preload maps it to `ipcRenderer.invoke/send` (`electron/preload.cjs:41-113`), main validates sender trust before acting (`electron/main.cjs:691-742`).

# Risks

1. **No pane/view registry to extend (blocker for "matching conventions").** Adding a `Code` view means: a new `app/<segment>/page.tsx` (server) + a hand-edited sidebar door row in the hard-coded JSX at `components/sidebar.tsx:702-722` + manually an entry in `src/core/keyboard.ts:22-44` / `:57-88` and the dispatch switch `components/keyboard-shortcuts.tsx:119-140` if it gets a shortcut. There is no single "add a nav item here" seam, so choose deliberately whether the Code view is a route (`/code`), a `?view=`/`?pane=` searchParam on an existing route (precedent: `?mode=practice`), or a sibling pane inside `Chat` (precedent: `PlanPopup` overlay at `components/chat.tsx:1793`). This is a design decision, not a code fact.
2. **The `relative min-w-0 flex-1` content slot is the only width constraint** (`components/sidebar.tsx:955`); `h-dvh` is repeated per-view (`home.tsx:170`, `chat.tsx:1272`, `sidebar.tsx:186`). A full-bleed pane that forgets `h-dvh`/`min-w-0` will either collapse or push the sidebar (it is `shrink-0 w-72` but the content is `flex-1 min-w-0`, so overflow escapes to the right).
3. **`ansi-to-react` is installed but unused** — adding it is a *new* first usage, and it drags no styling conventions with it (its styles are inline). Today's convention for command output is `ToolCallCard`'s plain `<pre className="… font-mono text-[11px] …">` (`components/artifacts/tool-call-card.tsx:95-115`) on the `bg-card` surface. Whether ANSI colors may break the monochrome token palette (`app/globals.css:32-59`) is an owner decision.
4. **No IPC exists for running commands.** `electron/preload.cjs:41-113` has no shell/pty/exec channel, and `contextBridge` is the only bridge pattern in the repo. A Code pane that executes anything needs a new preload surface + main-side handler + the trust checks the existing handlers perform (`electron/main.cjs:692-694`), plus the `Window.lh` type extension in `components/sidebar.tsx:59-92` (the only declaration site) — i.e. an Electron change, not a UI-only change. UNVERIFIED whether such a channel is planned elsewhere.
5. **`/api/*` is desktop-only** (`proxy.ts:5-16`): a browser tab gets 403. Any pane endpoint must go through `desktopAPIAuthorized`, and dev-time probing of a new route from `curl` will 403 unless it carries the capability header.
6. **`dynamic(..., {ssr:false})` has zero precedent.** Introducing it adds a new pattern that interacts with the "no hydration mismatch" discipline documented at `components/sidebar.tsx:108-121` and `:130-136`. Prefer the existing `typeof window` / `useSyncExternalStore` idiom.
7. **Dark-only theme**: there is no light token set (`app/globals.css:70-95` mirrors dark; `app/layout.tsx:26` hardcodes `dark`). Any color a Code pane introduces must come from the named tokens (`bg-background`, `bg-card`, `border-border`, `font-mono`/`font-ui`), or it will be the odd surface. Terminal-ish color literals (e.g. `text-red-500` already used at `components/artifacts/tool-call-card.tsx:80,105`) are the only escapes in the repo today.
8. **Electron chrome**: a new full-bleed pane with a top band must declare drag/no-drag (`app/globals.css:511-528`), and on darwin reserve the traffic-light gutter (`:539-544`). Home's mask must be first in DOM order (`components/home.tsx:161-172`) — order-based, not z-index.
9. **Session identity for a per-session Code pane** is only available inside `Chat`'s tree via `ChatActionsContext` (`components/chat.tsx:127-140`); the sidebar learns it from `usePathname` (`:407, :831`). A Code pane mounted at the `AppShell` level would have to read the pathname itself — no global session store exists.
10. **Open question (unverified):** whether the intended Code pane is per-session (like `Chat`) or global (like `Home`). The route inventory supports either, but the two imply different registration points (see risk 1).

# Start Here

Open `components/sidebar.tsx:640-960` first: it contains the sidebar `aside` (the hard-coded nav doors a Code view must join), the `Window.lh` declaration, and `AppShell` — the `relative min-w-0 flex-1` slot a full-bleed pane fills. Then `components/home.tsx:160-230` as the canonical full-bleed layout precedent.
