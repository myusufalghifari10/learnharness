"use client";

/**
 * The bridge gate for /code (2026-11-11; extracted by review round 1).
 *
 * Three states, three honest answers:
 *   null / undefined — not measured yet (server render + first client paint):
 *                      a neutral placeholder, NEVER the "desktop only" notice,
 *                      which used to flash in the desktop app before the bridge
 *                      probe ran.
 *   false            — a plain browser tab: the notice.
 *   true             — the panes.
 *
 * Kept as its own component so this decision is render-testable without pulling
 * xterm's stylesheet into a Node test.
 */

import type { ReactNode } from "react";
import { CodeDesktopNotice } from "./desktop-notice.tsx";

export function CodeGate({ bridge, children }: { bridge: boolean | null | undefined; children: ReactNode }) {
	if (bridge === null || bridge === undefined) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center px-6" data-testid="code-pending">
				<span className="text-sm text-muted-foreground">Preparing the workspace…</span>
			</div>
		);
	}
	if (!bridge) return <CodeDesktopNotice />;
	return <>{children}</>;
}
