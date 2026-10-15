import { isRetryable } from "./types";

/** Two retries with backoff for transient failures (overload, 5xx, network blips, per-minute rate limits). */
export async function withRetry<T>(fn: () => Promise<T>, debug = false, allowed: () => boolean = () => true, delays = [1500, 4000]): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (attempt >= delays.length || !isRetryable(e) || !allowed()) throw e;
			if (debug) console.warn(`[Storyloom] retrying after: ${e instanceof Error ? e.message : e}`);
			await new Promise((r) => setTimeout(r, delays[attempt]));
		}
	}
}
