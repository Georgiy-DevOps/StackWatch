import { probe } from './probe.mjs';
import { destinationId, sendNotification } from './notifications.mjs';

export class Engine {
  constructor(store, { webhook = '', webhookToken = '', retentionDays = 7, concurrency = 8, notifications = null, sender = sendNotification, backups = null } = {}) {
    this.store = store; this.webhook = webhook; this.webhookToken = webhookToken;
    this.retentionDays = retentionDays; this.concurrency = concurrency;
    this.active = new Map(); this.running = false; this.lastTick = null; this.prunedAt = 0; this.notifying = false;
    this.notifications = notifications; this.sender = sender; this.backups = backups; this.lastError = null;
  }
  channels(m = null) {
    const channels = [];
    if (this.webhook) channels.push({ channel: 'webhook', destination: destinationId([this.webhook, this.webhookToken]), url: this.webhook, token: this.webhookToken });
    const tg = this.notifications?.get();
    if (tg?.enabled && (!m || !tg.only_prod || m.environment === 'prod')) channels.push({ channel: 'telegram', destination: destinationId([tg.chat_id, tg.token]), token: tg.token, chat_id: tg.chat_id });
    return channels;
  }
  start() { this.running = true; this.tick(); this.timer = setInterval(() => this.tick(), 1000); }
  tick() {
    if (!this.running) return;
    this.lastTick = Date.now();
    try {
      if (this.lastTick - this.prunedAt > 3600000) { this.store.prune(this.retentionDays); this.prunedAt = this.lastTick; }
      this.store.syncMaintenance(this.lastTick);
      this.store.remind(this.lastTick, m => this.channels(m));
      for (const m of this.store.all().filter(m => m.enabled).sort((a, b) => this.store.state(a.id).next_check - this.store.state(b.id).next_check)) {
        if (this.active.size >= this.concurrency) break;
        if (!this.active.has(m.id) && this.store.state(m.id).next_check <= this.lastTick) this.run(m);
      }
      if (this.channels().length && !this.notifying) this.deliver().catch(() => { this.lastError = 'Ошибка очереди уведомлений'; });
      this.backups?.tick(this.lastTick);
      this.lastError = null;
    } catch { this.lastError = 'Ошибка службы мониторинга'; console.error(this.lastError); }
  }
  run(m) {
    if (this.active.has(m.id) || this.active.size >= this.concurrency) return false;
    const task = probe(m).then(result => this.store.record(m, result, Date.now(), this.channels(m))).catch(() => { this.lastError = 'Не удалось сохранить проверку'; console.error(this.lastError); }).finally(() => this.active.delete(m.id));
    this.active.set(m.id, task);
    return true;
  }
  request(id) {
    const m = this.store.get(id), state = this.store.state(id);
    if (!m?.enabled || this.active.has(id) || (state.last_checked && Date.now() - state.last_checked < 5000)) return false;
    this.store.db.prepare('UPDATE states SET next_check=0 WHERE monitor_id=?').run(id);
    this.tick();
    return true;
  }
  async deliver() {
    if (this.notifying) return;
    this.notifying = true;
    try {
      // Each channel retains its own ordering; a failed webhook never blocks Telegram.
      await Promise.all(this.channels().map(async channel => {
        const row = this.store.db.prepare('SELECT * FROM outbox WHERE channel=? AND sent_at IS NULL AND cancelled_at IS NULL AND attempts<5 ORDER BY rowid LIMIT 1').get(channel.channel);
        if (!row || row.next_try > Date.now()) return;
        if (row.destination && row.destination !== channel.destination) { this.store.db.prepare("UPDATE outbox SET cancelled_at=?,error='Получатель изменён' WHERE id=?").run(Date.now(), row.id); return; }
        const event = JSON.parse(row.payload), monitor = this.store.get(event.monitor.id);
        if (event.event !== 'test' && monitor && !this.channels(monitor).some(c => c.channel === channel.channel)) { this.store.db.prepare("UPDATE outbox SET cancelled_at=?,error='Исключено фильтром канала' WHERE id=?").run(Date.now(), row.id); return; }
        try {
          await this.sender(channel, event);
          this.store.db.prepare('UPDATE outbox SET sent_at=?,attempts=attempts+1,error=NULL WHERE id=?').run(Date.now(), row.id);
        } catch (e) {
          const retry = Math.max(5000 * 2 ** row.attempts, (e.retryAfter || 0) * 1000);
          this.store.db.prepare('UPDATE outbox SET attempts=attempts+1,next_try=?,error=? WHERE id=?').run(Date.now() + retry, 'Не удалось доставить уведомление. Проверьте канал и доступ к сети.', row.id);
        }
      }));
    } finally { this.notifying = false; }
  }
  async stop() { this.running = false; clearInterval(this.timer); await Promise.allSettled([...this.active.values()]); while (this.notifying) await new Promise(r => setTimeout(r, 20)); if (this.backups?.active) await this.backups.active.catch(() => {}); }
}
