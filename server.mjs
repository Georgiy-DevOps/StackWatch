import http from 'node:http';
import { createHash, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './lib/store.mjs';
import { Engine } from './lib/engine.mjs';
import { InputError, validateMonitor } from './lib/probe.mjs';
import { NotificationSettings } from './lib/notifications.mjs';
import { Backups } from './lib/backups.mjs';
import { inMaintenance } from './lib/maintenance.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = text => createHash('sha256').update(text).digest();
const equal = (a, b) => timingSafeEqual(hash(a), hash(b));
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Требуется application/json.', 415);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 16384) throw new InputError('Слишком большой запрос.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Некорректный JSON.'); }
}

export async function createApp(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 4310);
  const accessKey = options.accessKey ?? process.env.ACCESS_KEY ?? '';
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  const isLocal = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT must be an integer from 0 to 65535.');
  if (!isLocal && (accessKey.length < 16 || !publicOrigin)) throw Error('For a network listener, set ACCESS_KEY (16+ characters) and PUBLIC_ORIGIN.');
  if (accessKey && accessKey.length < 16) throw Error('ACCESS_KEY must contain at least 16 characters.');
  if (publicOrigin) { const u = new URL(publicOrigin); if (!['http:', 'https:'].includes(u.protocol) || u.origin !== publicOrigin) throw Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash.'); }
  const webhook = options.webhook ?? process.env.ALERT_WEBHOOK_URL ?? '';
  if (webhook) { const u = new URL(webhook); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('ALERT_WEBHOOK_URL must be an HTTP(S) URL without embedded credentials.'); }
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = path.join(dataDir, 'pulsewatch.sqlite');
  const store = new Store(database);
  try { chmodSync(database, 0o600); } catch { /* Windows ACLs govern access. */ }
  const retentionDays = Math.max(1, Math.min(90, Number(process.env.RETENTION_DAYS) || 7));
  const notifications = new NotificationSettings(store, dataDir, { token: options.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN, chat_id: options.telegramChatId ?? process.env.TELEGRAM_CHAT_ID });
  let healthToken = options.healthToken ?? process.env.HEALTH_TOKEN ?? '';
  if (!healthToken) {
    try { healthToken = readFileSync(path.join(dataDir, 'health.key'), 'utf8').trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; healthToken = randomBytes(32).toString('hex'); writeFileSync(path.join(dataDir, 'health.key'), healthToken, { flag: 'wx', mode: 0o600 }); }
  }
  if (healthToken.length < 24) throw Error('HEALTH_TOKEN must contain at least 24 characters.');
  const webhookToken = options.webhookToken ?? process.env.ALERT_WEBHOOK_TOKEN ?? '';
  const backups = new Backups(store, dataDir, { directory: options.backupDir ?? process.env.BACKUP_DIR, hours: Math.max(1, Math.min(168, Number(process.env.BACKUP_HOURS) || 24)), keep: Math.max(1, Math.min(30, Number(process.env.BACKUP_KEEP) || 7)), runtimeConfig: { HOST: host, PORT: port, PUBLIC_ORIGIN: publicOrigin, ACCESS_KEY: accessKey, HEALTH_TOKEN: healthToken, ALERT_WEBHOOK_URL: webhook, ALERT_WEBHOOK_TOKEN: webhookToken, RETENTION_DAYS: retentionDays } });
  const engine = new Engine(store, { webhook, webhookToken, retentionDays, notifications, backups: options.autoBackup === false ? null : backups, sender: options.notificationSender });
  const startedAt = Date.now();
  let origin;
  const failures = new Map();
  // TRUST_PROXY=1 только за своим обратным прокси (Caddy из compose.production.yaml):
  // иначе все клиенты видны с одного IP прокси, и чужие ошибки входа блокируют администратора.
  const trustProxy = ['1', 'true'].includes(String(options.trustProxy ?? process.env.TRUST_PROXY ?? '').toLowerCase());
  const clientIp = req => {
    // Caddy перезаписывает X-Forwarded-For адресом реального клиента; берём последний элемент,
    // который добавил наш прокси, а не подставленный клиентом первый.
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map(v => v.trim()).filter(Boolean).at(-1) : '';
    return forwarded && forwarded.length <= 64 ? forwarded : req.socket.remoteAddress;
  };
  // Сессии хранятся на сервере: выход и перезапуск действительно отзывают cookie.
  // В памяти лежит только SHA-256 токена, сам токен знает лишь браузер.
  const sessionTtl = 43200000, maxSessions = 1000;
  const sessions = new Map();
  const sessionCookie = req => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('pw_session='))?.slice(11) ?? '';
  const sessionId = token => createHash('sha256').update(token).digest('hex');
  const loggedIn = req => {
    if (!accessKey) return true;
    const token = sessionCookie(req);
    if (!/^[a-f\d]{64}$/.test(token)) return false;
    const id = sessionId(token), expires = sessions.get(id);
    if (!expires) return false;
    if (expires <= Date.now()) { sessions.delete(id); return false; }
    return true;
  };
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
    ['/upgrade.js', ['upgrade.js', 'text/javascript; charset=utf-8']], ['/upgrade.css', ['upgrade.css', 'text/css; charset=utf-8']], ['/guide.html', ['guide.html', 'text/html; charset=utf-8']]
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Only the configured hostname is accepted: protects local control APIs from DNS rebinding.
      if (req.headers.host !== new URL(origin).host) throw new InputError('Недопустимый Host.', 403);
      const url = new URL(req.url, origin);
      const method = req.method;
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== origin) throw new InputError('Запрос разрешён только из этой панели.', 403);
      if (url.pathname === '/healthz' && method === 'GET') {
        if (!equal(req.headers.authorization ?? '', `Bearer ${healthToken}`)) throw new InputError('Требуется ключ наблюдателя.', 401);
        const now = Date.now();
        const overdue = store.all().filter(m => m.enabled && !inMaintenance(m, now) && now - (store.state(m.id).last_checked ?? m.created_at) > Math.max(120000, m.interval_seconds * 4000 + m.timeout_ms)).length;
        const ok = engine.running && now - (engine.lastTick ?? 0) < 15000 && !engine.lastError && overdue === 0;
        if (req.headers['x-pulsewatch-observer'] === 'watchdog') store.setSetting('watchdog_last_seen', now);
        return json(res, ok ? 200 : 503, { service: 'pulsewatch', version: '2.0.0', ok, timestamp: now, last_tick: engine.lastTick, overdue });
      }
      if (url.pathname === '/api/session' && method === 'GET') return json(res, 200, { required: Boolean(accessKey), logged_in: loggedIn(req) });
      if (url.pathname === '/api/login' && method === 'POST') {
        const ip = clientIp(req);
        const now = Date.now();
        for (const [key, v] of failures) if (now - v.since > 60000) failures.delete(key);
        // Вместо глобальной блокировки при переполнении вытесняем самые старые записи.
        while (failures.size >= 1000) failures.delete(failures.keys().next().value);
        const attempt = failures.get(ip) ?? { since: now, count: 0 };
        if (attempt.count >= 5) throw new InputError('Слишком много попыток. Повторите через минуту.', 429);
        const b = await body(req);
        if (typeof b?.key !== 'string' || !equal(b.key, accessKey)) { attempt.count++; failures.set(ip, attempt); throw new InputError('Неверный ключ доступа.', 401); }
        failures.delete(ip);
        for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
        while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('hex');
        sessions.set(sessionId(token), now + sessionTtl);
        res.setHeader('Set-Cookie', `pw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionTtl / 1000}${origin.startsWith('https:') ? '; Secure' : ''}`);
        return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!loggedIn(req)) throw new InputError('Введите ключ доступа.', 401);
        if (url.pathname === '/api/logout' && method === 'POST') { sessions.delete(sessionId(sessionCookie(req))); res.setHeader('Set-Cookie', 'pw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return json(res, 200, { ok: true }); }
        if (url.pathname === '/api/snapshot' && method === 'GET') return json(res, 200, { ...store.snapshot(), engine: { started_at: startedAt, last_tick: engine.lastTick, active: engine.active.size, running: engine.running, error: engine.lastError }, settings: { version: '2.0.0', webhook_configured: Boolean(webhook), telegram: notifications.public(), retention_days: retentionDays, auth_enabled: Boolean(accessKey), origin, secure: origin.startsWith('https:'), backup: backups.status(), watchdog: { endpoint: `${origin}/healthz`, last_seen: store.setting('watchdog_last_seen') } } });
        if (url.pathname === '/api/notifications' && method === 'PUT') return json(res, 200, notifications.save(await body(req)));
        if (url.pathname === '/api/notifications/deliveries' && method === 'GET') return json(res, 200, store.deliveries());
        if (url.pathname === '/api/notifications/test' && method === 'POST') {
          const channel = engine.channels().find(c => c.channel === 'telegram');
          if (!channel) throw new InputError('Сначала сохраните и включите Telegram.');
          const last = store.setting('last_telegram_test', 0);
          if (Date.now() - last < 10000) throw new InputError('Повторная отправка доступна через 10 секунд.', 429);
          const now = Date.now(); store.setSetting('last_telegram_test', now);
          store.enqueue({ id: 'test', name: 'StackWatch', environment: 'prod' }, { id: randomUUID(), type: 'test', started_at: now }, 'Telegram подключён. Сюда будут приходить уведомления.', now, [channel]);
          return json(res, 202, { queued: true });
        }
        const retry = url.pathname.match(/^\/api\/notifications\/([a-f\d-]+)\/retry$/);
        if (retry && method === 'POST') {
          const updated = store.db.prepare('UPDATE outbox SET attempts=0,next_try=0,error=NULL WHERE id=? AND sent_at IS NULL AND cancelled_at IS NULL AND attempts>=5').run(retry[1]);
          if (!updated.changes) throw new InputError('Нет неудачной доставки для повторения.', 404);
          return json(res, 202, { queued: true });
        }
        if (url.pathname === '/api/backups' && method === 'POST') {
          if (Date.now() - (backups.status().last_attempt ?? 0) < 30000 && !backups.active) throw new InputError('Повторная копия доступна через 30 секунд.', 429);
          return json(res, 200, await backups.create());
        }
        if (url.pathname === '/api/watchdog/key' && method === 'GET') return json(res, 200, { token: healthToken });
        if (url.pathname === '/api/monitors' && method === 'POST') { const id = store.add(validateMonitor(await body(req))); engine.tick(); return json(res, 201, { id }); }
        if (url.pathname === '/api/check' && method === 'POST') { let count = 0; for (const m of store.all()) if (engine.request(m.id)) count++; return json(res, 202, { queued: count }); }
        const match = url.pathname.match(/^\/api\/monitors\/([a-f\d-]+)(?:\/(history|check|detail))?$/);
        if (match) {
          const [, id, action] = match;
          const m = store.get(id);
          if (!m) throw new InputError('Сервер не найден.', 404);
          if (method === 'GET' && action === 'history') return json(res, 200, store.history(id));
          if (method === 'GET' && action === 'detail') return json(res, 200, { now: Date.now(), monitor: store.snapshot().monitors.find(m => m.id === id), checks: store.history(id), series: store.series(id, url.searchParams.get('range') ?? '24h'), retention_days: retentionDays });
          if (method === 'POST' && action === 'check') return json(res, 202, { queued: engine.request(id) });
          if (method === 'PUT' && !action) { store.update(id, validateMonitor(await body(req), m)); engine.tick(); return json(res, 200, { ok: true }); }
          if (method === 'DELETE' && !action) { store.remove(id); return json(res, 200, { ok: true }); }
        }
        const ack = url.pathname.match(/^\/api\/incidents\/([a-f\d-]+)\/ack$/);
        if (ack && method === 'POST') { store.acknowledge(ack[1]); return json(res, 200, { ok: true }); }
        throw new InputError('Не найдено.', 404);
      }
      const asset = assets.get(url.pathname);
      if (!asset || !['GET', 'HEAD'].includes(method)) throw new InputError('Не найдено.', 404);
      const content = readFileSync(path.join(root, 'public', asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
      res.end(method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера.' });
      else res.end();
      if (!e.status) console.error('Request error:', e.message);
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  origin = publicOrigin || `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  if (options.startEngine !== false) engine.start();
  return { origin, store, engine, server, notifications, backups, async close() { await engine.stop(); if (backups.active) await backups.active.catch(() => {}); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const app = await createApp();
    console.log(`StackWatch running at ${app.origin}`);
    console.log('Keep this process running for continuous checks. Ctrl+C to stop.');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
  } catch (e) { console.error(e.message); process.exit(1); }
}
