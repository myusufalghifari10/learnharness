"use client";

/**
 * The coding workspace view (2026-11-11): a real Neovim editor pane and a real
 * terminal, side by side, inside LearnHarness. The heavy lifting is in the
 * panes and in Electron main; this file only decides layout and the honest
 * "desktop only" state for a plain browser tab.
 *
 * Workspace scope is a constant in v1 (`scratch`): one folder under the app's
 * data dir (`<data>/code/scratch`) that both panes share with the agent.
 */

import { useEffect, useState } from "react";
import { CodeGate } from "@/components/code/code-gate.tsx";
import { TerminalPane } from "@/components/code/terminal-pane.tsx";

const SCOPE = "scratch";

export function CodeView() {
	// null = not measured yet (server render + first client paint agree, so no
	// hydration mismatch); true/false after mount.
	const [hasBridge, setHasBridge] = useState<boolean | null>(null);

	useEffect(() => {
		setHasBridge(Boolean(window.lh?.code));
	}, []);

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col bg-background" data-testid="code-view">
			<header className="lh-drag flex h-15 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-6">
				<div className="min-w-0">
					<h1 className="truncate text-sm font-medium">Code</h1>
					<p className="truncate text-[11px] text-muted-foreground">
						Your own Neovim (LazyVim config) and shell, in one workspace the agent can read.
					</p>
				</div>
				<span className="shrink-0 text-[11px] uppercase tracking-widest text-muted-foreground/70">{SCOPE}</span>
			</header>

			<CodeGate bridge={hasBridge}>
				<div className="flex min-h-0 flex-1 flex-col">
					<TerminalPane kind="editor" scope={SCOPE} label="editor · nvim" className="flex-[3]" autoFocus />
					<div className="h-px shrink-0 bg-border/60" />
					<TerminalPane kind="shell" scope={SCOPE} label="terminal" className="flex-[1]" />
				</div>
			</CodeGate>
		</div>
	);
}
