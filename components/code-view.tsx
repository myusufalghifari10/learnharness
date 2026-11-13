"use client";

/**
 * The coding workspace view (2026-11-11, redesigned 2026-11-12).
 *
 * One pane at a time, not a split: the default surface is Neovim across the
 * whole workspace, and leaving Neovim (its process exits) hands the screen to
 * the shell, which runs in the same workspace folder. The tucked-away pane
 * stays mounted so its scrollback survives the switch; the geometry watchdog
 * in terminal-pane refits it the moment it is visible again.
 *
 * Scope is a constant in v1 (`scratch`): one folder under the app's data dir
 * (`<data>/code/scratch`) that the panes share with the agent.
 *
 * Owner 2026-11-12: `mod+shift+e` (Ctrl/⌘+Shift+E) toggles between this
 * workspace and the last learning session — the destination rule lives in
 * ./code/mode-switch.ts, the terminal pane re-dispatches the chord while it
 * owns the keyboard.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CodeGate } from "@/components/code/code-gate.tsx";
import { TerminalPane, type CodeSessionKind } from "@/components/code/terminal-pane.tsx";
import { codeToggleTarget, readLastChatId } from "@/components/code/mode-switch.ts";
import { cn } from "@/lib/utils";

const SCOPE = "scratch";

const PANES: ReadonlyArray<{ kind: CodeSessionKind; label: string }> = [
	{ kind: "editor", label: "Neovim" },
	{ kind: "shell", label: "Terminal" },
];

export function CodeView() {
	// null = not measured yet (server render + first client paint agree, so no
	// hydration mismatch); true/false after mount.
	const [hasBridge, setHasBridge] = useState<boolean | null>(null);
	// The visible pane. Starts on Neovim: that is the workspace.
	const [active, setActive] = useState<CodeSessionKind>("editor");
	// Remount counter: "Reopen Neovim" starts a NEW nvim process. A fresh
	// process means a fresh buffer list — expected, and stated in the UI.
	const [editorRun, setEditorRun] = useState(0);
	const [editorExited, setEditorExited] = useState(false);
	// Focus follows the visible pane without remounting it.
	const [focusToken, setFocusToken] = useState(0);
	const router = useRouter();
	const pathname = usePathname();

	useEffect(() => {
		setHasBridge(Boolean(window.lh?.code));
	}, []);

	const show = useCallback((kind: CodeSessionKind) => {
		setActive(kind);
		setFocusToken((n) => n + 1);
	}, []);

	// Leaving nvim hands the screen to the terminal (owner 2026-11-12).
	const onEditorExit = useCallback(() => {
		setEditorExited(true);
		show("shell");
	}, [show]);

	const reopenEditor = useCallback(() => {
		setEditorExited(false);
		setEditorRun((n) => n + 1);
		show("editor");
	}, [show]);

	// Code → last session. (`mod+shift+e` from a session is answered by the
	// session surface; see components/last-chat-tracker.tsx.)
	useEffect(() => {
		const onToggle = () => router.push(codeToggleTarget(pathname, readLastChatId()));
		window.addEventListener("lh:kbd-toggle-code", onToggle);
		return () => window.removeEventListener("lh:kbd-toggle-code", onToggle);
	}, [pathname, router]);

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col bg-background" data-testid="code-view">
			<header className="lh-drag flex h-15 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-6">
				<div className="min-w-0">
					<h1 className="truncate text-sm font-medium">Code</h1>
					<p className="truncate text-[11px] text-muted-foreground">
						Your own Neovim (LazyVim config) and shell, in one workspace the agent can read.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{editorExited && (
						<button
							type="button"
							data-testid="code-reopen-editor"
							onClick={reopenEditor}
							className="rounded-md border border-border/70 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							Reopen Neovim
						</button>
					)}
					<div role="group" aria-label="Pane" className="flex items-center gap-1 rounded-md border border-border/70 p-0.5">
						{PANES.map(({ kind, label }) => (
							<button
								key={kind}
								type="button"
								data-testid={`code-tab-${kind}`}
								aria-pressed={active === kind}
								onClick={() => show(kind)}
								className={cn(
									"rounded px-2 py-1 text-xs font-medium transition-colors",
									active === kind ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
								)}
							>
								{label}
							</button>
						))}
					</div>
					<span className="text-[11px] uppercase tracking-widest text-muted-foreground/70">{SCOPE}</span>
				</div>
			</header>

			<CodeGate bridge={hasBridge}>
				<div className="flex min-h-0 flex-1 flex-col">
					{/* Both panes stay mounted: the hidden one keeps its scrollback and
					    its pty (that is how leaving nvim does not throw away the shell
					    history). Visibility, not existence, is what switches. */}
					<TerminalPane
						key={`editor-${editorRun}`}
						kind="editor"
						scope={SCOPE}
						label="editor · nvim"
						className={cn("flex-1", active === "editor" ? "" : "hidden")}
						autoFocus
						focusToken={active === "editor" ? focusToken : undefined}
						onExit={onEditorExit}
					/>
					<TerminalPane
						kind="shell"
						scope={SCOPE}
						label="terminal"
						className={cn("flex-1", active === "shell" ? "" : "hidden")}
						focusToken={active === "shell" ? focusToken : undefined}
					/>
				</div>
			</CodeGate>
		</div>
	);
}
