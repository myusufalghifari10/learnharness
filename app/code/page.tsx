import { CodeView } from "@/components/code-view.tsx";

// Dynamic like every other page: the pane is client-owned but the shell route
// must never be statically cached into the standalone build's prerender.
export const dynamic = "force-dynamic";

export default function CodePage() {
	return <CodeView />;
}
