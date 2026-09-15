import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { InputError } from './probe.mjs';

export const destinationId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class NotificationSettings {
  constructor(store, dataDir, defaults = {}) {
    this.store = store;
    this.keyPath = path.join(dataDir, 'secrets.key');
    try { this.key = readFileSync(this.keyPath); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (store.setting('notifications')?.token_cipher) throw Error('secrets.key is missing. Restore it from the matching backup.');
      this.key = randomBytes(32); writeFileSync(this.keyPath, this.key, { flag: 'wx', mode: 0o600 });
    }
    if (this.key.length !== 32) throw Error('Invalid secrets.key');
    if (!store.setting('notifications')) this.save({ enabled: Boolean(defaults.token && defaults.chat_id), token: defaults.token ?? '', chat_id: defaults.chat_id ?? '', only_prod: false });
    this.get(); // Fail early if an existing encrypted token cannot be read with this key.
  }
  seal(text) {
    if (!text) return '';
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  unseal(text) {
    if (!text) return '';
    const b = Buffer.from(text, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
  }
  get() { const s = this.store.setting('notifications', {}); return { enabled: Boolean(s.enabled), chat_id: s.chat_id ?? '', token: this.unseal(s.token_cipher), only_prod: Boolean(s.only_prod) }; }
  public() { const { token, ...s } = this.get(); return { ...s, token_configured: Boolean(token) }; }
  save(input) {
    const old = this.get();
    const next = { enabled: input.enabled ?? old.enabled, only_prod: input.only_prod ?? old.only_prod, chat_id: String(input.chat_id ?? old.chat_id).trim(), token: input.clear_token === true ? '' : input.token || old.token };
    if (typeof next.enabled !== 'boolean' || typeof next.only_prod !== 'boolean' || typeof next.token !== 'string') throw new InputError('Некорректные настройки Telegram.');
    if (next.token && !/^\d+:[A-Za-z0-9_-]{10,}$/.test(next.token)) throw new InputError('Проверьте формат токена бота Telegram.');
    if (next.chat_id && !/^(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(next.chat_id)) throw new InputError('Chat ID: число либо @имя_канала.');
    if (next.enabled && (!next.token || !next.chat_id)) throw new InputError('Для Telegram нужны токен бота и Chat ID.');
    this.store.transaction(() => {
      this.store.setSetting('notifications', { enabled: next.enabled, only_prod: next.only_prod, chat_id: next.chat_id, token_cipher: this.seal(next.token) });
      if (!next.enabled || old.chat_id !== next.chat_id || old.token !== next.token) this.store.db.prepare("UPDATE outbox SET cancelled_at=?,error='Настройки канала изменены' WHERE channel='telegram' AND sent_at IS NULL AND cancelled_at IS NULL").run(Date.now());
    });
    return this.public();
  }
}

export function telegramText(event) {
  const title = { down: '🔴 Сервер недоступен', degraded: '🟠 Предупреждение', recovered: '🟢 Восстановление', reminder: '⏰ Инцидент ещё открыт', test: '🔔 Проверка уведомлений' }[event.event] ?? 'Pulsewatch';
  const secs = Math.max(0, Number(event.duration_seconds) || 0);
  const elapsed = secs < 60 ? `${secs} с` : `${Math.floor(secs / 60)} мин ${Math.floor(secs % 60)} с`;
  return [title, `Сервер: ${event.monitor.name}`, `Окружение: ${event.monitor.environment.toUpperCase()}`, `Причина: ${event.cause ?? event.message}`, ...(event.event === 'recovered' ? [`Сейчас: ${event.message}`] : []), `Длительность: ${elapsed}`, `Начало (UTC): ${event.started_at}`, `Событие (UTC): ${event.timestamp}`].join('\n').slice(0, 3900);
}

export async function sendNotification(channel, event, { fetchImpl = fetch, telegramBase = 'https://api.telegram.org' } = {}) {
  let response;
  if (channel.channel === 'telegram') {
    response = await fetchImpl(`${telegramBase}/bot${channel.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: channel.chat_id, text: telegramText(event), link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(8000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok || data.ok !== true) { const error = new Error(`Telegram: HTTP ${response.status}, сообщение не принято`); error.retryAfter = Math.min(3600, Math.max(1, Number(data.parameters?.retry_after) || 0)); throw error; }
  } else {
    response = await fetchImpl(channel.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(channel.token ? { Authorization: `Bearer ${channel.token}` } : {}) }, body: JSON.stringify(event), signal: AbortSignal.timeout(8000), redirect: 'error' });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Webhook: HTTP ${response.status}`);
  }
}
