// Fake OpenAI-compatible server on :11434 (where Ollama lives). Records requests to requests.jsonl.
import { createServer } from "http";
import { appendFileSync, writeFileSync } from "fs";
const LOG = new URL("./requests.jsonl", import.meta.url).pathname;
writeFileSync(LOG, "");
const STATE = {
	timeline: [
		{ entity: "Mara Winston", fields: { location: "[[Old Harbor]]", status: "Injured" }, note: "finds Elias at the harbor" },
		{ entity: "Elias Crane", fields: { knows: "Mara is working for Arthur" }, note: "agrees to help Mara" },
		{ entity: "Arthur Vane", fields: { status: "Waiting at the manor" } },
	],
	relationships: [{ from: "Elias Crane", to: "Mara Winston", label: "ally", fromChapter: 3, endsPrevious: true }],
	newEntities: [{ name: "Captain Rook", type: "character", description: "Runs the night boats on the harbor.", aliases: ["Rook"] }],
};
let n = 0;
const PORT = Number(process.env.PORT ?? 11434);
const CORS = process.env.CORS !== "0";
const cors = CORS ? { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" } : {};
createServer((req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(CORS ? 204 : 403, cors);
		return res.end();
	}
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const j = JSON.parse(body || "{}");
		appendFileSync(LOG, JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null, body: j }) + "\n");
		if (req.headers.authorization === "Bearer bad") {
			res.writeHead(401, { "content-type": "application/json", ...cors });
			return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: bad" } }));
		}
		const user = j.messages?.at(-1)?.content ?? "";
		let content;
		if (/report what changed/.test(user)) content = "Here you go:\n```json\n" + JSON.stringify(STATE, null, 2) + "\n```";
		else if (/continuity errors/.test(user)) content = JSON.stringify({ issues: [{ quote: "Elias Crane sat at a high desk", conflict: "Codex: nothing", fix: "None", severity: "low" }] });
		else if (/Rewrite the selected span/.test(user) && /tighten/.test(user)) {
			const sel = user.slice(user.lastIndexOf("⟦") + 1, user.lastIndexOf("⟧"));
			content = sel.replace("opened before she could knock", "swung open before she knocked").replace("filled it, all good tailoring and bad sleep", "filled it: good tailoring, bad sleep");
		}
		else if (/Rewrite the selected span/.test(user)) content = `TENSE VERSION ${++n}. Her heart hammered.`;
		else content = `The fog pressed in. (reply ${++n})`;
		if (j.stream) {
			// Server-sent events, a few words at a time.
			res.writeHead(200, { "content-type": "text/event-stream", ...cors });
			const words = content.split(/(?<= )/);
			let i = 0;
			const tick = setInterval(() => {
				if (i < words.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
				else {
					res.end("data: [DONE]\n\n");
					clearInterval(tick);
				}
			}, 120);
			return;
		}
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/json", ...cors });
			res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
		}, /tighten/.test(user) ? 1800 : 400);
	});
}).listen(PORT, () => console.log(`fake server on ${PORT}${CORS ? "" : " (no CORS)"}`));
