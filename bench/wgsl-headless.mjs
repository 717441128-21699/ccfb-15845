// 通过 Chrome DevTools Protocol 驱动 headless Chrome 验证 WebGPU 计算着色器
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = join(root, 'bench', '.headless');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wgsl': 'text/plain', '.css': 'text/css',
};
const server = createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/bench/wgsl-test.html';
  const file = join(root, url.replace(/^\//, ''));
  if (!existsSync(file)) { res.statusCode = 404; res.end('nf'); return; }
  const ext = file.slice(file.lastIndexOf('.'));
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = join(outDir, 'profile');
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu-sandbox', '--no-sandbox',
  '--enable-unsafe-webgpu', '--use-angle=d3d11',
  `--user-data-dir=${profile}`,
  '--remote-debugging-port=9222',
  `http://localhost:${port}/bench/wgsl-test.html`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 40; i++) {
  try {
    version = await (await fetch('http://localhost:9222/json/version')).json();
    break;
  } catch { await sleep(250); }
}
if (!version) { console.error('CDP 未就绪'); proc.kill(); process.exit(1); }

const wsUrl = version.webSocketDebuggerUrl;
const ws = new WebSocket(wsUrl);
await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Target.setDiscoverTargets', { discover: true });
const targets = await (await fetch('http://localhost:9222/json')).json();
const pageTarget = targets.find((t) => t.type === 'page');
const targetWs = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((r, rej) => { targetWs.onopen = r; targetWs.onerror = rej; });
let tId = 0;
const tPending = new Map();
targetWs.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && tPending.has(msg.id)) { tPending.get(msg.id)(msg); tPending.delete(msg.id); }
};
const tsend = (method, params = {}) => new Promise((res) => {
  const id = ++tId;
  tPending.set(id, res);
  targetWs.send(JSON.stringify({ id, method, params }));
});
await tsend('Runtime.enable');

// 轮询页面全局结果(页面把结果挂到 window.__wgslResult)
let result = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const r = await tsend('Runtime.evaluate', { expression: 'window.__wgslResult ?? null', returnByValue: true });
  result = r.result?.result?.value ?? null;
  if (result) break;
}
targetWs.close();
ws.close();
proc.kill();
server.close();
writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2));

if (result && result.ok) {
  console.log('WGSL HEADLESS PASS:');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} else {
  console.error('WGSL HEADLESS FAIL:', JSON.stringify(result, null, 2));
  process.exit(1);
}
