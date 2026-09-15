import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { probe, validateMonitor } from '../lib/probe.mjs';
import { createApp } from '../server.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await wait(30); } throw Error('Timed out'); }
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { await new Promise(r => { server.close(r); server.closeAllConnections?.(); }); }
const config = extra => validateMonitor({ name: 'prod-api', target: 'http://127.0.0.1:1/health', recovery_threshold: 1, warning_after_seconds: 0, ...extra });
const result = (healthy, status = healthy ? 'up' : 'down') => ({ healthy, status, latency: 20, detail: healthy ? 'OK' : 'Connection refused', metrics: null, tls_days: null });

test('HTTP status, redirects, strict deadline, TCP reachability and agent thresholds', async t => {
  const fixture = http.createServer((req, res) => {
    if (req.url === '/health') return res.end('ok');
    if (req.url === '/failure') { res.writeHead(503); return res.end('no'); }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/health' }); return res.end(); }
    if (req.url === '/slow') return;
    if (req.url === '/agent') { if (req.headers.authorization !== 'Bearer test-agent-token') { res.writeHead(401); return res.end(); } return res.end(JSON.stringify({ cpu: 24, ram: 45, disk: 95 })); }
    if (req.url === '/bad-agent') return res.end(JSON.stringify({ cpu: null, ram: 20, disk: 30 }));
    if (req.url === '/partial-agent') { res.writeHead(200); res.write('{'); return; }
    if (req.url === '/large-agent') return res.end('x'.repeat(70000));
  });
  const url = await listen(fixture); t.after(() => close(fixture));
  assert.equal((await probe(config({ target: `${url}/health` }))).status, 'up');
  assert.equal((await probe(config({ target: `${url}/failure` }))).healthy, false);
  assert.equal((await probe(config({ target: `${url}/failure`, expected_status: 503 }))).healthy, true);
  assert.equal((await probe(config({ target: `${url}/redirect` }))).healthy, false);
  const start = Date.now();
  assert.equal((await probe(config({ target: `${url}/slow`, timeout_ms: 500 }))).healthy, false);
  assert.ok(Date.now() - start < 1300, 'wall-clock timeout bounded');
  const agent = config({ kind: 'agent', target: `${url}/agent`, agent_token: 'test-agent-token' });
  const metrics = await probe(agent);
  assert.equal(metrics.status, 'degraded'); assert.equal(metrics.metrics.disk, 95);
  assert.equal((await probe({ ...agent, target: `${url}/bad-agent` })).healthy, false);
  assert.equal((await probe({ ...agent, target: `${url}/partial-agent`, timeout_ms: 500 })).healthy, false);
  assert.equal((await probe({ ...agent, target: `${url}/large-agent` })).healthy, false);
  assert.equal((await probe(config({ kind: 'tcp', target: '127.0.0.1', port: fixture.address().port }))).healthy, true);
});

test('failure confirmation, incident deduplication, recovery, restart persistence and no token exposure', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pulsewatch-test-'));
  let store = new Store(path.join(dir, 'test.sqlite'));
  try {
    const id = store.add(config({ kind: 'agent', agent_token: 'private-agent-secret' }));
    const m = store.get(id); const now = Date.now();
    store.record(m, result(true), now - 5000, true);
    store.record(m, result(false), now - 4000, true);
    assert.equal(store.state(id).status, 'pending'); assert.equal(store.snapshot().incidents.length, 0);
    store.record(m, result(false), now - 3000, true);
    assert.equal(store.state(id).status, 'down'); assert.equal(store.snapshot().incidents.length, 1);
    store.record(m, result(false), now - 2000, true);
    assert.equal(store.snapshot().incidents.length, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1);
    store.acknowledge(store.snapshot().incidents[0].id);
    assert.equal(store.snapshot().incidents[0].acknowledged, 1);
    store.record(m, result(true), now - 1000, true);
    assert.equal(store.state(id).status, 'up'); assert.equal(store.snapshot().incidents[0].closure, 'recovered');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 2);
    assert.equal(store.snapshot().monitors[0].uptime, 40);
    assert.ok(!JSON.stringify(store.snapshot()).includes('private-agent-secret'));
    store.close(); store = new Store(path.join(dir, 'test.sqlite'));
    assert.equal(store.history(id).length, 5); assert.equal(store.snapshot().incidents.length, 1);
    assert.equal(store.state(id).next_check, 0);
    assert.equal(store.snapshot(now + 100000).monitors[0].status, 'stale');
    store.update(id, { ...config(), enabled: false });
    store.record(m, result(false)); // in-flight result from an older revision must be ignored
    assert.equal(store.snapshot().monitors[0].status, 'paused'); assert.equal(store.history(id).length, 5);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('agent warning incident escalation and pause never reports a false recovery', () => {
  const store = new Store(':memory:');
  try {
    const id = store.add(config({ failure_threshold: 1 })), m = store.get(id);
    store.record(m, result(true, 'degraded'), Date.now(), true);
    store.record(m, result(false), Date.now(), true);
    assert.equal(store.snapshot().incidents.length, 1);
    assert.equal(store.snapshot().incidents[0].severity, 'down');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 2);
    store.update(id, { ...config(), enabled: false });
    assert.equal(store.snapshot().incidents[0].closure, 'paused');
  } finally { store.close(); }
});

test('API authentication, CSRF, Host validation, input validation and persistent CRUD', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pulsewatch-api-'));
  const key = 'test-access-key-very-long';
  const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, accessKey: key, startEngine: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (route, options = {}) => fetch(`${app.origin}${route}`, options);
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/api/snapshot')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })).status, 403);
  const login = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin }, body: JSON.stringify({ key }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: app.origin };
  assert.equal((await call('/api/snapshot', { headers })).status, 200);
  const invalidHost = await new Promise((resolve, reject) => {
    const req = http.get(`${app.origin}/api/snapshot`, { headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const bad = await call('/api/monitors', { method: 'POST', headers, body: JSON.stringify({ name: 'bad', target: 'file:///secret' }) });
  assert.equal(bad.status, 400);
  assert.equal((await call('/api/monitors', { method: 'POST', headers, body: JSON.stringify({ name: 'bad', kind: 'tcp', target: 'host;command', port: 22 }) })).status, 400);
  const created = await call('/api/monitors', { method: 'POST', headers, body: JSON.stringify({ name: '<img src=x onerror=alert(1)>', kind: 'agent', target: 'https://example.com/health', agent_token: 'test-secret-token' }) });
  assert.equal(created.status, 201); const { id } = await created.json();
  const snapshot = await (await call('/api/snapshot', { headers })).json();
  assert.equal(snapshot.monitors.length, 1); assert.ok(!JSON.stringify(snapshot).includes('test-secret-token'));
  assert.equal((await call(`/api/monitors/${id}`, { method: 'PUT', headers, body: JSON.stringify({ name: 'renamed', enabled: false }) })).status, 200);
  assert.equal(app.store.get(id).agent_token, 'test-secret-token');
  assert.equal(app.store.get(id).name, 'renamed');
  assert.equal((await call(`/api/monitors/${id}`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await call(`/api/monitors/${id}/history`, { headers })).status, 404);
  assert.equal((await call('/api/monitors', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
});

test('scheduler works without a browser; webhook delivery retries once per event', async t => {
  let checks = 0, status = 503, hookCalls = 0; const events = [];
  const fixture = http.createServer((req, res) => { checks++; res.writeHead(status); res.end(); });
  const url = await listen(fixture);
  const hook = http.createServer(async (req, res) => { hookCalls++; const chunks = []; for await (const c of req) chunks.push(c); events.push(JSON.parse(Buffer.concat(chunks))); res.writeHead(hookCalls === 1 ? 500 : 200); res.end(); });
  const hookUrl = await listen(hook);
  const store = new Store(':memory:');
  const id = store.add(config({ target: url, failure_threshold: 1 }));
  const engine = new Engine(store, { webhook: hookUrl });
  t.after(async () => { await engine.stop(); store.close(); await close(fixture); await close(hook); });
  engine.start();
  await until(() => store.state(id).status === 'down');
  assert.equal(checks, 1); assert.equal(store.snapshot().incidents.length, 1);
  await until(() => hookCalls === 1 && !engine.notifying);
  store.db.exec('UPDATE outbox SET next_try=0');
  await engine.deliver();
  assert.equal(hookCalls, 2); assert.equal(events[0].event_id, events[1].event_id);
  assert.equal(store.snapshot().pending_alerts, 0);
  status = 200;
  store.db.prepare('UPDATE states SET next_check=0 WHERE monitor_id=?').run(id);
  engine.tick();
  await until(() => store.state(id).status === 'up');
  assert.equal(store.snapshot().incidents[0].closure, 'recovered');
  await until(() => !engine.notifying); await engine.deliver();
  assert.equal(events.at(-1).event, 'recovered');
});

test('real cross-platform agent returns authenticated CPU, RAM and disk samples', async t => {
  // Reserve a local port only for this fixture, then hand it to the child.
  const reserve = net.createServer(); await listen(reserve); const port = reserve.address().port; await close(reserve);
  const child = spawn(process.execPath, ['agent.mjs'], { cwd: path.dirname(fileURLToPath(new URL('../agent.mjs', import.meta.url))), env: { ...process.env, AGENT_TOKEN: 'test-agent-token-with-24-characters', AGENT_PORT: String(port), AGENT_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { child.kill(); await new Promise(r => child.exitCode === null ? child.once('exit', r) : r()); });
  const url = `http://127.0.0.1:${port}/health`;
  await until(async () => { try { return (await fetch(url)).status === 401; } catch { return false; } });
  let metrics;
  await until(async () => { const res = await fetch(url, { headers: { Authorization: 'Bearer test-agent-token-with-24-characters' } }); if (!res.ok) return false; metrics = await res.json(); return true; });
  for (const key of ['cpu', 'ram', 'disk']) assert.ok(metrics[key] >= 0 && metrics[key] <= 100, key);
  assert.equal(metrics.platform, process.platform);
});
