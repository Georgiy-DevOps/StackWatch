const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  alert: '<path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  settings: '<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="11" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 11 3 3 5-5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="m11 13 11-11"/>',
  volume: '<path d="M11 4 6 8H3v8h3l5 4ZM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  flask: '<path d="M9 3h6M10 3v6l-6 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-9V3M7 14h10"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>', pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="m7 4 14 8-14 8Z"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.server}</svg>`;
$$('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const labels = { up: 'В норме', down: 'Недоступен', degraded: 'Внимание', pending: 'Проверяем сбой', unknown: 'Ждём проверку', paused: 'На паузе', stale: 'Нет свежих данных', maintenance: 'Техработы', recovering: 'Проверяем восстановление', watching: 'Наблюдаем перегрузку' };
const statusHtml = status => `<span class="status ${status}"><span class="dot ${status}"></span>${labels[status]}</span>`;
const number = (v, digits = 0) => v === null || v === undefined ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const dateTime = ts => ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const time = ts => ts ? new Date(ts).toLocaleTimeString('ru-RU') : '—';
const duration = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s} с` : s < 3600 ? `${Math.floor(s / 60)} мин` : s < 86400 ? `${Math.floor(s / 3600)} ч ${Math.floor(s % 3600 / 60)} мин` : `${Math.floor(s / 86400)} дн.`; };
const safeGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const safeSet = (key, v) => { try { localStorage.setItem(key, v); } catch {} };
let data = null, connected = false, lastReceived = 0, demo = false, view = 'overview', environment = 'all', editing = null, deleting = null;
let sound = safeGet('pulsewatch.sound') === 'true', notifications = safeGet('pulsewatch.notifications') === 'true';
let audioContext, eventBaseline = null, polling = false;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: options.signal ?? AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error || 'Не удалось выполнить запрос.');
  }
  return result;
}
function toast(message, error = false) { const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message; $('#toasts').append(el); setTimeout(() => el.remove(), 6000); }
function initAudio() { try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); } catch {} }
function beep() {
  if (!sound || !audioContext || audioContext.state !== 'running') return;
  const osc = audioContext.createOscillator(), gain = audioContext.createGain();
  osc.connect(gain); gain.connect(audioContext.destination); osc.frequency.value = 660;
  gain.gain.setValueAtTime(.08, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .5);
  osc.start(); osc.stop(audioContext.currentTime + .5);
}
function toggleSound(value) { sound = value; safeSet('pulsewatch.sound', String(sound)); if (sound) initAudio(); renderPreferences(); }
function renderPreferences() {
  $('#sound-toggle').checked = sound;
  $('#sound-button').setAttribute('aria-pressed', String(sound));
  $('#sound-button').setAttribute('aria-label', sound ? 'Выключить звук тревог' : 'Включить звук тревог');
  $('#sound-button').title = sound ? 'Выключить звук тревог' : 'Включить звук тревог';
  const allowed = 'Notification' in window && Notification.permission === 'granted' && notifications;
  $('#notify-button').textContent = allowed ? 'Выключить уведомления' : 'Включить уведомления';
  $('#notify-status').textContent = !('Notification' in window) ? 'Этот браузер не поддерживает уведомления.' : Notification.permission === 'denied' ? 'Уведомления заблокированы в настройках браузера.' : allowed ? 'Включены для этой панели.' : 'Выключены.';
}
function setView(next) {
  view = next;
  for (const name of ['overview', 'incidents', 'settings']) $(`#${name}-view`).hidden = name !== view;
  $$('.nav-item').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  $('#breadcrumb').textContent = { overview: 'Обзор серверов', incidents: 'Инциденты', settings: 'Настройки' }[view];
  render();
}
function dataset() {
  const source = demo ? demoData : data;
  if (!source) return { monitors: [], incidents: [] };
  const serverNow = source.now + Math.max(0, Date.now() - lastReceived);
  return { ...source, monitors: source.monitors.map(m => ({ ...m, status: !demo && m.enabled && (!connected || (m.last_checked && serverNow - m.last_checked > Math.max(30000, m.interval_seconds * 3000 + m.timeout_ms))) ? 'stale' : m.status })) };
}
function historyHtml(m) {
  return `<div class="history" aria-label="История проверок за 24 часа">${m.history.map((b, i) => `<span class="${b?.status ?? ''}" title="${b ? `${labels[b.status]} · успешно ${b.good} из ${b.total}` : 'Нет проверок'} · интервал ${i + 1} из 36"></span>`).join('')}</div>`;
}
function renderHealth(monitors) {
  const active = monitors.filter(m => m.enabled && m.status !== 'maintenance'), down = active.filter(m => m.status === 'down'), prodDown = down.filter(m => m.environment === 'prod');
  const attention = active.filter(m => ['pending', 'degraded', 'stale', 'watching', 'recovering'].includes(m.status)), unknown = active.filter(m => m.status === 'unknown');
  let title, subtitle, theme, glyph;
  if (!monitors.length) { title = 'Подключите первый сервер'; subtitle = 'Проверим доступность и начнём собирать историю состояния.'; theme = 'neutral'; glyph = 'server'; }
  else if (!active.length) { title = monitors.some(m => m.enabled) ? 'Плановые техработы' : 'Все проверки на паузе'; subtitle = monitors.some(m => m.enabled) ? 'Результаты сохраняются. Тревоги возобновятся после завершения техработ.' : 'Возобновите проверку, чтобы видеть текущее состояние.'; theme = 'neutral'; glyph = 'pause'; }
  else if (down.length) { title = prodDown.length ? 'Production требует внимания' : 'Обнаружена недоступность'; subtitle = `Недоступно: ${down.length} · ${down.map(m => m.name).slice(0, 3).join(', ')}${down.length > 3 ? '…' : ''}`; theme = 'danger'; glyph = 'alert'; }
  else if (attention.length) { title = 'Есть предупреждения'; subtitle = `Требуют внимания: ${attention.length}. Откройте сервер, чтобы увидеть причину.`; theme = 'warning'; glyph = 'alert'; }
  else if (unknown.length) { title = 'Выполняем первые проверки'; subtitle = `Ожидают результата: ${unknown.length}. Статусы появятся автоматически.`; theme = 'neutral'; glyph = 'clock'; }
  else { title = 'Все системы работают штатно'; subtitle = `Активных проверок: ${active.length}. Все доступны, критических сбоев нет.`; theme = ''; glyph = 'check'; }
  const el = $('#health-banner'); el.className = `health-banner ${theme}`;
  el.innerHTML = `<span class="health-icon">${icon(glyph)}</span><div class="health-copy"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></div><span class="badge">${demo ? 'DEMO' : 'SYSTEM STATUS'}</span>`;
}
function renderStats(monitors) {
  const up = monitors.filter(m => m.status === 'up').length;
  const down = monitors.filter(m => m.status === 'down').length;
  const warnings = monitors.filter(m => ['pending', 'degraded', 'stale', 'watching', 'recovering'].includes(m.status)).length;
  const total = monitors.reduce((s, m) => s + m.checks_24h, 0);
  const uptime = total ? monitors.reduce((s, m) => s + (m.uptime || 0) * m.checks_24h, 0) / total : null;
  const latencies = monitors.filter(m => m.result?.healthy && m.enabled && !['stale', 'unknown'].includes(m.status));
  const latency = latencies.length ? latencies.reduce((s, m) => s + m.result.latency, 0) / latencies.length : null;
  const items = [
    ['Всего серверов', number(monitors.length), '', `<span class="good">${up} в норме</span> · ${monitors.filter(m => !m.enabled).length} на паузе`, 'server', ''],
    ['Недоступны', number(down), '', `${warnings} с предупреждением`, 'alert', down ? 'danger' : ''],
    ['Успешные проверки', number(uptime, 2), uptime !== null ? '%' : '', `Проверок за 24 часа: ${number(total)}`, 'shield', ''],
    ['Средний отклик', number(latency), latency !== null ? 'мс' : '', 'Последние успешные ответы', 'pulse', '']
  ];
  $('#stats').innerHTML = items.map(([label, value, unit, meta, glyph, cls]) => `<article class="stat"><div class="stat-label">${label}${icon(glyph)}</div><div class="stat-value ${cls}">${value}<span class="unit">${unit}</span></div><div class="stat-meta">${meta}</div></article>`).join('');
}
function renderServers(monitors) {
  const query = $('#search').value.trim().toLowerCase(), filter = $('#status-filter').value;
  const filtered = monitors.filter(m => (environment === 'all' || m.environment === environment) && (!query || `${m.name} ${m.target}`.toLowerCase().includes(query)) && (filter === 'all' || (filter === 'attention' ? ['down', 'degraded', 'pending', 'stale', 'watching', 'recovering'].includes(m.status) : m.status === filter)));
  const rank = { down: 0, stale: 1, degraded: 2, pending: 3, recovering: 3, watching: 3, unknown: 4, up: 5, maintenance: 6, paused: 7 };
  filtered.sort((a, b) => rank[a.status] - rank[b.status] || (a.environment === 'prod' ? 0 : 1) - (b.environment === 'prod' ? 0 : 1) || a.name.localeCompare(b.name));
  $('#server-count').textContent = filtered.length;
  if (!monitors.length) {
    $('#server-list').innerHTML = `<div class="empty-state"><div class="empty-icon">${icon('server')}</div><h3>Инфраструктура начинается с первого сервера</h3><p>Добавьте IP, домен или health-check адрес. StackWatch будет следить за ним в фоне.</p><button class="button primary" data-add>${icon('plus')}Добавить сервер</button><button class="text-button" data-demo>Посмотреть пример ↗</button></div>`;
    return;
  }
  if (!filtered.length) { $('#server-list').innerHTML = '<div class="empty-state"><h3>Серверы не найдены</h3><p>Попробуйте другой запрос или сбросьте фильтры.</p><button class="button secondary" data-reset-filters>Сбросить фильтры</button></div>'; return; }
  $('#server-list').innerHTML = `<div class="table-wrap"><table class="server-table"><thead><tr><th>Сервер</th><th>Окружение</th><th>Состояние</th><th>Отклик</th><th>История · 24 ч</th><th><span class="muted">Подробнее</span></th></tr></thead><tbody>${filtered.map(m => `<tr><td><div class="server-identity"><span class="server-symbol ${m.status}">${icon(m.kind === 'agent' ? 'cpu' : 'server')}</span><div><button class="server-name" data-detail="${m.id}">${esc(m.name)}</button><span class="server-target" title="${esc(m.target)}">${esc(m.target)}${m.kind === 'tcp' ? `:${m.port}` : ''}</span></div></div></td><td><span class="env-tag ${m.environment}">${m.environment.toUpperCase()}</span></td><td>${statusHtml(m.status)}</td><td class="mono latency">${m.result?.healthy && !['stale','paused','unknown'].includes(m.status) ? `${number(m.result.latency)} <span class="subtle">мс</span>` : '<span class="muted">—</span>'}</td><td>${historyHtml(m)}<div class="history-labels"><span>24 ч назад</span><span>${number(m.uptime, 2)}${m.uptime !== null ? '%' : ''}</span></div></td><td><button class="icon-button" data-detail="${m.id}" aria-label="Подробнее о ${esc(m.name)}">${icon('arrow')}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function eventHtml(event) {
  const closed = Boolean(event.ended_at), recovered = event.closure === 'recovered';
  const type = closed ? recovered ? 'up' : 'unknown' : event.severity;
  const outcome = closed ? { recovered: 'Восстановлен', paused: 'Проверка приостановлена', changed: 'Изменены параметры', removed: 'Проверка удалена', maintenance: 'Начались техработы' }[event.closure] || 'Закрыт' : event.severity === 'down' ? 'Недоступен' : 'Предупреждение';
  return `<article class="event-row"><span class="event-icon ${type}">${icon(recovered ? 'check' : closed ? 'pause' : 'alert')}</span><div class="event-main"><strong>${esc(event.name)} <span class="muted">· ${outcome}</span></strong><p>${esc(event.detail)}</p></div><span class="env-tag ${event.environment}">${event.environment.toUpperCase()}</span><div class="event-meta">${dateTime(event.started_at)}<span>${closed ? duration(event.ended_at - event.started_at) : `Идёт ${duration((demo ? demoData.now : (data?.now ?? Date.now()) + Date.now() - lastReceived) - event.started_at)}`}</span></div>${!closed ? event.acknowledged ? '<span class="subtle">Принят</span>' : `<button class="text-button" data-ack="${event.id}">Принять</button>` : ''}</article>`;
}
function renderIncidents(incidents) {
  const empty = `<div class="empty-events">${icon('check')}Инцидентов пока нет. Здесь появятся сбои и восстановление.</div>`;
  $('#incident-count').textContent = incidents.filter(i => !i.ended_at).length;
  $('#recent-incidents').innerHTML = incidents.slice(0, 3).map(eventHtml).join('') || empty;
  const filter = $('#incident-filter').value;
  $('#incident-list').innerHTML = incidents.filter(i => filter === 'all' || (filter === 'open' ? !i.ended_at : i.ended_at)).map(eventHtml).join('') || empty;
}
function renderSettings() {
  if (!data) return;
  const s = data.settings;
  $('#webhook-status').innerHTML = `${statusHtml(s.webhook_configured ? 'up' : 'paused')}<p>${s.webhook_configured ? 'Webhook настроен' : 'Webhook не настроен'}</p>${data.pending_alerts ? `<p>В очереди: ${data.pending_alerts}</p>` : ''}${data.failed_alerts ? `<p class="form-error">Не доставлено после 5 попыток: ${data.failed_alerts}. Проверьте обработчик.</p>` : ''}`;
  $('#service-settings').innerHTML = `<div class="settings-row"><span>Хранение истории</span><strong>${s.retention_days} дн.</strong></div><div class="settings-row"><span>Доступ к панели</span><strong>${s.auth_enabled ? 'По ключу' : 'Локальный'}</strong></div><div class="settings-row"><span>Запущена</span><strong>${dateTime(data.engine.started_at)}</strong></div><div class="settings-row"><span>Активных запросов</span><strong>${data.engine.active}</strong></div>`;
  $('#logout').hidden = !s.auth_enabled;
}
function render() {
  const d = dataset();
  $('#demo-banner').hidden = !demo;
  $('#check-all').disabled = demo || !connected || !d.monitors.some(m => m.enabled);
  $('#demo-toggle').textContent = demo ? 'Выйти из демо' : 'Посмотреть демо';
  renderHealth(d.monitors); renderStats(d.monitors); renderServers(d.monitors); renderIncidents(d.incidents); renderSettings();
}
async function poll() {
  if (polling || $('#login-dialog').open) return;
  polling = true;
  try {
    const next = await api('/api/snapshot');
    connected = true; lastReceived = Date.now();
    const events = new Map(next.incidents.map(i => [i.id, `${i.severity}:${i.ended_at || 0}`]));
    if (eventBaseline) for (const i of next.incidents) {
      if (!i.ended_at && events.get(i.id) !== eventBaseline.get(i.id)) {
        toast(`${i.environment.toUpperCase()} · ${i.name}: ${i.detail}`, i.severity === 'down');
        if (!demo) {
          beep();
          if (notifications && 'Notification' in window && Notification.permission === 'granted') {
            try { new Notification(`StackWatch · ${i.environment.toUpperCase()}`, { body: `${i.name}: ${i.detail}`, tag: i.id }); } catch {}
          }
        }
      }
    }
    eventBaseline = events; data = next;
    $('#connection-warning').hidden = true;
    $('#engine-dot').className = `dot ${next.engine.running ? 'up' : 'down'}`;
    $('#engine-label').textContent = next.engine.running ? 'Мониторинг работает' : 'Мониторинг остановлен';
    $('#engine-sub').textContent = `История хранится ${next.settings.retention_days} дн.`;
    $('#refresh-label').textContent = `Обновлено ${time(Date.now())}`;
  } catch (e) {
    connected = false;
    $('#connection-warning').hidden = false;
    $('#connection-warning').textContent = 'Нет связи со службой мониторинга. Показанные данные могли устареть. Проверьте, запущен ли StackWatch.';
    $('#engine-dot').className = 'dot down'; $('#engine-label').textContent = 'Нет связи со службой'; $('#refresh-label').textContent = 'Нет свежих данных';
  } finally { polling = false; render(); document.dispatchEvent(new Event('pulsewatch:update')); }
}
function setDemo(value) { demo = value; $('#detail-dialog').close(); render(); }
function syncKind() {
  const kind = $('#kind').value;
  $('#port-field').hidden = kind !== 'tcp'; $('#token-field').hidden = kind !== 'agent'; $('#http-code-field').hidden = kind === 'tcp';
  const target = $('#monitor-form').elements.target;
  target.placeholder = kind === 'tcp' ? '192.168.1.10 или db.example.com' : kind === 'agent' ? 'https://server.example.com/health' : 'https://example.com/health';
  $('#target-hint').textContent = kind === 'tcp' ? 'IP или домен без протокола. Порт укажите отдельно.' : kind === 'agent' ? 'Адрес агента StackWatch с путём /health.' : 'Полный URL. Проверяется точный HTTP-код, без перехода по редиректам.';
}
function openForm(id = null) {
  if (id && demo) { toast('Демо-данные нельзя изменять. Добавьте свой сервер.'); return; }
  $('#detail-dialog').close();
  editing = id; $('#monitor-form').reset(); $('#form-error').textContent = '';
  const m = id ? data.monitors.find(m => m.id === id) : null;
  if (m) for (const [key, value] of Object.entries(m)) if ($('#monitor-form').elements[key] && key !== 'agent_token') $('#monitor-form').elements[key].value = value;
  $('#monitor-form').elements.agent_token.value = '';
  $('#monitor-form').elements.agent_token.placeholder = m?.has_agent_token ? 'Оставьте пустым, чтобы сохранить токен' : 'Значение AGENT_TOKEN';
  $('#monitor-dialog-title').textContent = id ? 'Настроить проверку' : 'Добавить сервер';
  $('#save-monitor').textContent = id ? 'Сохранить изменения' : 'Добавить и проверять';
  syncKind(); $('#monitor-dialog').showModal(); $('#monitor-form').elements.name.focus();
}
async function showDetail(id) {
  const m = dataset().monitors.find(m => m.id === id); if (!m) return;
  $('#detail-content').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">${m.kind === 'agent' ? 'АГЕНТ' : m.kind.toUpperCase()} · ${m.environment.toUpperCase()}</span><h2>${esc(m.name)}</h2></div><button class="icon-button" data-close="detail-dialog" aria-label="Закрыть">${icon('close')}</button></div><p class="detail-target">${esc(m.target)}${m.port ? `:${m.port}` : ''}</p><div class="detail-summary">${statusHtml(m.status)}<p>${esc(m.result?.detail || 'Первая проверка ещё не завершена.')}</p></div><div class="settings-row"><span>Последняя проверка</span><strong>${dateTime(m.last_checked)}</strong></div><div class="settings-row"><span>Интервал / таймаут</span><strong>${m.interval_seconds} с / ${m.timeout_ms / 1000} с</strong></div><div class="settings-row"><span>Ошибок до тревоги</span><strong>${m.failure_threshold}</strong></div>${m.result?.tls_days !== null && m.result?.tls_days !== undefined ? `<div class="settings-row"><span>TLS истекает через</span><strong>${m.result.tls_days} дн.</strong></div>` : ''}${m.result?.metrics ? `<div class="metrics">${[['cpu', 'CPU'], ['ram', 'Память'], ['disk', 'Диск']].map(([k, label]) => `<div class="metric"><span>${label}</span><strong>${number(m.result.metrics[k], 1)}%</strong><progress value="${m.result.metrics[k]}" max="100" aria-label="${label}"></progress></div>`).join('')}</div>` : '<p class="small" style="margin:18px 0">CPU, память и диск доступны для проверок с агентом.</p>'}<h2>Последние 60 проверок</h2><div class="check-list" id="check-history">Загрузка…</div><div class="detail-actions">${demo ? '<span class="small">Пример данных. Для реального мониторинга добавьте сервер.</span>' : `<button class="button secondary" data-one-check="${m.id}" ${!m.enabled ? 'disabled' : ''}>${icon('refresh')}Проверить</button><button class="button secondary" data-edit="${m.id}">Изменить</button><button class="button secondary" data-pause="${m.id}">${m.enabled ? 'Пауза' : 'Возобновить'}</button><button class="button destructive" data-delete="${m.id}">Удалить</button>`}</div><p class="small" style="margin-top:14px">Снимок на момент открытия. Для новых результатов откройте карточку повторно.</p>`;
  $('#detail-dialog').showModal();
  try {
    const history = demo ? Array.from({ length: 12 }, (_, i) => ({ ts: demoData.now - i * 30000, healthy: m.status !== 'down', latency: m.result.latency, detail: m.result.detail })) : await api(`/api/monitors/${id}/history`);
    if (!$('#check-history')) return;
    $('#check-history').innerHTML = history.map(c => `<div class="check-row"><span class="mono muted">${time(c.ts)}</span><span class="mono">${c.healthy ? `${c.latency} мс` : '—'}</span><span class="check-result"><span class="dot ${c.healthy ? 'up' : 'down'}"></span>${esc(c.detail)}</span></div>`).join('') || '<p class="small">Результаты появятся после первой проверки.</p>';
  } catch (e) { if ($('#check-history')) $('#check-history').textContent = e.message; }
}
function showLogin() { if (!$('#login-dialog').open) $('#login-dialog').showModal(); }

document.addEventListener('click', async event => {
  if (sound) initAudio();
  const el = event.target.closest('button'); if (!el) return;
  try {
    if (el.dataset.close) $(`#${el.dataset.close}`).close();
    else if ('add' in el.dataset) openForm();
    else if ('demo' in el.dataset) setDemo(true);
    else if (el.dataset.view) setView(el.dataset.view);
    else if (el.dataset.env) { environment = el.dataset.env; $$('.environment-tabs button').forEach(b => b.classList.toggle('selected', b === el)); render(); }
    else if ('resetFilters' in el.dataset) { environment = 'all'; $('#search').value = ''; $('#status-filter').value = 'all'; $$('.environment-tabs button').forEach(b => b.classList.toggle('selected', b.dataset.env === 'all')); render(); }
    else if (el.dataset.detail) await showDetail(el.dataset.detail);
    else if (el.dataset.edit) openForm(el.dataset.edit);
    else if (el.dataset.ack) { if (demo) { demoData.incidents.find(i => i.id === el.dataset.ack).acknowledged = 1; render(); } else { await api(`/api/incidents/${el.dataset.ack}/ack`, { method: 'POST' }); await poll(); } toast('Инцидент принят. Проверки продолжаются.'); }
    else if (el.dataset.oneCheck) { const r = await api(`/api/monitors/${el.dataset.oneCheck}/check`, { method: 'POST' }); toast(r.queued ? 'Проверка поставлена в очередь.' : 'Проверка уже идёт или только что завершилась.'); }
    else if (el.dataset.pause) { const m = data.monitors.find(m => m.id === el.dataset.pause); await api(`/api/monitors/${m.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !m.enabled }) }); $('#detail-dialog').close(); await poll(); toast(m.enabled ? 'Проверка приостановлена.' : 'Проверка возобновлена.'); }
    else if (el.dataset.delete) { deleting = el.dataset.delete; $('#detail-dialog').close(); $('#confirm-text').textContent = `Удалить «${data.monitors.find(m => m.id === deleting).name}» и результаты его проверок? Журнал инцидентов сохранится.`; $('#confirm-dialog').showModal(); }
  } catch (e) { toast(e.message, true); }
});
$('#confirm-delete').addEventListener('click', async () => { try { await api(`/api/monitors/${deleting}`, { method: 'DELETE' }); $('#confirm-dialog').close(); await poll(); toast('Проверка удалена.'); } catch (e) { toast(e.message, true); } });
$('#monitor-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#save-monitor'); button.disabled = true; $('#form-error').textContent = '';
  try {
    const payload = Object.fromEntries(new FormData(event.target));
    if (typeof pwFormPayload === 'function') Object.assign(payload, pwFormPayload());
    await api(editing ? `/api/monitors/${editing}` : '/api/monitors', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('#monitor-dialog').close(); demo = false; environment = 'all'; $('#search').value = ''; $('#status-filter').value = 'all';
    $$('.environment-tabs button').forEach(b => b.classList.toggle('selected', b.dataset.env === 'all'));
    setView('overview'); await poll(); toast(editing ? 'Изменения сохранены.' : 'Сервер добавлен. Выполняем первую проверку.');
  } catch (e) { $('#form-error').textContent = e.message; } finally { button.disabled = false; }
});
$('#kind').addEventListener('change', syncKind);
$('#search').addEventListener('input', () => renderServers(dataset().monitors));
$('#status-filter').addEventListener('change', render);
$('#incident-filter').addEventListener('change', render);
$('#all-incidents').addEventListener('click', () => setView('incidents'));
$('#demo-toggle').addEventListener('click', () => setDemo(!demo));
$('#exit-demo').addEventListener('click', () => setDemo(false));
$('#sound-button').addEventListener('click', () => toggleSound(!sound));
$('#sound-toggle').addEventListener('change', e => toggleSound(e.target.checked));
$('#check-all').addEventListener('click', async () => { try { const r = await api('/api/check', { method: 'POST' }); toast(r.queued ? `В очереди: ${r.queued}. Статусы обновятся автоматически.` : 'Проверки уже идут или только что завершились.'); } catch (e) { toast(e.message, true); } });
$('#notify-button').addEventListener('click', async () => {
  if (!('Notification' in window)) { toast('Браузер не поддерживает уведомления.', true); return; }
  if (notifications && Notification.permission === 'granted') notifications = false;
  else notifications = (await Notification.requestPermission()) === 'granted';
  safeSet('pulsewatch.notifications', String(notifications)); renderPreferences();
});
$('#login-dialog').addEventListener('cancel', e => e.preventDefault());
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ key: $('#access-key').value }) }); $('#access-key').value = ''; $('#login-dialog').close(); eventBaseline = null; await poll(); } catch (e) { $('#login-error').textContent = e.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); data = null; demo = false; eventBaseline = null; connected = false; render(); showLogin(); } catch (e) { toast(e.message, true); } });

const demoNow = Date.now();
const sampleMonitors = [
  ['prod-api-01', 'prod', 'http', 'https://api.example.com/health', 'down', 5000, 'Нет ответа за 5 с', null],
  ['prod-db-01', 'prod', 'agent', 'https://db.example.com/health', 'degraded', 42, 'Диск: 93%', { cpu: 32, ram: 68, disk: 93 }],
  ['prod-web-01', 'prod', 'http', 'https://www.example.com', 'up', 128, 'HTTP 200 · OK', null],
  ['prod-worker-01', 'prod', 'agent', 'https://worker.example.com/health', 'up', 35, 'HTTP 200 · OK', { cpu: 24, ram: 47, disk: 39 }],
  ['prod-cache-01', 'prod', 'tcp', 'cache.example.com', 'up', 8, 'TCP 6379 доступен', null],
  ['staging-api', 'staging', 'http', 'https://staging.example.com/health', 'up', 156, 'HTTP 200 · OK', null],
  ['dev-windows', 'dev', 'agent', 'https://windows.example.com/health', 'up', 61, 'HTTP 200 · OK', { cpu: 15, ram: 53, disk: 48 }]
];
const demoData = {
  now: demoNow,
  monitors: sampleMonitors.map(([name, environment, kind, target, status, latency, detail, metrics], index) => ({ id: `demo-${index}`, name, environment, kind, target, status, result: { healthy: status !== 'down', status, latency, detail, metrics, tls_days: null }, port: kind === 'tcp' ? 6379 : null, enabled: true, last_checked: demoNow - 5000, interval_seconds: 30, timeout_ms: 5000, failure_threshold: 2, checks_24h: 2880, uptime: index === 0 ? 99.03 : 100, history: Array.from({ length: 36 }, (_, i) => ({ status: index === 0 && i >= 33 ? 'down' : index === 1 && i >= 31 ? 'degraded' : 'up', total: 80, good: index === 0 && i >= 33 ? 50 : 80 })) })),
  incidents: [
    { id: 'demo-incident-0', monitor_id: 'demo-0', name: 'prod-api-01', environment: 'prod', severity: 'down', started_at: demoNow - 840000, ended_at: null, detail: 'Нет ответа за 5 с · 2 ошибки подряд', acknowledged: 0 },
    { id: 'demo-incident-1', monitor_id: 'demo-1', name: 'prod-db-01', environment: 'prod', severity: 'degraded', started_at: demoNow - 1620000, ended_at: null, detail: 'Диск: 93% · порог 90%', acknowledged: 0 },
    { id: 'demo-incident-2', monitor_id: 'demo-5', name: 'staging-api', environment: 'staging', severity: 'down', started_at: demoNow - 3900000, ended_at: demoNow - 3660000, closure: 'recovered', detail: 'HTTP 503, ожидается 200', acknowledged: 1 }
  ]
};
renderPreferences(); render();
api('/api/session').then(session => { if (!session.logged_in) showLogin(); else poll(); }).catch(() => poll());
setInterval(poll, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
