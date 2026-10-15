/** Minimal server-sent-events parsing. Pure; tested. */

export interface SSEEvent {
	event: string;
	data: string;
}

/** Parse complete events out of `buffer`; returns them plus the unfinished remainder. */
export function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
	const events: SSEEvent[] = [];
	const normalized = buffer.replace(/\r\n/g, "\n");
	const blocks = normalized.split("\n\n");
	const rest = blocks.pop() ?? "";
	for (const block of blocks) {
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (!line || line.startsWith(":")) continue;
			const i = line.indexOf(":");
			const field = i === -1 ? line : line.slice(0, i);
			const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
			if (field === "event") event = value;
			else if (field === "data") data.push(value);
		}
		if (data.length) events.push({ event, data: data.join("\n") });
	}
	return { events, rest };
}

/** Read a fetch body as SSE events. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { events, rest } = parseSSE(buffer);
			buffer = rest;
			yield* events;
		}
		const { events } = parseSSE(buffer + "\n\n");
		yield* events;
	} finally {
		reader.releaseLock();
	}
}

/** Hide reasoning that some local models emit inside <think>…</think>, including an unclosed block while streaming. */
export function stripThinking(text: string): string {
	return text.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, "");
}
