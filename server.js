// 依存なしのサーバー。画面(index.html)を配信し、OpenAIのAPIキーはここにだけ置いて中継する。
// 起動: npm start（ローカルは .env の OPENAI_API_KEY、公開サーバーは環境変数 OPENAI_API_KEY を使う）
const http = require("http");
const fs = require("fs");
const path = require("path");

// .env があれば読み込む(無ければ何もしない。公開サーバーでは環境変数を使う)
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}

const PORT = process.env.PORT || 3000;
const OKEY = process.env.OPENAI_API_KEY;
const RT_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const HOSTED = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.VERCEL || process.env.K_SERVICE);
const KEY_OK = !!OKEY && /^sk-[\x21-\x7e]+$/.test(OKEY);
const RTCFG = require("./rt-config.js");
const TTS_STYLE = {
  default: "Speak in natural, friendly American English like a real person at a burger restaurant. Very clear, crisp and well-enunciated, at a steady pace, not exaggerated.",
  bright: "Speak in natural American English as a bright, cheerful young woman at a burger restaurant: a sunny, smiling voice, slightly higher in pitch, with lively, expressive, upbeat intonation and lots of warmth. Very clear, crisp and well-enunciated.",
  polite: "Speak in natural American English as a polite, courteous man at a burger restaurant: calm, warm and respectful. Very clear, crisp and well-enunciated.",
  rude: "Speak in natural American English as a bored, impatient cashier: flat, curt and a little grumpy, but still very clear, crisp and well-enunciated.",
};
const TTS_VOICES = ["marin", "cedar", "ash", "coral", "alloy", "verse"];

// ---- 悪用・使いすぎ対策(公開サーバーは誰でもURLを知れば呼べるため)
// 1人(IP)あたり1時間の上限と、サーバー全体の1日の上限。環境変数で変えられる。
const LIMITS = {
  session: { perIpHour: Number(process.env.LIMIT_SESSION_IP_HOUR) || 12, perDay: Number(process.env.LIMIT_SESSION_DAY) || 80 },
  tts: { perIpHour: Number(process.env.LIMIT_TTS_IP_HOUR) || 200, perDay: Number(process.env.LIMIT_TTS_DAY) || 1500 },
};
const hits = { session: new Map(), tts: new Map(), day: { session: 0, tts: 0, key: "" } };
function allow(kind, ip) {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (hits.day.key !== today) { hits.day = { session: 0, tts: 0, key: today }; }
  if (hits.day[kind] >= LIMITS[kind].perDay) return false;
  const arr = (hits[kind].get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= LIMITS[kind].perIpHour) return false;
  arr.push(now); hits[kind].set(ip, arr); hits.day[kind]++;
  return true;
}
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
// 別のサイトの画面から呼ばれないようにする(同じサイトからの呼び出しだけ許可)
function sameSite(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (_) { return false; }
}
async function readBody(req, max) {
  let n = 0; const chunks = [];
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

// ---- 本物のspeech-to-speech: OpenAI Realtime のブラウザ用一時キーを発行する(本物のキーは返さない)
async function session(body) {
  if (!KEY_OK) throw new Error("サーバーにOpenAIのAPIキーが設定されていません（環境変数 OPENAI_API_KEY）");
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OKEY}` },
    body: JSON.stringify({ session: RTCFG.buildSession(body, RT_MODEL) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "OpenAI API error");
  return { value: data.value };
}
// 自然な声(単語・会話集の🔊用)。キーはサーバーに置いたまま、音声だけ返す
async function tts(body) {
  if (!KEY_OK) return null;
  const text = String(body.text || "").slice(0, 300);
  if (!text) return null;
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OKEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts", voice: TTS_VOICES.includes(body.voice) ? body.voice : "marin", input: text,
      instructions: TTS_STYLE[body.persona] || TTS_STYLE.default,
      response_format: "mp3", speed: Math.min(2, Math.max(0.5, Number(body.speed) || 1)),
    }),
  });
  if (!r.ok) throw new Error("TTS error " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

const STATIC = {
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/rt-config.js": ["rt-config.js", "text/javascript; charset=utf-8"],
  "/icons/icon-192.png": ["icon-192.png", "image/png"],
  "/icons/icon-512.png": ["icon-512.png", "image/png"],
  "/icons/icon-maskable-512.png": ["icon-maskable-512.png", "image/png"],
  "/icons/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
};

http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (req.method === "POST" && url.startsWith("/api/")) {
      if (!sameSite(req)) return json(res, 403, { error: "forbidden" });
      const ip = clientIp(req);
      if (url === "/api/session") {
        if (!allow("session", ip)) return json(res, 429, { error: "今日は会話の回数の上限に達しました。しばらくしてからまたお試しください" });
        return json(res, 200, await session(JSON.parse(await readBody(req, 200e3))));
      }
      if (url === "/api/tts") {
        if (!KEY_OK) { res.writeHead(501); return res.end("no key"); }
        if (!allow("tts", ip)) { res.writeHead(429); return res.end("limit"); }
        const buf = await tts(JSON.parse(await readBody(req, 20e3)));
        if (!buf) { res.writeHead(501); return res.end("no key"); }
        res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" });
        return res.end(buf);
      }
      if (url === "/api/save") { // 会話の保存は、自分のパソコンで動かしているときだけ
        if (HOSTED) return json(res, 403, { error: "公開サーバーでは保存できません（ダウンロードされます）" });
        const { text, audio = [] } = JSON.parse(await readBody(req, 60e6));
        const d = new Date(), p = (n) => String(n).padStart(2, "0");
        const id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        const dir = path.join(__dirname, "conversations", id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "transcript.txt"), String(text), "utf8");
        for (const a of audio) fs.writeFileSync(path.join(dir, path.basename(a.name)), Buffer.from(a.b64, "base64")); // パストラバーサル防止
        return json(res, 200, { file: `conversations/${id}/`, audio: audio.length });
      }
      return json(res, 404, { error: "not found" });
    }
    // 静的ファイル。それ以外は index.html
    const [file, type] = STATIC[url] || ["index.html", "text/html; charset=utf-8"];
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": type });
      res.end(buf);
    });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}  (APIキー: ${KEY_OK ? "設定済み" : "未設定"}${HOSTED ? ", 公開サーバー" : ""})`));
