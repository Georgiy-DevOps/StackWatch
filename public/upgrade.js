// Version 2 extends the existing dashboard without replacing user preferences or data.
let pwDetailId = null, pwRange = '24h', pwDetailRequest = 0, pwDetailBusy = false, pwSettingsLoaded = false;
const pwBaseOpenForm = openForm;
const pwBaseSettings = renderSettings;
const pwBaseSetView = setView;
setView = function(next) { if (next === 'settings' && demo) demo = false; pwBaseSetView(next); };
const pwSetText = (selector, text) => { const el = $(selector); if (el) el.textContent = text; };
$('.version span').textContent = 'v2.0';
$('#status-filter').insertAdjacentHTML('beforeend', '<option value="maintenance">Техработы</option><option value="watching">Наблюдаем перегрузку</option><option value="recovering">Восстановление</option>');

$('#monitor-form .extra-fields').insertAdjacentHTML('beforeend', `
  <label>Успехов для восстановления<input name="recovery_threshold" type="number" min="1" max="10" value="2" required></label>
  <label>Перегрузка длится, с<input name="warning_after_seconds" type="number" min="0" max="3600" value="60" required></label>
  <label>Напоминать каждые, мин<input name="repeat_minutes" type="number" min="0" max="1440" value="30" required><small>0 — без напоминаний. «Принять» прекращает напоминания.</small></label>`);
$('#monitor-form .extra-fields+p').textContent = 'Ошибки и восстановление подтверждаются несколькими проверками. Перегрузка должна сохраняться заданное время; 0 — предупреждать сразу.';
$('#monitor-form>.form-grid').insertAdjacentHTML('beforeend', `<details class="wide maintenance-form"><summary>Расписание техработ</summary><div class="form-grid extra-fields">
  <label class="wide">Режим<select id="maintenance-mode"><option value="off">Без техработ</option><option value="once">Один раз</option><option value="weekly">Еженедельно</option></select></label>
  <div id="maintenance-once" class="form-grid wide" hidden><label>Начало<input id="maintenance-start" type="datetime-local"></label><label>Конец<input id="maintenance-end" type="datetime-local"></label><p class="small wide">Время вашего браузера: <span id="browser-timezone"></span>.</p></div>
  <div id="maintenance-weekly" class="form-grid wide" hidden><div class="wide weekdays">${['Вс','Пн','Вт','Ср','Чт','Пт','Сб'].map((d,i) => `<label><input type="checkbox" name="maintenance_days" value="${i}">${d}</label>`).join('')}</div><label>Начало<input id="maintenance-start-time" type="time" value="02:00"></label><label>Конец<input id="maintenance-end-time" type="time" value="03:00"></label><label class="wide">Часовой пояс<input id="maintenance-timezone" placeholder="Europe/Moscow"></label></div>
  <p class="small wide">Проверки и графики продолжаются; новые тревоги и напоминания отключены. Открытый инцидент закроется с причиной «Техработы». После окончания сбои подтверждаются заново.</p>
</div></details>`);
const pwZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
$('#browser-timezone').textContent = pwZone;
function pwMaintenanceMode() { $('#maintenance-once').hidden = $('#maintenance-mode').value !== 'once'; $('#maintenance-weekly').hidden = $('#maintenance-mode').value !== 'weekly'; }
$('#maintenance-mode').addEventListener('change', pwMaintenanceMode);
function pwLocalDate(ts) { if (!ts) return ''; const d = new Date(ts); return new Date(ts - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
function pwFormPayload() {
  const mode = $('#maintenance-mode').value;
  if (mode === 'off') return { maintenance: { mode } };
  if (mode === 'once') {
    const start_at = new Date($('#maintenance-start').value).getTime(), end_at = new Date($('#maintenance-end').value).getTime();
    if (!Number.isFinite(start_at) || !Number.isFinite(end_at)) throw Error('Укажите начало и конец техработ.');
    return { maintenance: { mode, start_at, end_at } };
  }
  return { maintenance: { mode, days: $$('[name=maintenance_days]:checked').map(el => Number(el.value)), start_time: $('#maintenance-start-time').value, end_time: $('#maintenance-end-time').value, timezone: $('#maintenance-timezone').value } };
}
openForm = function(id = null) {
  pwBaseOpenForm(id); if (!$('#monitor-dialog').open) return;
  const m = id ? data.monitors.find(m => m.id === id) : null, maintenance = m?.maintenance ?? { mode: 'off' };
  $('#maintenance-mode').value = maintenance.mode; $('#maintenance-timezone').value = maintenance.timezone || pwZone;
  $('#maintenance-start').value = pwLocalDate(maintenance.start_at); $('#maintenance-end').value = pwLocalDate(maintenance.end_at);
  $('#maintenance-start-time').value = maintenance.start_time || '02:00'; $('#maintenance-end-time').value = maintenance.end_time || '03:00';
  $$('[name=maintenance_days]').forEach(el => el.checked = (maintenance.days || [0]).includes(Number(el.value))); pwMaintenanceMode();
};

function pwChart(series, key, title, unit, threshold) {
  const points = series.points, valid = points.filter(p => p[key] !== null && p[key] !== undefined), max = valid.length ? Math.max(...valid.map(p => p[`${key}_max`] ?? p[key])) : null;
  const limit = key === 'latency' ? Math.max(100, (max || 0) * 1.15, (threshold || 0) * 1.1) : 100;
  const x = i => 34 + i * 442 / Math.max(1, points.length - 1), y = v => 121 - Math.min(limit, Math.max(0, v)) / limit * 98;
  const trace = property => { let pen = false; return points.map((p,i) => { const value = p[property]; if (value === null || value === undefined) { pen = false; return ''; } const segment = `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`; pen = true; return segment; }).join(' '); };
  return `<article class="chart-card"><div class="chart-heading"><h3>${title}</h3><span>Пик <strong>${number(max, 1)}${max !== null ? ` ${unit}` : ''}</strong></span></div>${valid.length ? `<svg class="series-chart" viewBox="0 0 500 153" role="img" aria-label="${title}: среднее и максимум за ${series.range === '7d' ? '7 дней' : '24 часа'}. Пик ${number(max,1)} ${unit}."><title>${title}. Разрывы означают отсутствие данных.</title>${[0,.5,1].map(p => `<line x1="34" x2="476" y1="${y(p*limit)}" y2="${y(p*limit)}" class="chart-grid"/><text x="3" y="${y(p*limit)+4}" class="axis-label">${Math.round(p*limit)}</text>`).join('')}${threshold ? `<line x1="34" x2="476" y1="${y(threshold)}" y2="${y(threshold)}" class="chart-threshold"/>` : ''}<path d="${trace(`${key}_max`)}" class="chart-peak"/><path d="${trace(key)}" class="chart-average"/>${points.map((p,i) => p[key] == null ? '' : `<circle cx="${x(i)}" cy="${y(p[key])}" r="2.1" class="chart-point"><title>${dateTime(p.ts)} · ${title}: ${number(p[key],1)} ${unit} · пик ${number(p[`${key}_max`],1)} · проверок ${p.samples}</title></circle>`).join('')}<text x="34" y="145" class="axis-label">${dateTime(series.from)}</text><text x="476" y="145" text-anchor="end" class="axis-label">${dateTime(series.to)}</text></svg>` : `<div class="chart-empty">${key === 'latency' ? 'Нет успешных ответов за выбранный период' : 'Нет метрик. Подключите агент для этого сервера.'}</div>`}</article>`;
}
function pwDemoDetail(m) {
  const now = Date.now(), count = pwRange === '7d' ? 168 : 144, step = pwRange === '7d' ? 3600000 : 600000, from = now - step * count;
  const points = Array.from({ length: count }, (_,i) => {
    const t = i / count, p = { ts: from + i*step, samples: 20, ok: 20, suppressed: 0, latency: Math.round(60 + 22*Math.sin(i*.25) + t*55), cpu: m.kind === 'agent' ? 32 + 22*Math.sin(i*.18) : null, ram: m.kind === 'agent' ? 55+t*14 : null, disk: m.kind === 'agent' ? 59+t*34 : null };
    for (const key of ['latency','cpu','ram','disk']) p[`${key}_max`] = p[key] === null ? null : Math.min(key === 'latency' ? 9999 : 100, p[key] + 5);
    if (i > count-6 && m.status === 'down') { p.latency = null; p.latency_max = null; p.ok = 0; }
    return p;
  });
  return { now, monitor: m, retention_days: 7, series: { range: pwRange, from, to: now, step_ms: step, points }, checks: Array.from({length: 12}, (_,i) => ({ ts: now-i*30000, ...m.result })) };
}
showDetail = async function(id) {
  const m = dataset().monitors.find(m => m.id === id); if (!m) return;
  pwDetailId = id; pwDetailRequest++;
  $('#detail-content').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">${m.kind.toUpperCase()} · ${m.environment.toUpperCase()}</span><h2>${esc(m.name)}</h2></div><button class="icon-button" data-close="detail-dialog" aria-label="Закрыть">${icon('close')}</button></div><p class="detail-target">${esc(m.target)}${m.port ? `:${m.port}` : ''}</p><div class="live-detail-note"><span class="dot up"></span><span id="detail-freshness">Получаем свежие данные…</span></div><div id="live-monitor-summary"></div><div class="charts-heading"><h2>История показателей</h2><div class="environment-tabs" role="group" aria-label="Период графиков"><button data-range="24h" class="${pwRange === '24h' ? 'selected' : ''}" aria-pressed="${pwRange === '24h'}">24 часа</button><button data-range="7d" class="${pwRange === '7d' ? 'selected' : ''}" aria-pressed="${pwRange === '7d'}">7 дней</button></div></div><p class="chart-legend"><span>━━ Среднее</span><span>┄┄ Максимум</span><span>┄┄ Порог</span></p><div class="charts-grid" id="live-charts"></div><p class="small" id="chart-period-note"></p><details class="chart-table-details"><summary>Таблица значений графика</summary><div class="chart-table-scroll" id="chart-values"></div></details><h2 class="checks-heading">Последние 60 проверок</h2><div class="check-list" id="check-history">Загрузка…</div><div class="detail-actions" id="live-detail-actions"></div>`;
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  await pwRefreshDetail(true);
};
$('#detail-dialog').addEventListener('close', () => { pwDetailId = null; pwDetailRequest++; });
async function pwRefreshDetail(force = false) {
  if (!pwDetailId || !$('#detail-dialog').open || (pwDetailBusy && !force)) return;
  const id = pwDetailId, generation = ++pwDetailRequest; pwDetailBusy = true;
  try {
    if (!demo && !connected) throw Error('Нет связи со службой. Данные могли устареть.');
    const detail = demo ? pwDemoDetail(dataset().monitors.find(m => m.id === id)) : await api(`/api/monitors/${id}/detail?range=${pwRange}`);
    if (generation !== pwDetailRequest || pwDetailId !== id || !$('#detail-dialog').open) return;
    const m = detail.monitor;
    pwSetText('#detail-freshness', `${demo ? 'Демо · пример графиков' : 'Обновляется каждые 5 секунд'} · ${time(detail.now)}`);
    $('#live-monitor-summary').innerHTML = `<div class="detail-summary">${statusHtml(m.status)}<p>${esc(m.result?.detail || 'Ждём первую проверку')}</p></div><div class="detail-facts"><div><span>Последняя проверка</span><strong>${dateTime(m.last_checked)}</strong></div><div><span>Интервал / таймаут</span><strong>${m.interval_seconds} с / ${m.timeout_ms/1000} с</strong></div><div><span>Сбой / восстановление</span><strong>${m.failure_threshold} / ${m.recovery_threshold ?? 2} проверки</strong></div><div><span>Перегрузка / напоминания</span><strong>${m.warning_after_seconds ?? 60} с / ${m.repeat_minutes ?? 30} мин</strong></div></div>${m.status === 'maintenance' ? '<p class="maintenance-note">Идут техработы: данные собираются, уведомления отключены.</p>' : ''}${m.status === 'recovering' ? `<p class="small">Подтверждаем восстановление: ${m.successes ?? 0} из ${m.recovery_threshold ?? 2} успешных проверок без предупреждений.</p>` : ''}${m.result?.metrics ? `<div class="metrics">${[['cpu','CPU'],['ram','Память'],['disk','Диск']].map(([key,label]) => `<div class="metric ${m.result.metrics[key] >= (m[`${key}_warn`] ?? 90) ? 'metric-warning' : ''}"><span>${label}</span><strong>${number(m.result.metrics[key],1)}%</strong><progress max="100" value="${m.result.metrics[key]}" aria-label="${label}"></progress></div>`).join('')}</div>` : ''}${m.result?.tls_days != null ? `<p class="small">TLS истекает через ${m.result.tls_days} дн.</p>` : ''}`;
    $('#live-charts').innerHTML = [['latency','Время ответа','мс',m.latency_warn_ms],['cpu','CPU','%',m.cpu_warn],['ram','Память','%',m.ram_warn],['disk','Диск','%',m.disk_warn]].map(args => pwChart(detail.series, ...args)).join('');
    const valid = detail.series.points.filter(p => p.samples);
    pwSetText('#chart-period-note', `Одна точка — ${detail.series.step_ms/60000} мин. Разрывы — нет данных. Техработы включены в графики и исключены из успешности проверок. Хранение: ${detail.retention_days} дн.`);
    $('#chart-values').innerHTML = valid.length ? `<table><thead><tr><th>Время</th><th>Проверок</th><th>Отклик, мс</th><th>CPU, %</th><th>Память, %</th><th>Диск, %</th><th>Техработы</th></tr></thead><tbody>${valid.map(p => `<tr><td>${dateTime(p.ts)}</td><td>${p.samples}</td><td>${number(p.latency,1)}</td><td>${number(p.cpu,1)}</td><td>${number(p.ram,1)}</td><td>${number(p.disk,1)}</td><td>${p.suppressed}</td></tr>`).join('')}</tbody></table>` : '<p class="small">Данных за этот период пока нет.</p>';
    $('#check-history').innerHTML = detail.checks.map(c => `<div class="check-row"><span class="mono muted">${time(c.ts)}</span><span class="mono">${c.healthy ? `${c.latency} мс` : '—'}</span><span class="check-result"><span class="dot ${c.suppressed ? 'maintenance' : c.status || (c.healthy ? 'up' : 'down')}"></span>${esc(c.detail)}${c.suppressed ? ' · техработы' : ''}</span></div>`).join('') || '<p class="small">Проверок пока нет.</p>';
    const actions = $('#live-detail-actions');
    const actionState = `${demo}:${m.enabled}`;
    if (actions.dataset.state !== actionState) { actions.dataset.state = actionState; actions.innerHTML = demo ? '<p class="small">Пример данных. Добавьте свой сервер для реальных графиков.</p>' : `<button class="button secondary" data-one-check="${id}" ${m.enabled ? '' : 'disabled'}>${icon('refresh')}Проверить</button><button class="button secondary" data-edit="${id}">Изменить</button><button class="button secondary" data-pause="${id}">${m.enabled ? 'Пауза' : 'Возобновить'}</button><button class="button destructive" data-delete="${id}">Удалить</button>`; }
  } catch (e) { if (generation === pwDetailRequest) pwSetText('#detail-freshness', e.message); } finally { if (generation === pwDetailRequest) pwDetailBusy = false; }
}

$('.settings-grid').insertAdjacentHTML('afterbegin', `<section class="panel settings-card telegram-card"><span class="settings-icon">${icon('send')}</span><h2>Telegram</h2><p>Сообщения о сбое, перегрузке, восстановлении и напоминания. Токен хранится зашифрованным.</p><form id="telegram-form"><label class="toggle-line"><input id="telegram-enabled" type="checkbox"> Отправлять в Telegram</label><label>Токен бота<input id="telegram-token" type="password" autocomplete="new-password" placeholder="Токен из BotFather"></label><label>Chat ID<input id="telegram-chat" placeholder="Например, -1001234567890"></label><label class="toggle-line"><input id="telegram-only-prod" type="checkbox"> Только production</label><p class="small" id="telegram-summary"></p><p class="form-error" id="telegram-error" role="alert"></p><div class="settings-buttons"><button class="button primary" type="submit">Сохранить Telegram</button><button class="button secondary" type="button" id="telegram-test">Отправить тест</button></div></form><p class="small">Создайте бота через @BotFather, напишите ему /start или добавьте в нужную группу. Сохранение настроек не отправляет тестовое сообщение.</p></section>`);
$('.settings-grid').insertAdjacentHTML('beforeend', `<section class="panel settings-card"><span class="settings-icon">${icon('shield')}</span><h2>Резервные копии</h2><div id="backup-summary"></div><p>Автоматическая проверенная копия базы, токенов и настроек запуска. Исходные проверки продолжаются.</p><button class="button secondary" id="backup-now">Создать копию сейчас</button><p class="small">Копии находятся на машине мониторинга. Для защиты от потери диска перенесите их на отдельное хранилище.</p></section>
  <section class="panel settings-card"><span class="settings-icon">${icon('pulse')}</span><h2>Внешний наблюдатель</h2><div id="watchdog-summary"></div><p>Отдельная программа проверяет сам Pulsewatch и отправляет тревогу, если он перестал отвечать. Запускается на другой машине.</p><label>Адрес проверки<input id="watchdog-url" readonly></label><div class="settings-buttons"><button class="button secondary" id="watchdog-key-button">Показать ключ подключения</button></div><label id="watchdog-key-label" hidden>Ключ наблюдателя<input id="watchdog-key" type="password" readonly autocomplete="off"></label><p class="small">Ключ открывает только проверку состояния. Установку наблюдателя описывает инструкция.</p></section>
  <section class="panel settings-card"><span class="settings-icon">${icon('server')}</span><h2>Размещение на домене</h2><div id="deployment-summary"></div><p>Готовая установка с Caddy: HTTPS, автопродление сертификатов, автозапуск и постоянное хранилище.</p><a class="button secondary" href="/guide.html" target="_blank" rel="noopener">Открыть инструкцию</a></section>
  <section class="panel settings-card delivery-card"><span class="settings-icon">${icon('bell')}</span><h2>Доставка уведомлений</h2><p class="small">Последние 20 сообщений. Каналы имеют отдельные очереди и повторные попытки.</p><div id="delivery-list">Сообщений пока нет.</div></section>`);
renderSettings = function() {
  pwBaseSettings(); if (!data?.settings?.telegram) return;
  const s = data.settings, tg = s.telegram;
  if (!pwSettingsLoaded) { $('#telegram-enabled').checked = tg.enabled; $('#telegram-only-prod').checked = tg.only_prod; $('#telegram-chat').value = tg.chat_id; pwSettingsLoaded = true; }
  $('#telegram-token').placeholder = tg.token_configured ? 'Оставьте пустым, чтобы сохранить токен' : 'Токен из BotFather';
  $('#telegram-test').disabled = !tg.enabled;
  pwSetText('#telegram-summary', tg.enabled ? `Подключён: ${tg.chat_id}${tg.only_prod ? ' · только prod' : ' · все окружения'}` : 'Telegram выключен.');
  $('#backup-summary').innerHTML = `<div class="settings-row"><span>Расписание</span><strong>Каждые ${s.backup.interval_hours} ч</strong></div><div class="settings-row"><span>Последняя копия</span><strong>${dateTime(s.backup.last_success)}</strong></div><div class="settings-row"><span>Хранится копий</span><strong>${s.backup.keep}</strong></div>${s.backup.error ? `<p class="form-error">${esc(s.backup.error)}</p>` : ''}`;
  $('#backup-now').disabled = s.backup.running;
  $('#backup-now').textContent = s.backup.running ? 'Создаём копию…' : 'Создать копию сейчас';
  const age = s.watchdog.last_seen ? data.now - s.watchdog.last_seen : null;
  $('#watchdog-summary').innerHTML = `<p class="${age === null ? 'muted' : age > 120000 ? 'form-error' : 'good-text'}">${age === null ? 'Наблюдатель ещё не подключён' : age > 120000 ? 'Наблюдатель давно не обращался' : 'Запросы наблюдателя поступают'}</p><p class="small">Последний запрос: ${dateTime(s.watchdog.last_seen)}</p>`;
  $('#watchdog-url').value = s.watchdog.endpoint;
  $('#deployment-summary').innerHTML = `<p class="mono">${esc(s.origin)}</p><p class="small">${s.secure ? 'HTTPS настроен' : 'Сейчас HTTP'} · ${s.auth_enabled ? 'Вход по ключу' : 'Локальный доступ'}</p>`;
};
async function pwDeliveries() {
  if (view !== 'settings' || !connected) return;
  try {
    const rows = await api('/api/notifications/deliveries');
    $('#delivery-list').innerHTML = rows.map(r => `<div class="delivery-row"><div><strong>${esc(r.name)} · ${esc(r.channel)}</strong><span>${{down:'Сбой',degraded:'Перегрузка',recovered:'Восстановление',reminder:'Напоминание',test:'Тест'}[r.event] || esc(r.event)} · ${dateTime(Date.parse(r.created_at))}</span></div><span class="${r.error && !r.cancelled_at ? 'form-error' : 'small'}">${r.cancelled_at ? 'Отменено' : r.sent_at ? 'Доставлено' : r.attempts >= 5 ? 'Не доставлено' : `В очереди · попыток ${r.attempts}`}</span>${r.attempts >= 5 && !r.sent_at && !r.cancelled_at ? `<button class="text-button" data-retry-notice="${r.id}">Повторить</button>` : ''}</div>`).join('') || '<p class="small">Сообщений пока нет.</p>';
  } catch { pwSetText('#delivery-list', 'Не удалось обновить журнал доставки.'); }
}
$('#telegram-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#telegram-error').textContent = '';
  try { await api('/api/notifications', { method: 'PUT', body: JSON.stringify({ enabled: $('#telegram-enabled').checked, only_prod: $('#telegram-only-prod').checked, token: $('#telegram-token').value, chat_id: $('#telegram-chat').value }) }); $('#telegram-token').value = ''; pwSettingsLoaded = false; await poll(); toast('Настройки Telegram сохранены.'); } catch (e) { $('#telegram-error').textContent = e.message; } finally { button.disabled = false; }
});
$('#telegram-test').addEventListener('click', async () => { try { await api('/api/notifications/test', { method: 'POST' }); toast('Тест поставлен в очередь. Статус появится в журнале доставки.'); await pwDeliveries(); } catch (e) { toast(e.message, true); } });
$('#backup-now').addEventListener('click', async () => { $('#backup-now').disabled = true; try { await api('/api/backups', { method: 'POST', signal: AbortSignal.timeout(120000) }); toast('Резервная копия создана и проверена.'); await poll(); } catch (e) { toast(e.message, true); } finally { $('#backup-now').disabled = false; } });
$('#watchdog-key-button').addEventListener('click', async () => { try { const r = await api('/api/watchdog/key'); $('#watchdog-key').value = r.token; $('#watchdog-key').type = 'text'; $('#watchdog-key-label').hidden = false; setTimeout(() => { $('#watchdog-key').value = ''; $('#watchdog-key-label').hidden = true; }, 30000); } catch (e) { toast(e.message, true); } });
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.range) { pwRange = button.dataset.range; $$('[data-range]').forEach(el => { el.classList.toggle('selected', el === button); el.setAttribute('aria-pressed', String(el === button)); }); await pwRefreshDetail(true); }
  if (button.dataset.retryNotice) { try { await api(`/api/notifications/${button.dataset.retryNotice}/retry`, { method: 'POST' }); await pwDeliveries(); } catch (e) { toast(e.message, true); } }
  if (button.dataset.view === 'settings') pwDeliveries();
});
document.addEventListener('pulsewatch:update', () => { pwRefreshDetail(); pwDeliveries(); });
renderSettings();
