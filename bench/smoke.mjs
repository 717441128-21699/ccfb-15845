// 应用四页面冒烟测试: 自托管 dist/ 静态构建, 通过 CDP 加载每个 hash 路由,
// 收集控制台错误并验证关键 DOM。无外部服务器依赖。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('未找到 dist/, 请先运行 npm run build');
  process.exit(1);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/' || !extname(url)) url = '/index.html';
  const file = join(dist, url.replace(/^\//, ''));
  if (!existsSync(file)) { res.statusCode = 404; res.end('nf'); return; }
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const outDir = join(root, 'bench', '.headless');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const profileDir = join(process.env.TEMP || outDir, 'ice-halo-smoke-profile');
rmSync(profileDir, { recursive: true, force: true });

const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const proc = spawn(chrome, [
  '--headless=new', '--disable-gpu-sandbox', '--no-sandbox',
  '--enable-unsafe-webgpu', '--use-angle=d3d11',
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-port=9231', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let procErr = '';
proc.stderr.on('data', (d) => { procErr += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 40; i++) {
  try { version = await (await fetch(`http://localhost:9231/json/version`)).json(); break; } catch { await sleep(250); }
}
if (!version) { console.error('CDP 未就绪:', procErr.slice(-800)); proc.kill(); server.close(); process.exit(1); }

const targets = await (await fetch('http://localhost:9231/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');

const routes = ['#/sim', '#/params', '#/compare', '#/catalog'];
const results = [];
for (const route of routes) {
  consoleErrors.length = 0;
  await send('Page.navigate', { url: `http://localhost:${port}/${route}` });
  await sleep(3000);
  const evalRes = await send('Runtime.evaluate', {
    expression: `({ h2: document.querySelectorAll('h2').length, h3: document.querySelectorAll('h3').length, cards: document.querySelectorAll('.halo-card,.preset,.pop-row').length, canvas: !!document.querySelector('canvas'), app: !!document.getElementById('app'), body: document.body.innerText.slice(0,100) })`,
    returnByValue: true,
  });
  results.push({ route, ...evalRes.result.result.value, errors: [...consoleErrors] });
}
ws.close(); proc.kill(); server.close();

let failed = 0;
for (const r of results) {
  const hasContent = r.h2 > 0 || r.h3 > 0 || r.cards > 0;
  const ok = hasContent && r.app && r.errors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.route} h2=${r.h2} h3=${r.h3} cards=${r.cards} canvas=${r.canvas} errors=${JSON.stringify(r.errors)}`);
}
process.exit(failed ? 1 : 0);
