// 依存なしのローカルサーバー。index.html を配信し、/api/chat で Claude API を中継する。
// 起動: ANTHROPIC_API_KEY=sk-ant-... node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5"; // 低遅延重視

const SYSTEM = `You are a friendly cashier at a burger restaurant in the United States, role-playing with a Japanese learner of English who is practicing ordering.
Rules:
- The learner's English level is CEFR A1 (absolute beginner). Use only the most basic, common words (top ~500 words) and very simple present-tense sentences. Max 8 words per sentence, max 2 short sentences per turn. No idioms, no slang, no phrasal verbs, no long questions. Speak clearly and a little slowly, but stay polite and natural (e.g. "Hi! What do you want?", "Cheese or no cheese?", "Medium or large?", "Here or to go?", "That is ten dollars.").
- Prefer yes/no or choice questions ("Medium or large?") so the learner can answer with one or two words. Ask only one question at a time.
- If the learner is silent, confused, or says something unclear, repeat the question even more simply, and offer the choices.
- Stay in character as a friendly cashier.
- Follow a realistic flow: greet -> take order -> combo/size/drink -> cooking/customization -> anything else -> for here or to go -> total and payment -> name/number.
- Use the learner's intended order (given in "order_hint") if provided, but react to what they actually say.
- If the learner's English is unclear or wrong, still understand it as best you can and continue the conversation.
Respond ONLY with a JSON object, no other text:
{"reply": "<your spoken line in English>", "reply_ja": "<Japanese translation of your line>", "feedback_ja": "<1 short Japanese sentence: praise first, or a gentle correction of the learner's last English. If you suggest a better phrasing, give it in A1 English (e.g. 'Can I have a burger, please?'). Empty string if nothing to say>", "done": <true if the order is complete and paid, else false>}`;

async function chat(body) {
  const messages = body.messages;
  const system = SYSTEM + (body.order_hint ? `\n\norder_hint: ${body.order_hint}` : "");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "API error");
  const text = data.content.map(c => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { reply: text, reply_ja: "", feedback_ja: "", done: false };
}

http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    let raw = "";
    for await (const c of req) raw += c;
    try {
      if (!KEY) throw new Error("ANTHROPIC_API_KEY が設定されていません");
      const out = await chat(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/save") {
    let raw = "";
    for await (const c of req) raw += c;
    try {
      const { text, audio = [] } = JSON.parse(raw);
      const d = new Date(), p = n => String(n).padStart(2, "0");
      const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const dir = path.join(__dirname, "conversations", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "transcript.txt"), text, "utf8");
      for (const a of audio) {
        const safe = path.basename(a.name); // パストラバーサル防止
        fs.writeFileSync(path.join(dir, safe), Buffer.from(a.b64, "base64"));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ file: `conversations/${id}/`, audio: audio.length }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  // 静的ファイル(PWA用: manifest / sw.js / icons)。それ以外は index.html。
  const STATIC = {
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
    "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
    "/icons/icon-192.png": ["icons/icon-192.png", "image/png"],
    "/icons/icon-512.png": ["icons/icon-512.png", "image/png"],
    "/icons/icon-maskable-512.png": ["icons/icon-maskable-512.png", "image/png"],
    "/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png"],
  };
  const [file, type] = STATIC[req.url.split("?")[0]] || ["index.html", "text/html; charset=utf-8"];
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": type });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
