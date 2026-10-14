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
createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const j = JSON.parse(body || "{}");
		appendFileSync(LOG, JSON.stringify({ url: req.url, auth: req.headers.authorization ?? null, body: j }) + "\n");
		if (req.headers.authorization === "Bearer bad") {
			res.writeHead(401, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: { message: "Incorrect API key provided: bad" } }));
		}
		const user = j.messages?.at(-1)?.content ?? "";
		let content;
		if (/report what changed/.test(user)) content = "Here you go:\n```json\n" + JSON.stringify(STATE, null, 2) + "\n```";
		else if (/continuity errors/.test(user)) content = JSON.stringify({ issues: [{ quote: "Elias Crane sat at a high desk", conflict: "Codex: nothing", fix: "None", severity: "low" }] });
		else if (/Rewrite the selected span/.test(user)) content = `TENSE VERSION ${++n}. Her heart hammered.`;
		else content = `The fog pressed in. (reply ${++n})`;
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
		}, 400);
	});
}).listen(11434, () => console.log("fake server on 11434"));
