/* Katvan cloud bridge: the secret-answer question goes to Claude Code (the user's subscription, not the API),
   so it answers even when the home computer is off.
   Page -> POST /ask (text, X-Katvan-Key header) -> `claude -p` -> the answer as the response.
   Env: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), KATVAN_SECRET (the key the page sends). */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.KATVAN_SECRET || '';
const ORIGINS = ['https://yair681.github.io', 'null'];
const CLAUDE = path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
const RUN_MS = 100000;
const MAX_RUNNING = 2;
const PROMPT = 'ענה על השאלה בעברית, במשפט אחד בשורה אחת ובטקסט רגיל בלבד: בלי Markdown, בלי כוכביות, בלי ירידת שורה ובלי לחזור על השאלה. ' +
  'אם השאלה מבקשת תשובה ארוכה יותר (למשל "בהרחבה" או כמה סעיפים), ענה כמה שצריך, עדיין בשורה אחת.';

/* without these the service stays up and answers 503, so adding them in the dashboard is enough (no crash loop) */
const READY = !!(SECRET && process.env.CLAUDE_CODE_OAUTH_TOKEN);
if (!READY) console.error('missing KATVAN_SECRET or CLAUDE_CODE_OAUTH_TOKEN');

let running = 0;

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Katvan-Key');
  return !o || ORIGINS.includes(o);
}

function keyOk(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ask(q) {
  return new Promise((resolve) => {
    const p = spawn(CLAUDE, ['-p', '--tools', '', '--output-format', 'text', '--system-prompt', PROMPT], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), RUN_MS);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => { clearTimeout(timer); console.error('spawn', e.message); resolve(''); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) console.error('claude exit', code, err.slice(0, 300));
      resolve(code === 0 ? out.trim() : '');
    });
    p.stdin.end(q);
  });
}

http.createServer((req, res) => {
  const ok = cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403); return res.end(); }
  if (!ok) { res.writeHead(403); return res.end(); }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ping')) { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'POST' || req.url !== '/ask') { res.writeHead(404); return res.end(); }
  if (!READY) { res.writeHead(503); return res.end(); }
  if (!keyOk(req.headers['x-katvan-key'])) { res.writeHead(401); return res.end(); }
  if (running >= MAX_RUNNING) { res.writeHead(429); return res.end(); }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', async () => {
    const q = body.trim();
    if (!q) { res.writeHead(400); return res.end(); }
    running++;
    const started = Date.now();
    const a = await ask(q).finally(() => { running--; });
    console.log(new Date().toISOString(), a ? 'ok' : 'fail', (Date.now() - started) + 'ms');
    if (!a) { res.writeHead(502); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(a);
  });
}).listen(PORT, () => console.log('katvan-claude on port ' + PORT));
