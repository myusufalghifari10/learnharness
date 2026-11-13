<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

> ### This is a fork
> This repository is **[myusufalghifari10/learnharness](https://github.com/myusufalghifari10/learnharness)**, a
> personal fork of [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness). It is **not** the
> upstream project: upstream keeps the documentation site, releases, issues and support. Builds from this fork are
> unsigned and do **not** auto-update (see the list below). Everything upstream documents still applies unless a
> point in this list says otherwise.
>
> **What this fork changes, in one list**
>
> - **Ask while asking.** While a question is on screen you can send a doubt instead of an answer
>   (`Answer` / `Ask first` toggle, plus an ask box under the collapsed question strip). The model is told the
>   follow-up is a doubt, never a graded answer, and must re-issue the question (verbatim when unchanged) before
>   ending its turn. Your typed answer is carried back when the re-issued question is identical.
> - **Coding workspace.** The desktop coding pane is a single surface: Neovim full screen by default, and quitting
>   Neovim hands the screen to the shell in the same workspace folder. `Mod+Shift+E` jumps between the coding
>   workspace and the last learning session, from inside the terminal too, and the agent sees a live workspace
>   status (read files, open them in the editor).
> - **Web search.** The five upstream engines (Tavily, Brave, Exa, Firecrawl, Ollama) are the default again; a
>   sixth, optional **Custom (SearXNG-compatible)** engine takes a self-hosted endpoint URL. No local stack is
>   required to use this build.
> - **Researcher.** No turn cap: a research job ends when the model finishes, not when a step counter runs out, and
>   a budget-stopped run still yields a brief.
> - **Display.** Code blocks the model flattened into one line are reopened at display time, so fenced code renders
>   as code.
> - **No manual update route.** The application menu no longer offers "Check for Updates…". Automatic checks are
>   the product's own switch: turn them off in Settings → General (`general.autoUpdate: false` in
>   `settings.json`) so an upstream release cannot overwrite the changes above. A fresh build from this fork still
>   starts with them on, exactly like upstream.
> - **English UI everywhere.** Every string added by this fork is English, matching the app.

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

**Bring your files.** In the desktop app, attach PDFs, photos, or any other file with the paperclip, or drag them in. The file stays where it is: the message carries its path, and the agent reads it from there.

The agent can also research questions in the background, create visual explanations, show your own images in the lesson and mark them up with arrows and labels, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Choose your models, then start a session with what you want to understand. You can use provider API keys, supported subscription connections in the desktop app, an installed [Claude Code CLI](docs/claude-code.md), or a [custom OpenAI-compatible endpoint](docs/custom-providers.md), including a local model server. Optional dictation and web search use separate service keys. Web research can use a Tavily, Brave, Exa, Firecrawl, or Ollama key, or a self-hosted SearXNG-compatible endpoint through the optional **Custom** engine, in Settings → Providers → Search. Ollama search uses its hosted service, not a local model server.

See [Getting started](docs/getting-started.md) for model setup, dictation, files, and notes imports, and [context, caching, and costs](docs/compaction-accounting.md) for advanced cache preferences.

Upstream releases auto-update on all three platforms; this fork's builds do not (see the fork notice above).

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. Billing depends on your provider, CLI configuration, subscription, or local setup. The live cost meter estimates known API costs, not subscription, CLI, or custom-endpoint charges.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm ci
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

See the [documentation index](docs/README.md) for all guides, [development](docs/development.md) for setup and checks, [architecture](docs/architecture.md) for the runtime, [keyboard shortcuts](docs/keyboard.md), and [desktop builds and releases](docs/desktop-release.md).

Questions about the fork's changes belong in this repository's issues; upstream bugs and feature requests go to [upstream Issues](https://github.com/amosblomqvist/learnharness/issues).

Security vulnerabilities: report privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
