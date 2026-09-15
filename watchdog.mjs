import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sendNotification, destinationId } from './lib/notifications.mjs';

export class Watchdog {
  constructor({ url, token, directory, channels, interval = 30000, timeout = 5000, failures = 3, recovery = 2, repeat = 1800000, fetchImpl = fetch, sender = sendNotification }) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error('WATCHDOG_URL must be an HTTP(S) /healthz URL without credentials.');
    if (!token || token.length < 24) throw Error('Set WATCHDOG_TOKEN to the Pulsewatch health key.');
    if (!channels?.length) throw Error('Configure Telegram or webhook on the independent observer.');
    this.url = u.href; this.token = token; this.channels = channels.map(c => ({ ...c, destination: destinationId([c.channel, c.url, c.chat_id, c.token]) }));
    this.interval = interval; this.timeout = timeout; this.failures = failures; this.recovery = recovery; this.repeat = repeat; this.fetchImpl = fetchImpl; this.sender = sender;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.file = path.join(directory, 'watchdog-state.json');
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('Cannot read watchdog state; restore its valid backup.'); this.state = { status: 'unknown', failures: 0, successes: 0, last_check: 0, down_since: null, last_notice: 0, queue: [], failed_deliveries: 0 }; }
    this.targetId = destinationId([this.url, this.token]);
    if (this.state.target_id && this.state.target_id !== this.targetId) this.state = { status: 'unknown', failures: 0, successes: 0, last_check: 0, down_since: null, last_notice: 0, queue: [], failed_deliveries: this.state.failed_deliveries || 0 };
    this.state.target_id = this.targetId; this.running = false; this.active = null;
  }
  persist() { const temp = `${this.file}.tmp`; writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(temp, this.file); }
  enqueue(type, now, message) {
    const event = { event_id: randomUUID(), incident_id: String(this.state.down_since ?? now), event: type, monitor: { id: 'pulsewatch-service', name: 'Служба Pulsewatch', environment: 'prod' }, message, started_at: new Date(this.state.down_since ?? now).toISOString(), timestamp: new Date(now).toISOString(), duration_seconds: Math.floor((now - (this.state.down_since ?? now)) / 1000) };
    for (const c of this.channels) this.state.queue.push({ event, channel: c.channel, destination: c.destination, attempts: 0, next_try: 0 });
    this.state.last_notice = now;
  }
  async check(now = Date.now()) {
    let healthy = false;
    try {
      const response = await this.fetchImpl(this.url, { headers: { Authorization: `Bearer ${this.token}`, 'X-Pulsewatch-Observer': 'watchdog', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
      const reader = response.body?.getReader(); let bytes = 0, chunks = [];
      if (!reader) throw Error('Empty body');
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16384) throw Error('Large response'); chunks.push(Buffer.from(part.value)); } } finally { await reader.cancel().catch(() => {}); }
      const result = JSON.parse(Buffer.concat(chunks));
      healthy = response.ok && result.service === 'pulsewatch' && result.ok === true && Number.isFinite(result.timestamp) && Number.isFinite(result.last_tick) && Math.abs(now - result.timestamp) < 60000 && result.timestamp >= result.last_tick && result.timestamp - result.last_tick < 15000;
    } catch { healthy = false; }
    if (now - this.state.last_check > Math.max(this.interval * 3, this.timeout + 30000)) { this.state.failures = 0; this.state.successes = 0; }
    this.state.last_check = now;
    this.state.failures = healthy ? 0 : this.state.failures + 1;
    this.state.successes = healthy ? this.state.successes + 1 : 0;
    if (!healthy && this.state.failures >= this.failures && this.state.status !== 'down') {
      this.state.status = 'down'; this.state.down_since = now;
      this.enqueue('down', now, 'Внешний наблюдатель не получает исправный /healthz. Мониторинг мог остановиться или потерять связь.');
    } else if (healthy && this.state.status === 'down' && this.state.successes >= this.recovery) {
      this.enqueue('recovered', now, 'Служба мониторинга снова отвечает и выполняет проверки.'); this.state.status = 'up'; this.state.down_since = null;
    } else if (healthy && this.state.status === 'unknown') this.state.status = 'up';
    if (this.state.status === 'down' && this.repeat > 0 && now - this.state.last_notice >= this.repeat) this.enqueue('reminder', now, 'Служба мониторинга всё ещё недоступна.');
    this.persist(); await this.deliver(now); return healthy;
  }
  async deliver(now = Date.now()) {
    const pending = [];
    const visited = new Set();
    for (const job of this.state.queue) {
      const c = this.channels.find(c => c.channel === job.channel && c.destination === job.destination);
      if (!c) continue;
      if (visited.has(job.channel) || job.next_try > now) { pending.push(job); visited.add(job.channel); continue; }
      visited.add(job.channel);
      try { await this.sender(c, job.event); } catch (e) {
        job.attempts++;
        if (job.attempts < 5) { job.next_try = now + Math.max(5000 * 2 ** job.attempts, (e.retryAfter || 0) * 1000); pending.push(job); }
        else { this.state.failed_deliveries++; console.error(`Watchdog: notification delivery failed (${job.channel}).`); }
      }
    }
    this.state.queue = pending; this.persist();
  }
  start() { this.running = true; const tick = () => { if (this.active || !this.running) return; this.active = this.check().catch(() => { console.error('Watchdog: cannot complete check or save state.'); }).finally(() => { this.active = null; }); }; tick(); this.timer = setInterval(tick, this.interval); }
  async stop() { this.running = false; clearInterval(this.timer); await this.active; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const channels = [];
    if (process.env.WATCHDOG_TELEGRAM_TOKEN && process.env.WATCHDOG_TELEGRAM_CHAT_ID) channels.push({ channel: 'telegram', token: process.env.WATCHDOG_TELEGRAM_TOKEN, chat_id: process.env.WATCHDOG_TELEGRAM_CHAT_ID });
    if (process.env.WATCHDOG_WEBHOOK_URL) channels.push({ channel: 'webhook', url: process.env.WATCHDOG_WEBHOOK_URL, token: process.env.WATCHDOG_WEBHOOK_TOKEN ?? '' });
    const watcher = new Watchdog({ url: process.env.WATCHDOG_URL, token: process.env.WATCHDOG_TOKEN, directory: process.env.WATCHDOG_DATA_DIR ?? './watchdog-data', channels });
    watcher.start(); console.log('Pulsewatch observer started. Run it on an independent machine.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await watcher.stop(); process.exit(0); });
  } catch (e) { console.error(e.message); process.exit(1); }
}
