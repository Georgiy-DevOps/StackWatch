import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { validateMaintenance } from './maintenance.mjs';

export const alarmDefaults = { recovery_threshold: 2, warning_after_seconds: 60, repeat_minutes: 30, maintenance: { mode: 'off' } };

export class InputError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function integer(value, fallback, min, max, label) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${label}: от ${min} до ${max}.`);
  return n;
}
export function validateMonitor(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Нужен объект с параметрами сервера.');
  const v = { ...previous, ...input };
  const name = String(v.name ?? '').trim();
  if (!name || name.length > 80) throw new InputError('Название: от 1 до 80 символов.');
  const environment = v.environment ?? 'prod';
  if (!['prod', 'staging', 'dev'].includes(environment)) throw new InputError('Выберите окружение.');
  const kind = v.kind ?? 'http';
  if (!['http', 'tcp', 'agent'].includes(kind)) throw new InputError('Неизвестный тип проверки.');
  let target = String(v.target ?? '').trim();
  if (!target || target.length > 2048) throw new InputError('Укажите адрес сервера.');
  if (kind === 'tcp') {
    target = target.replace(/^\[|\]$/g, '');
    if (!net.isIP(target) && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(target)) throw new InputError('Для TCP укажите IP или домен без протокола.');
  } else {
    let u; try { u = new URL(target); } catch { throw new InputError('Укажите полный адрес, например https://example.com/health.'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new InputError('Разрешён HTTP(S) без логина, пароля и # в адресе.');
    target = u.href;
  }
  const agent_token = String(input.agent_token === undefined || input.agent_token === '' ? previous.agent_token ?? '' : input.agent_token);
  if (agent_token.length > 512 || /[\r\n]/.test(agent_token)) throw new InputError('Некорректный токен агента.');
  if (kind === 'agent' && !agent_token) throw new InputError('Укажите токен агента.');
  return {
    name, environment, kind, target,
    port: kind === 'tcp' ? integer(v.port, 22, 1, 65535, 'Порт') : null,
    interval_seconds: integer(v.interval_seconds, 30, 10, 3600, 'Интервал в секундах'),
    timeout_ms: integer(v.timeout_ms, 5000, 500, 30000, 'Таймаут в мс'),
    failure_threshold: integer(v.failure_threshold, 2, 1, 10, 'Ошибок до тревоги'),
    recovery_threshold: integer(v.recovery_threshold, 2, 1, 10, 'Успехов для восстановления'),
    warning_after_seconds: integer(v.warning_after_seconds, 60, 0, 3600, 'Длительность предупреждения, с'),
    repeat_minutes: integer(v.repeat_minutes, 30, 0, 1440, 'Напоминание, минуты'),
    maintenance: validateMaintenance(v.maintenance),
    latency_warn_ms: integer(v.latency_warn_ms, 800, 50, 30000, 'Порог задержки в мс'),
    expected_status: integer(v.expected_status, 200, 100, 599, 'Ожидаемый HTTP-код'),
    cpu_warn: integer(v.cpu_warn, 90, 1, 100, 'Порог CPU'),
    ram_warn: integer(v.ram_warn, 90, 1, 100, 'Порог памяти'),
    disk_warn: integer(v.disk_warn, 90, 1, 100, 'Порог диска'),
    agent_token: kind === 'agent' ? agent_token : '',
    enabled: v.enabled === undefined ? true : Boolean(v.enabled)
  };
}

const errorMessage = e => ({ ECONNREFUSED: 'Соединение отклонено', ENOTFOUND: 'Домен не найден', EAI_AGAIN: 'Ошибка DNS', ETIMEDOUT: 'Время ожидания истекло', ECONNRESET: 'Соединение сброшено', CERT_HAS_EXPIRED: 'TLS-сертификат истёк', DEPTH_ZERO_SELF_SIGNED_CERT: 'Недоверенный TLS-сертификат', ERR_TLS_CERT_ALTNAME_INVALID: 'TLS-сертификат не соответствует домену' }[e.code] ?? `Ошибка подключения (${e.code || 'NETWORK'})`);

export function probe(m) {
  return new Promise(resolve => {
    const start = performance.now();
    let settled = false, request;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ latency: Math.round(performance.now() - start), metrics: null, tls_days: null, ...result });
      request?.destroy();
    };
    // Wall-clock deadline includes DNS, handshake, headers and the complete agent body.
    const timer = setTimeout(() => finish({ healthy: false, status: 'down', detail: `Нет ответа за ${m.timeout_ms / 1000} с` }), m.timeout_ms);
    if (m.kind === 'tcp') {
      request = net.createConnection({ host: m.target, port: m.port });
      request.once('connect', () => finish({ healthy: true, status: performance.now() - start > m.latency_warn_ms ? 'degraded' : 'up', detail: `TCP ${m.port} доступен` }));
      request.once('error', e => finish({ healthy: false, status: 'down', detail: errorMessage(e) }));
      return;
    }
    try {
      const u = new URL(m.target);
      request = (u.protocol === 'https:' ? https : http).get(u, {
        agent: false, maxHeaderSize: 16384,
        headers: { 'User-Agent': 'Pulsewatch/1.0', Accept: m.kind === 'agent' ? 'application/json' : '*/*', ...(m.kind === 'agent' ? { Authorization: `Bearer ${m.agent_token}` } : {}) }
      }, res => {
        let tlsDays = null;
        if (res.socket.encrypted) {
          const expiry = Date.parse(res.socket.getPeerCertificate()?.valid_to);
          if (Number.isFinite(expiry)) tlsDays = Math.floor((expiry - Date.now()) / 86400000);
        }
        if (res.statusCode !== m.expected_status) {
          finish({ healthy: false, status: 'down', detail: `HTTP ${res.statusCode}, ожидается ${m.expected_status}`, tls_days: tlsDays });
          return;
        }
        const complete = metrics => {
          const warnings = [];
          if (performance.now() - start > m.latency_warn_ms) warnings.push('Высокая задержка');
          if (tlsDays !== null && tlsDays < 14) warnings.push(`TLS истекает через ${tlsDays} дн.`);
          if (metrics) for (const [key, label] of [['cpu', 'CPU'], ['ram', 'Память'], ['disk', 'Диск']]) {
            if (metrics[key] >= m[`${key}_warn`]) warnings.push(`${label}: ${metrics[key]}%`);
          }
          finish({ healthy: true, status: warnings.length ? 'degraded' : 'up', detail: warnings.join(' · ') || `HTTP ${res.statusCode} · OK`, metrics, tls_days: tlsDays });
        };
        if (m.kind !== 'agent') { complete(null); return; }
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 65536) { finish({ healthy: false, status: 'down', detail: 'Слишком большой ответ агента' }); return; }
          chunks.push(chunk);
        });
        res.on('error', e => finish({ healthy: false, status: 'down', detail: errorMessage(e) }));
        res.on('aborted', () => finish({ healthy: false, status: 'down', detail: 'Ответ агента прерван' }));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const metrics = {};
            for (const k of ['cpu', 'ram', 'disk']) {
              if (typeof data[k] !== 'number' || !Number.isFinite(data[k]) || data[k] < 0 || data[k] > 100) throw Error('metrics');
              metrics[k] = Math.round(data[k] * 10) / 10;
            }
            complete(metrics);
          } catch { finish({ healthy: false, status: 'down', detail: 'Некорректные метрики агента' }); }
        });
      });
      request.once('error', e => finish({ healthy: false, status: 'down', detail: errorMessage(e) }));
    } catch { finish({ healthy: false, status: 'down', detail: 'Не удалось выполнить проверку' }); }
  });
}
