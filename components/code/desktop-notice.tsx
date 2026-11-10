"use client";

/**
 * The honest browser-tab state for /code (2026-11-11).
 *
 * A plain `next dev` tab has no preload bridge (`window.lh.code`), so no pty
 * can exist. Rather than fake a terminal, the view says so and leaves the
 * rest of the app untouched. Kept in its own module so the static markup is
 * testable without pulling xterm's stylesheet into a Node test.
 */

export function CodeDesktopNotice() {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center px-6">
			<div className="max-w-md rounded-lg border bg-card p-5 text-sm" data-testid="code-bridge-notice">
				<p className="font-medium">The coding workspace runs inside the LearnHarness desktop app.</p>
				<p className="mt-2 text-muted-foreground">
					It spawns your own Neovim and shell, which a browser tab cannot do. Open LearnHarness, then come back to Code.
				</p>
			</div>
		</div>
	);
}
