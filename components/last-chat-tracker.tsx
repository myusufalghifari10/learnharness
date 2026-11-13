"use client";

/**
 * Session-side half of the code/session toggle (owner 2026-11-12).
 *
 * Mounted by the chat page and renders nothing. Two jobs:
 *  1. remember this session as the one `mod+shift+e` returns to;
 *  2. answer the chord from inside a session by opening the coding workspace.
 *
 * It lives here, not in chat.tsx, because it owns no lesson state: the rule
 * for where the toggle lands is components/code/mode-switch.ts.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CODE_PATH, rememberLastChat } from "@/components/code/mode-switch.ts";

export function LastChatTracker({ chatId }: { chatId: string }) {
	const router = useRouter();

	useEffect(() => {
		rememberLastChat(chatId);
	}, [chatId]);

	useEffect(() => {
		const onToggle = () => router.push(CODE_PATH);
		window.addEventListener("lh:kbd-toggle-code", onToggle);
		return () => window.removeEventListener("lh:kbd-toggle-code", onToggle);
	}, [router]);

	return null;
}
