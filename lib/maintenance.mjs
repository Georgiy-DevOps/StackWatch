import { InputError } from './probe.mjs';

export function validateMaintenance(input) {
  if (input == null || input.mode === 'off') return { mode: 'off' };
  if (input.mode === 'once') {
    if (typeof input.start_at !== 'number' || typeof input.end_at !== 'number') throw new InputError('Укажите начало и конец техработ.');
    const start_at = Number(input.start_at), end_at = Number(input.end_at);
    if (![start_at, end_at].every(Number.isSafeInteger) || start_at < 0 || end_at <= start_at || end_at - start_at > 31 * 86400000) throw new InputError('Техработы: задайте начало и конец, длительность до 31 дня.');
    return { mode: 'once', start_at, end_at };
  }
  if (input.mode !== 'weekly') throw new InputError('Неизвестное расписание техработ.');
  const days = [...new Set(input.days ?? [])];
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || !timePattern.test(input.start_time) || !timePattern.test(input.end_time) || input.start_time === input.end_time) throw new InputError('Техработы: выберите дни недели и разное время начала и конца.');
  const timezone = String(input.timezone ?? 'UTC');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new InputError('Некорректный часовой пояс.'); }
  return { mode: 'weekly', days, start_time: input.start_time, end_time: input.end_time, timezone };
}

const formatters = new Map();
export function inMaintenance(m, now = Date.now()) {
  const w = m.maintenance;
  if (!w || w.mode === 'off') return false;
  if (w.mode === 'once') return now >= w.start_at && now < w.end_at;
  if (!formatters.has(w.timezone)) formatters.set(w.timezone, new Intl.DateTimeFormat('en-US', { timeZone: w.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(formatters.get(w.timezone).formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), time = `${p.hour}:${p.minute}`;
  if (w.start_time < w.end_time) return w.days.includes(day) && time >= w.start_time && time < w.end_time;
  // Overnight windows belong to their starting day, including the Sunday/Monday boundary.
  return (w.days.includes(day) && time >= w.start_time) || (w.days.includes((day + 6) % 7) && time < w.end_time);
}
