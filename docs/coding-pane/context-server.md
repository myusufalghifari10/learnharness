# Server / storage / test seams — recon map

Scope: `src/server/**`, `src/store/**`, `src/core/**` (storage paths + auth-keys), `src/agent/tools/**` (file tools + sandbox rules), `tests/**`, `package.json` scripts, `tsconfig.json`, plus the `app/api/**` route wrappers that sit on top of them. Branch `local-searxng-search`, working tree clean (`git status --porcelain` → empty). Read-only recon: no edits outside this file.

Files Retrieved
- `package.json` (1-90, full) — scripts, ESM/CJS boundary (`"type": "module"`, `"main": "electron/main.cjs"`), deps.
- `tsconfig.json` (1-48, full) — compiler flags + the `@/*` alias.
- `eslint.config.mjs` (1-80, full) — the import law (the only enforced rule set).
- `next.config.ts` (1-40 + tracing/serverExternalPackages) — standalone output, external packages.
- `config.ts` (1-30, 55-100, 110-150) — the LH_DATA_DIR seam, PATHS, ledger files, SETTINGS_FILE, AUTH_FILE, PROMPTS_OVERRIDE_DIR.
- `src/core/ports.ts` (1-100) — ChatStore / GraphStore ports.
- `src/core/auth-keys.ts` (1-120) — curated key catalog incl. `SEARXNG_URL`.
- `src/core/file-access.ts` (1-42) — `FileAccessSettings` shape + strict parser.
- `src/core/file-paths.ts` (1-104) — path parsing/quoting only (no fs).
- `src/store/settings.ts` (1-131) — settings.json adapter, file-access repair policy.
- `src/store/chats.ts` (1-80) — one JSON file per chat, write choke point.
- `src/store/atomic-write.ts` (1-60) — `writeFileAtomicSync` crash-safe replacement.
- `src/server/index.ts` (1-57) — THE server barrel (the only src entry app/ may import).
- `src/server/stores.ts` (1-41) — composition root.
- `src/server/chat-handler.ts` (1-120, 160-260) — framework-free `handleChatRequest` / `handleChatInput`.
- `src/server/events-stream.ts` (1-81) — SSE notification channel.
- `src/server/pi/ui-stream.ts` (1-80, 120-135, 355-365) — turn SSE wire.
- `src/server/file-access.ts` (1-28) — settings → policy adapter.
- `src/server/keys.ts` (1-60, 170-215) — env-first key resolution (`keyValue`, `providerKeyPresent`).
- `src/server/search.ts` (1-80, 200-270, 330-363) — engine adapters incl. `searxngProvider`, `resolveSearchEngineFor`, `searchProvider`.
- `src/agent/tools/file-access.ts` (1-104) — the policy seam + `guardSourcePath` / `resolvePolicy`.
- `src/agent/tools/fs-shared.ts` (1-140, 180-209) — mandatory denials, `resolveSourcePath`, `sourceSearchRoots`.
- `src/agent/tools/read.ts` (1-70, 94-123) — read tool factory pattern.
- `src/agent/tools.ts` (1-60) — tool registry composition.
- `app/api/**` route files read: `chat`, `chats/[id]/stream`, `chats/[id]`, `chats/[id]/settings`, `chats/[id]/steer`, `jobs`, `events`, `search`, `settings`, `settings/[section]`, `keys`, `keys/[id]`, `graph/sources`, `graph/nodes/[id]`, `activity/abort`, `stt/token`.
- `tests/data-dir-seam.test.ts` (1-60), `tests/source-organization-route.test.ts` (1-35), `tests/search.test.ts` (1-40, 280-335), `tests/file-access.test.ts` (1-50), `tests/render-settings.test.tsx` (1-25).

Key Code

1. HTTP endpoints: thin Next route wrappers over the server barrel

- The wrapper pattern is always: import from `@/src/server`, export an `async function METHOD`, return `Response`. Example `app/api/chat/route.ts:1-5`:
  ```ts
  import { handleChatRequest } from "@/src/server";
  export async function POST(req: Request) { return handleChatRequest(req); }
  ```
- Dynamic params are the Next 16 Promise form, awaited first: `app/api/chats/[id]/stream/route.ts:16-20` — `export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response>` then `const { id } = await ctx.params;`.
- Catch-all segments: `app/api/settings/prompts/[...segment]/route.ts:48,66`.
- Every dynamic route declares `export const dynamic = "force-dynamic";` (`app/api/events/route.ts:11`, `app/api/search/route.ts:12`, `app/api/jobs/route.ts:3`, `app/api/settings/route.ts:24`).
- Errors: plain `Response.json({ error: "..." }, { status: N })`, no error class escaping to the framework. Status vocabulary observed across routes: 400 (bad body/param), 403 (`chat-handler.ts:230`), 404 (unknown chat/key/section), 409 (conflict: `chats/[id]/steer/route.ts:29`, `graph/coverage/extract/route.ts:29`, `activity/abort/route.ts:47`), 413 (`graph/import/route.ts:124`), 500 (fs failure, `graph/sources/route.ts:8,16`), 502/503 (`stt/token/route.ts:23,37`).
- Domain errors carrying a status are the exception and are mapped at the route: `app/api/graph/nodes/[id]/route.ts:24` — `return Response.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });`; same shape for `SourceDeletionError` at `app/api/graph/sources/route.ts:14-16`.
- Validation errors from a pure parser become 400 with the parser's message: `app/api/settings/[section]/route.ts:66`, `chats/[id]/settings/route.ts:33-37`, plus `ChatInputError` → 400 at `chat-handler.ts:184-191`.
- Machine-readable refusal envelope instead of a message: `modelsNotConfigured(["strong"])` returned as the whole JSON body with 503 (`src/server/chat-handler.ts:240-243`); the missing-provider-key family at `chat-handler.ts:245-260`.
- Server-module signature convention: framework-free `(Request) => Promise<Response>`, with the composition root accepting an injected dependency for tests — `handleChatRequest(req, buildAgent?)` at `src/server/chat-handler.ts:170-198`. Tests drive the seam, not the route (comment at `app/api/chats/[id]/stream/route.ts:12-13`).
- Handler route files are ~5-30 lines; all logic lives in `src/server/*` (the barrel `src/server/index.ts:1-57` is the only `src` import path allowed from `app/`).

2. Data directory conventions

- Resolver: `config.ts:17-19` (CONFIRMED, evaluated at module load):
  ```ts
  const DATA_ROOT = process.env.LH_DATA_DIR
      ? path.resolve(process.env.LH_DATA_DIR)
      : path.join(ROOT, "data");
  ```
  where `ROOT` is the repo root via `fileURLToPath(import.meta.url)` (`config.ts:4-5`).
- `PATHS` (`config.ts:21-29`): `root`, `teacherPrompt` (ROOT-anchored, read-only asset), `data`, `chats` = `<data>/chats`, `graph` = `<data>/graph`, `debug` = `<data>/debug`.
- On-disk layout:
  - `<data>/chats/<chatId>.json` — one record per chat, tab-indented JSON; id guarded by `/^[A-Za-z0-9_-]+$/` (`src/store/chats.ts:22-25`).
  - `<data>/settings.json` (`config.ts:114`) — single delta record, read-modify-write (`src/store/settings.ts:96-123`).
  - `<data>/graph/nodes.jsonl`, `chains.jsonl`, `sessions.jsonl`, `coverage.jsonl` (`config.ts:62-76`); `sources.json` (`config.ts:77`), `source-organization.json` (`config.ts:79`), `positions.json` (`config.ts:83`), `render-settings.json` (`config.ts:89`), `format.json` (`config.ts:96`).
  - `<data>/prompts/` — prompt overrides (`config.ts:129`).
  - `auth.json` is NOT under the data dir: `process.env.LH_AUTH_FILE ?? <ROOT>/auth.json` (`config.ts:145-147`), mode 0600, flat `{ENV_VAR: value}` map (`src/core/auth-keys.ts:6-12`).
  - NOTE: the path is **`<repo>/data`** by default, not `~/.config/LearnHarness/data`. Electron's `main.cjs` passes `LH_DATA_DIR` → userData (comment `config.ts:9-16`); the exact userData path was not opened (UNVERIFIED).
- Writes go through `writeFileAtomicSync(file, text, { allowInPlaceFallback? })` — temp + fsync + rename (`src/store/atomic-write.ts:47-60`), imported as a default `fs` on purpose so tests can patch it (`atomic-write.ts:39`).
- Composition root: `src/server/stores.ts:14-21` wires `chatStore`, `graphStore`, `sourceOrganizationStore`, `jobStore`, `settingsStore`; `effectiveSettings()` reads the record fresh per call (`stores.ts:31-33`). Nothing else constructs an adapter.
- Seam is pinned by `tests/data-dir-seam.test.ts:22-57` (both the set and unset directions; the unset case spawns a child process with the tsx loader).

3. File tools and the sandbox / allow-list model

- Four learner-filesystem tools exist: `read` (`src/agent/tools/read.ts:96,123`), `ls` (`ls.ts:29`), `find` (`find.ts:20`), `grep` (`grep.ts:51`). There is **no write/edit tool for learner files** — `grep` for `name: "write"|"edit"` returns nothing; the shared header states the posture is read-only by construction (`fs-shared.ts:12-16`).
- Two independent gates, in order:
  1. **Mandatory denials** (always on, cannot be overridden by settings): `isSensitivePath` refuses dotenv files, agent/credential dirs (`.ssh`, `.aws`, `.gnupg`, `.claude`, …; list at `fs-shared.ts:52-84`), the app's `AUTH_FILE` and subscription credential files (`fs-shared.ts:91-100,110-124`). Applied inside `checkedSourcePath` before the policy gate (`fs-shared.ts:182-188`).
  2. **Optional folder policy**: `src/agent/tools/file-access.ts` — `FileAccessPolicy { restricted, folders, error? }` (1-8); installed once at the composition root via `setFileAccessPolicy(fileAccessPolicy)` (`src/server/chat-handler.ts:165-167`, provider in `src/server/file-access.ts:16-20`); resolved per call by `resolvePolicy()` (`file-access.ts:73-92`, realpath + stat + access, dedupe nested roots) and enforced by `guardSourcePath()` (`file-access.ts:94-104`), which realpath-resolves first so a symlink cannot escape.
- Semantics: unrestricted by default (`OPEN_POLICY`, `file-access.ts:14`); `restricted: true` + `folders` = allow-list; restricted with an **empty** `folders` = no access at all. An unreadable/corrupt record fails **closed** (`file-access.ts:33-36`, `src/store/settings.ts:39-52`, and the placeholder-blocked policy on unrelated writes at `settings.ts:104-108`).
- Relative paths and omitted args resolve against the **learner's home**, not a cwd (`fs-shared.ts:182-188`, comment 12-17).
- Per-call snapshot: `resolvePolicy()` is called once per tool invocation and passed through a multi-root search (`file-access.ts:71-92`, `fs-shared.ts:192-204`).
- Fit for a per-session "code workspace": the model is a **root list**, not a per-session scope. A workspace dir would need either (a) an added root injected into `FileAccessPolicy.folders` (the policy object is a `readonly string[]`, so per-session extension means either widening the provider signature or a third gate), or (b) a new wrapper that runs `guardSourcePath` against a session root before the global policy. The policy provider is a zero-arg closure (`file-access.ts:19-22`) with no session context, which is the friction point. Inference, UNVERIFIED by any existing code — no per-session filesystem scoping exists anywhere today.

4. Test harness

- Runner: `node:test` through tsx — `package.json:16`: `"test": "NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx"`. Both globs required (`tests/*.test.tsx` for SSR render tests).
- Other commands: `"typecheck": "tsc --noEmit"` (`package.json:19`), `"lint": "eslint ."` (`package.json:18`), `"build": "next build"` (`package.json:13`), `"dev": "next dev"` (`package.json:12`).
- Test file convention: top-level `describe`/`it` from `node:test`, `assert` from `node:assert/strict` (`tests/search.test.ts:12-14`).
- Hermeticity discipline: set `process.env.LH_DATA_DIR` / `LH_AUTH_FILE` to a `mkdtemp` dir **before** the first import, then use dynamic `await import(...)` — `tests/source-organization-route.test.ts:9-17` (imports `GET`/`POST` from the actual route module), `tests/file-access.test.ts:25-28` (assigns `HOME`, `USERPROFILE`, `LH_AUTH_FILE`, `LH_DATA_DIR`), `tests/data-dir-seam.test.ts:24-27`. 72 test files use `mkdtemp`.
- Route-level tests import the route handlers directly and call them with a hand-built `Request` (`source-organization-route.test.ts:17-18`).
- UI tests: `React` is stubbed onto `globalThis` before the import, then `renderToStaticMarkup` (`tests/render-settings.test.tsx:8-15`, `tests/file-access.test.ts:10-14`).
- Helpers: `tests/helpers/` holds only crash/fault injectors and a tiny-pdf builder (`chat-save-crash.ts`, `custom-provider-auth.ts`, `custom-provider-crash.ts`, `tiny-pdf.ts`). Fixtures in `tests/fixtures/` (`claude-code/`, `golden-data/`, `tool-rendering/`, `sample-3page.pdf`). No generic test-utils module: each file stands alone.
- Network is never touched: adapters take an injected `FetchLike` and tests pass a stub (`src/server/search.ts:29-30`, `tests/search.test.ts:288-325`).
- Drift gates exist as tests: `tests/auth-provider-keys.test.ts` re-derives the provider/env table from pi-ai and asserts exact equality (`src/core/auth-keys.ts:96-105`).

5. Long-lived process / streaming patterns

- **SSE over a `ReadableStream`, via a `Response` returned from a route.** No WebSocket server exists (`grep WebSocket` finds only the renderer's direct Deepgram socket in `components/dictation.tsx:374` and the stt token route comment).
- Pattern A — notification channel, one connection per window, ends when the client leaves: `src/server/events-stream.ts:30-80`. `new ReadableStream({ start(controller) { … teardown = stop }, cancel() { teardown?.() } })`, headers `text/event-stream` / `Cache-Control: no-cache, no-transform` / `X-Accel-Buffering: no`, plus a `: ping` every 25 s. Subscribe **before** returning; enqueue is wrapped so a dead socket routes through `stop()`.
- Pattern B — turn stream with background lifetime: `runPiTurn(spec): PiTurnHandle` (`src/server/pi/ui-stream.ts:123`), `piTurnResponse(handle): Response` (`:359`), reattach via `runningTurn(chatId)` / `settledTurnResponse(chatId)` (`src/server/turn-runs.ts:75,96`). Both `POST /api/chat` and `GET /api/chats/[id]/stream` return the *same* stream; cancelling a view detaches only, never aborts the turn (comment `ui-stream.ts:51-55`).
- Wire dialect: `data: {json}\n\n` frames terminated by `data: [DONE]\n\n` (`ui-stream.ts:11-17`); the notification channel uses `event: <type>\ndata: {payload}\n\n` with notify-then-fetch semantics, no replay (`events-stream.ts:7-16`).
- Other long-lived server objects: the turn registry (`turn-runs.ts`, `turn-liveness.ts`), the job runner (`src/server/jobs.ts`, created at `chat-handler.ts:104-124`), the extraction pipeline singleton (`chat-handler.ts:118-120`), custom-provider registration into `piModels()` (`src/server/custom-provider.ts:40-56`), and the claude-code subprocess layer (`src/agent/claude-code/live-processes.ts`).
- Boot side effects live in the composition root, not in route modules: `syncCustomProvider()` at `src/server/stores.ts:38`, `setFileAccessPolicy(...)` / `setJobRespawn(...)` at `chat-handler.ts:163-167`.

6. tsconfig + eslint constraints a new module must satisfy

- `"type": "module"` (`package.json:9`) — repo TS is ESM; `electron/main.cjs` is the CJS island (`package.json:10`, excluded from lint at `eslint.config.mjs:24`).
- `module: "esnext"`, `moduleResolution: "bundler"`, `target: ES2022`, `lib: ES2023 + dom` (`tsconfig.json:3-8`) — the same tsconfig covers server, browser shell and tests, hence `dom` types available everywhere.
- `strict: true` **and** `noUncheckedIndexedAccess: true` (`tsconfig.json:11-12`) — indexed reads are `T | undefined`; the codebase handles this with `!` or guards (`fs-shared.ts:126-135`).
- `verbatimModuleSyntax: true` (`tsconfig.json:13`) — type-only imports MUST use `import type { … }` (see `src/server/stores.ts:10`, `src/server/file-access.ts:7`).
- `allowImportingTsExtensions: true` + `noEmit: true` (`tsconfig.json:14-15`) — **relative imports carry the `.ts`/`.tsx` extension** everywhere in `src/`, `config.ts`, and tests (`src/store/chats.ts:11-20`, `tests/search.test.ts:14`). This is not optional style; test/tsx resolution depends on it.
- `isolatedModules: true`, `allowJs: true`, `resolveJsonModule: true`, `jsx: "react-jsx"` (`tsconfig.json:9,16-18,22`).
- Path alias: `"@/*": ["./*"]` (`tsconfig.json:24-28`) — `@/src/server`, `@/src/core`, `@/components/…` all resolve from the repo root; a new module under `src/server/` is reachable as `@/src/server` only if re-exported from the barrel.
- ESLint enforces **only** the import law (`eslint.config.mjs:4-22`, rule `import/no-restricted-paths` at `:39-72`), with `globalIgnores([".next/**","node_modules/**","data/**","next-env.d.ts","scripts/**","electron/**","dist/**"])` at `:24`:
  - `components/**` → only `@/src/core` (the barrel `src/core/index.ts`).
  - `app/**` → only `./core/index.ts` and `./server/index.ts` (so any new server module must be exported from `src/server/index.ts` before a route may use it).
  - `src/core/**` → never `src/agent`, `src/server`, `src/store`.
  - `src/agent/**` → never `src/server`, `src/store` (deps arrive via factories/closures; precedent `setFileAccessPolicy`, `searchProvider`).
  - `tests/**` and `scripts/**` are unrestricted.
- Not enforced by lint: formatting, naming, import order. `eslint .` ignores `dist/` but **includes** `.tsx` and `eslint.config.mjs` itself.

Architecture (data-flow order)

`app/api/**/route.ts` (thin wrapper, `force-dynamic`) → `@/src/server` barrel (`src/server/index.ts`) → server seam module (`chat-handler.ts`, `events-stream.ts`, `settings-body.ts`, `search.ts`, `keys.ts`, …) → ports in `src/core/ports.ts` → adapters wired only in `src/server/stores.ts` (`src/store/*.ts`) → `config.ts` path constants → `<DATA_ROOT>/…` on disk, all writes via `writeFileAtomicSync`.

Cross-cutting:
- Settings truth: one delta JSON record; `readSettings()` sanitizes on every read (`src/store/settings.ts:96-131`), `effectiveSettings()` resolves over factory defaults (`src/server/stores.ts:31-33`).
- Secrets truth: env-first, file second — `keyValue()` (`src/server/keys.ts:184-192`) with boot fill-gap reflection into `process.env` (`keys.ts:1-30`). This is how a new key like `SEARXNG_URL` becomes live without a restart.
- Push: every emitter in `src/store/*` / `src/server/*` calls `core/events.ts` `emit()`; `GET /api/events` fans out as SSE; clients respond by refetching a plain route (`events-stream.ts:7-16`, `src/store/chats.ts:29-38` "the silence law").
- Agent tools receive their storage/policy deps from `chat-handler.ts` closures, never by importing `src/store` (`src/agent/tools.ts:1-20`, `chat-handler.ts:104-124,165-167`).

Risks / gotchas for the implementer

- New route logic in `app/api/**` will violate nothing by itself, but a new `src/server` module is unreachable from `app/` until it is re-exported in `src/server/index.ts` (`eslint.config.mjs:44-52`). Barrel exports are alphabetically interleaved with comments — add deliberately, not by rewrite.
- `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + explicit `.ts` extensions are the three things a fresh module most often trips on; `npm run typecheck` catches all three.
- `config.ts` evaluates `LH_DATA_DIR` **at module load**. Any code that wants a different data dir in a test must set the env before the first dynamic import (`tests/source-organization-route.test.ts:9-17` shows the exact ritual).
- Route tests importing `app/api/**` pull the whole server barrel, which has **boot side effects** (`syncCustomProvider()` at `src/server/stores.ts:38`). Tests therefore isolate `LH_DATA_DIR` and often stub `LH_AUTH_FILE` with `{}`.
- The file-access policy fails closed on any unreadable settings (`src/store/settings.ts:39-52,104-108`) — a bug that corrupts settings.json silently blocks all learner-file reads and rewrites the record with `{restricted: true, folders: []}` on the next unrelated write.
- `guardSourcePath` requires `Folders` entries already realpath-expanded by the server adapter (`src/server/file-access.ts:10-14`); passing a raw `~/…` string into the agent layer would fail the `path.isAbsolute` policy check (`file-access.ts:29-31`).
- Streaming code must follow the "attach synchronously, then replay" law and must never let `controller.enqueue` throw unhandled (`events-stream.ts:57-70`); `cancel()` must not abort shared state (`events-stream.ts:75-79`).
- `MAX_OUTPUT_BYTES = 50KB` and `WALK_TIMEOUT_MS = 10s` (`fs-shared.ts:33-37`) are the established ceilings for filesystem tooling; new tools are expected to reuse them.
- No `data/` files are traced into the standalone bundle and `auth.json` is excluded (`next.config.ts:35-45`) — a new module that dynamically reads a file at runtime may need an `outputFileTracingIncludes` entry (`next.config.ts:56-100`). This bite has happened repeatedly (comment block at `next.config.ts:78-95`).
- UNVERIFIED: the Electron userData path for `LH_DATA_DIR`, and any per-session workspace concept — neither appears in the files opened here.

Start Here
- `config.ts:17-29` — the data-dir seam and `PATHS`; every storage question resolves from these 13 lines.
- Then `src/server/index.ts` (1-57) for the barrel contract, and `src/server/chat-handler.ts:170-260` for the canonical route-seam signature, validation order, and status-code policy.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "docs/coding-pane/context-server.md answers all 6 assigned questions with path:line evidence drawn only from files opened this run (config.ts:17-19/21-29/62-96/114/129/145-147; src/server/index.ts:1-57; chat-handler.ts:170-260; events-stream.ts:30-80; pi/ui-stream.ts:123,359; turn-runs.ts:75,96; file-access.ts:14-104; fs-shared.ts:52-100,182-204; ports.ts:1-100; stores.ts:14-41; atomic-write.ts:39-60; package.json:9-19; tsconfig.json:3-28; eslint.config.mjs:24-72; tests/source-organization-route.test.ts:9-18)."
    }
  ],
  "changedFiles": [
    "docs/coding-pane/context-server.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --porcelain",
      "result": "passed",
      "summary": "empty output before and after: working tree clean, no app code touched"
    },
    {
      "command": "find src/server src/store src/core src/agent/tools tests app/api electron -type f",
      "result": "passed",
      "summary": "enumerated 36 server modules, 11 store adapters, 9 api route groups, 230+ test files"
    },
    {
      "command": "grep -rn 'WebSocket|ws://|EventSource' src app electron components",
      "result": "passed",
      "summary": "no server-side WebSocket; only renderer Deepgram socket and EventSource client"
    },
    {
      "command": "npm run typecheck / npm test / npm run lint / npm run build",
      "result": "not-run",
      "summary": "read-only recon task; no code changed, so no validation gate was invoked"
    }
  ],
  "validationOutput": [
    "git status --porcelain -> (no output); only docs/coding-pane/context-server.md added by this run",
    "package.json:16 test command confirmed: NODE_ENV=test tsx --test tests/*.test.ts tests/*.test.tsx",
    "package.json:18-19 lint = eslint ., typecheck = tsc --noEmit"
  ],
  "residualRisks": [
    "Electron userData absolute path for LH_DATA_DIR not opened in electron/main.cjs: reported as UNVERIFIED; only the default <repo>/data is confirmed",
    "Per-session code-workspace fit (question 3) is labelled inference: no per-session filesystem scoping exists in the code read; the policy provider is a zero-arg closure (src/agent/tools/file-access.ts:19-22)",
    "claude-code live-process / long-lived subprocess layer skimmed by name only (src/agent/claude-code/live-processes.ts not opened)"
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds one markdown recon file; no source, config, or test files modified.",
  "reviewFindings": [
    "no blockers",
    "note: config.ts:17 resolves runtime data to <repo>/data by default, NOT ~/.config/LearnHarness/data as hypothesized in the task; Electron overrides via LH_DATA_DIR (config.ts:9-16 comment)",
    "note: eslint.config.mjs:44-52 means a new src/server module is unreachable from app/ until re-exported in src/server/index.ts",
    "note: src/store/settings.ts:104-108 rewrites a corrupt file-access policy to {restricted:true, folders:[]} on the next unrelated write (fails closed, but silently changes behavior)"
  ],
  "manualNotes": "Branch local-searxng-search already contains a SearXNG engine (src/server/search.ts:220-265, core/auth-keys.ts:70-74 with SEARXNG_URL validation, tests/search.test.ts:288-332). Any new server-side search work should follow that adapter shape: injected FetchLike, SearchHit normalization via searchHit(), engine resolution in resolveSearchEngineFor."
}
```
