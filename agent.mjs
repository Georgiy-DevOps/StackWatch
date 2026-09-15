import http from 'node:http';
import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const token = process.env.AGENT_TOKEN ?? '';
if (token.length < 24) { console.error('Set AGENT_TOKEN to a random string of at least 24 characters.'); process.exit(1); }
const host = process.env.AGENT_HOST ?? '127.0.0.1';
const port = Number(process.env.AGENT_PORT ?? 9109);
const diskPath = process.env.AGENT_DISK_PATH ?? path.parse(process.cwd()).root;
const digest = v => createHash('sha256').update(v).digest();
const counters = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
let previous = counters(), metrics = null, sampleError = false;
function sample() {
  try {
    const next = counters();
    const total = next.total - previous.total;
    const cpu = total > 0 ? 100 * (1 - (next.idle - previous.idle) / total) : 0;
    previous = next;
    let available = os.freemem();
    if (process.platform === 'linux') {
      const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB/m);
      if (match) available = Number(match[1]) * 1024;
    }
    const disk = statfsSync(diskPath);
    if (disk.blocks <= 0) throw Error('Invalid filesystem size');
    const round = n => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
    metrics = { cpu: round(cpu), ram: round(100 * (1 - available / os.totalmem())), disk: round(100 * (1 - disk.bavail / disk.blocks)), hostname: os.hostname(), platform: process.platform, uptime_seconds: Math.floor(os.uptime()), disk_path: diskPath, sampled_at: new Date().toISOString() };
    sampleError = false;
  } catch { sampleError = true; }
}
const timer = setInterval(sample, 2000);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  if (!timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${token}`))) { res.writeHead(401); res.end('{"error":"Unauthorized"}'); return; }
  if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404); res.end('{"error":"Not found"}'); return; }
  if (!metrics || sampleError || Date.now() - Date.parse(metrics.sampled_at) > 10000) { res.writeHead(503); res.end('{"error":"Metrics unavailable"}'); return; }
  res.end(JSON.stringify(metrics));
});
server.requestTimeout = 5000; server.headersTimeout = 5000;
server.listen(port, host, () => console.log(`Pulsewatch agent listening on ${host}:${port}; disk: ${diskPath}`));
server.on('error', e => { console.error(e.message); clearInterval(timer); process.exit(1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { clearInterval(timer); server.close(() => process.exit(0)); });
