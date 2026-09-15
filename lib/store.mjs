import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InputError, alarmDefaults } from './probe.mjs';
import { inMaintenance } from './maintenance.mjs';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY, config TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS states(monitor_id TEXT PRIMARY KEY, status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_checked INTEGER, next_check INTEGER NOT NULL DEFAULT 0, result TEXT);
      CREATE TABLE IF NOT EXISTS checks(id INTEGER PRIMARY KEY, monitor_id TEXT NOT NULL, ts INTEGER NOT NULL, healthy INTEGER NOT NULL, status TEXT NOT NULL, latency INTEGER NOT NULL, detail TEXT NOT NULL, metrics TEXT, tls_days INTEGER);
      CREATE INDEX IF NOT EXISTS checks_monitor_time ON checks(monitor_id,ts);
      CREATE INDEX IF NOT EXISTS checks_time ON checks(ts);
      CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, name TEXT NOT NULL, environment TEXT NOT NULL, severity TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, detail TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, closure TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_open ON incidents(monitor_id) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, sent_at INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    this.transaction(() => {
      for (const [table, columns] of Object.entries({
        states: { warning_since: 'INTEGER', failure_since: 'INTEGER', successes: 'INTEGER NOT NULL DEFAULT 0' },
        checks: { suppressed: 'INTEGER NOT NULL DEFAULT 0' },
        incidents: { last_notice: 'INTEGER NOT NULL DEFAULT 0', reminders: 'INTEGER NOT NULL DEFAULT 0' },
        outbox: { channel: "TEXT NOT NULL DEFAULT 'webhook'", destination: "TEXT NOT NULL DEFAULT ''", cancelled_at: 'INTEGER' }
      })) {
        const existing = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
        for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('PRAGMA user_version=2');
    });
    this.db.exec('UPDATE states SET next_check=0');
  }
  all() { return this.db.prepare('SELECT * FROM monitors ORDER BY created_at').all().map(r => ({ ...alarmDefaults, id: r.id, revision: r.revision, created_at: r.created_at, ...JSON.parse(r.config) })); }
  get(id) { return this.all().find(m => m.id === id); }
  state(id) { return this.db.prepare('SELECT * FROM states WHERE monitor_id=?').get(id); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  add(config) {
    if (this.all().length >= 100) throw new InputError('Можно добавить до 100 проверок.');
    return this.transaction(() => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO monitors(id,config,created_at) VALUES (?,?,?)').run(id, JSON.stringify(config), Date.now());
      this.db.prepare('INSERT INTO states(monitor_id,status) VALUES (?,?)').run(id, 'unknown');
      return id;
    });
  }
  update(id, config) {
    if (!this.get(id)) throw new InputError('Сервер не найден.', 404);
    this.transaction(() => {
      this.db.prepare('UPDATE monitors SET config=?,revision=revision+1 WHERE id=?').run(JSON.stringify(config), id);
      this.db.prepare('UPDATE states SET status=?,failures=0,successes=0,warning_since=NULL,last_checked=NULL,next_check=0,result=NULL WHERE monitor_id=?').run('unknown', id);
      this.db.prepare('UPDATE incidents SET ended_at=?,closure=? WHERE monitor_id=? AND ended_at IS NULL').run(Date.now(), config.enabled ? 'changed' : 'paused', id);
      this.cancelMonitorNotices(id);
    });
  }
  remove(id) {
    if (!this.get(id)) throw new InputError('Сервер не найден.', 404);
    this.transaction(() => {
      this.db.prepare('DELETE FROM monitors WHERE id=?').run(id);
      this.db.prepare('DELETE FROM states WHERE monitor_id=?').run(id);
      this.db.prepare('DELETE FROM checks WHERE monitor_id=?').run(id);
      this.db.prepare('UPDATE incidents SET ended_at=?,closure=? WHERE monitor_id=? AND ended_at IS NULL').run(Date.now(), 'removed', id);
      this.cancelMonitorNotices(id);
    });
  }
  record(m, result, ts = Date.now(), queueAlerts = false) {
    const current = this.get(m.id);
    if (!current || !current.enabled || current.revision !== m.revision) return;
    return this.transaction(() => {
      const previous = this.state(m.id);
      const gap = !previous.last_checked || ts - previous.last_checked > Math.max(30000, m.interval_seconds * 3000 + m.timeout_ms);
      const suppressed = inMaintenance(m, ts);
      const failures = result.healthy || suppressed ? 0 : (gap ? 0 : previous.failures) + 1;
      const failureSince = failures ? (!gap && previous.failures > 0 && previous.failure_since !== null ? previous.failure_since : ts) : null;
      const successes = result.healthy && result.status === 'up' && !suppressed ? (gap ? 0 : previous.successes) + 1 : 0;
      const warningSince = !suppressed && result.healthy && result.status === 'degraded' ? (!gap && previous.warning_since !== null ? previous.warning_since : ts) : null;
      const incident = this.db.prepare('SELECT * FROM incidents WHERE monitor_id=? AND ended_at IS NULL').get(m.id);
      let status;
      if (suppressed) status = 'maintenance';
      else if (!result.healthy) status = failures >= m.failure_threshold ? 'down' : incident?.severity ?? 'pending';
      else if (result.status === 'degraded') status = ts - warningSince >= (m.warning_after_seconds ?? 60) * 1000 ? 'degraded' : incident ? 'recovering' : 'watching';
      else status = incident && successes < (m.recovery_threshold ?? 2) ? 'recovering' : 'up';
      this.db.prepare('INSERT INTO checks(monitor_id,ts,healthy,status,latency,detail,metrics,tls_days,suppressed) VALUES (?,?,?,?,?,?,?,?,?)').run(m.id, ts, Number(result.healthy), result.status, result.latency, result.detail, result.metrics ? JSON.stringify(result.metrics) : null, result.tls_days ?? null, Number(suppressed));
      this.db.prepare('UPDATE states SET status=?,failures=?,successes=?,warning_since=?,failure_since=?,last_checked=?,next_check=?,result=? WHERE monitor_id=?').run(status, failures, successes, warningSince, failureSince, ts, ts + m.interval_seconds * 1000, JSON.stringify(result), m.id);
      let event = null;
      if (suppressed && incident) {
        this.db.prepare('UPDATE incidents SET ended_at=?,closure=? WHERE id=?').run(ts, 'maintenance', incident.id);
        this.cancelMonitorNotices(m.id, ts);
      } else if (['down', 'degraded'].includes(status)) {
        if (!incident) {
          const id = randomUUID();
          const started = status === 'down' ? failureSince ?? ts : warningSince ?? ts;
          this.db.prepare('INSERT INTO incidents(id,monitor_id,name,environment,severity,started_at,detail,last_notice) VALUES (?,?,?,?,?,?,?,?)').run(id, m.id, m.name, m.environment, status, started, result.detail, ts);
          event = { id, type: status, started_at: started };
        } else {
          this.db.prepare('UPDATE incidents SET severity=?,detail=? WHERE id=?').run(status, result.detail, incident.id);
          if (incident.severity !== status) { event = { id: incident.id, type: status, started_at: incident.started_at }; this.db.prepare('UPDATE incidents SET acknowledged=0,last_notice=? WHERE id=?').run(ts, incident.id); }
        }
      } else if (status === 'up' && incident) {
        this.db.prepare('UPDATE incidents SET ended_at=?,closure=? WHERE id=?').run(ts, 'recovered', incident.id);
        this.db.prepare("UPDATE outbox SET cancelled_at=?,error='Инцидент восстановлен' WHERE sent_at IS NULL AND cancelled_at IS NULL AND json_extract(payload,'$.incident_id')=? AND json_extract(payload,'$.event')='reminder'").run(ts, incident.id);
        event = { id: incident.id, type: 'recovered', started_at: incident.started_at, cause: incident.detail };
      }
      if (event && queueAlerts) this.enqueue(m, event, result.detail, ts, queueAlerts);
      return event;
    });
  }
  enqueue(m, event, detail, ts, channels) {
    if (channels === true) channels = [{ channel: 'webhook', destination: '' }];
    if (!Array.isArray(channels)) return;
    const payload = { event_id: randomUUID(), incident_id: event.id, event: event.type, severity: event.severity ?? event.type, monitor: { id: m.id, name: m.name, environment: m.environment }, message: detail, cause: event.cause ?? detail, duration_seconds: Math.max(0, Math.floor((ts - event.started_at) / 1000)), timestamp: new Date(ts).toISOString(), started_at: new Date(event.started_at).toISOString() };
    for (const c of channels) this.db.prepare('INSERT INTO outbox(id,payload,channel,destination) VALUES (?,?,?,?)').run(randomUUID(), JSON.stringify(payload), c.channel, c.destination);
  }
  cancelMonitorNotices(id, ts = Date.now()) { this.db.prepare("UPDATE outbox SET cancelled_at=?,error='Проверка изменена или на техработах' WHERE sent_at IS NULL AND cancelled_at IS NULL AND json_extract(payload,'$.monitor.id')=?").run(ts, id); }
  syncMaintenance(now = Date.now()) {
    for (const m of this.all().filter(m => m.enabled)) {
      const s = this.state(m.id), active = inMaintenance(m, now);
      if (active && s.status !== 'maintenance') this.transaction(() => {
        this.db.prepare("UPDATE states SET status='maintenance',failures=0,successes=0,warning_since=NULL WHERE monitor_id=?").run(m.id);
        this.db.prepare("UPDATE incidents SET ended_at=?,closure='maintenance' WHERE monitor_id=? AND ended_at IS NULL").run(now, m.id);
        this.cancelMonitorNotices(m.id, now);
      });
      if (!active && s.status === 'maintenance') this.db.prepare("UPDATE states SET status='unknown',failures=0,successes=0,warning_since=NULL,next_check=0 WHERE monitor_id=?").run(m.id);
    }
  }
  remind(now, channels) {
    for (const i of this.db.prepare('SELECT * FROM incidents WHERE ended_at IS NULL AND acknowledged=0').all()) {
      const m = this.get(i.monitor_id);
      if (!m?.enabled || !m.repeat_minutes || inMaintenance(m, now) || now - Math.max(i.last_notice, i.started_at) < m.repeat_minutes * 60000) continue;
      const destinations = typeof channels === 'function' ? channels(m) : channels;
      if (!destinations?.length) continue;
      this.transaction(() => {
        this.enqueue(m, { id: i.id, type: 'reminder', severity: i.severity, started_at: i.started_at }, i.detail, now, destinations);
        this.db.prepare('UPDATE incidents SET last_notice=?,reminders=reminders+1 WHERE id=?').run(now, i.id);
      });
    }
  }
  setting(key, fallback = null) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  snapshot(now = Date.now()) {
    const since = now - 86400000;
    const monitors = this.all().map(m => {
      const { agent_token, ...safe } = m;
      const s = this.state(m.id);
      const stats = this.db.prepare('SELECT COUNT(*) total,SUM(healthy) good,AVG(CASE WHEN healthy=1 THEN latency END) latency FROM checks WHERE monitor_id=? AND ts>=? AND suppressed=0').get(m.id, since);
      const bins = this.db.prepare("SELECT CAST((ts-?)/2400000 AS INTEGER) bucket,COUNT(*) total,SUM(healthy) good,MAX(CASE WHEN suppressed=1 THEN 3 WHEN status='down' THEN 2 WHEN status='degraded' THEN 1 ELSE 0 END) worst FROM checks WHERE monitor_id=? AND ts>=? GROUP BY bucket").all(since, m.id, since);
      const stale = m.enabled && s.last_checked !== null && now - s.last_checked > Math.max(30000, m.interval_seconds * 3000 + m.timeout_ms);
      return { ...safe, has_agent_token: Boolean(agent_token), status: !m.enabled ? 'paused' : inMaintenance(m, now) ? 'maintenance' : stale ? 'stale' : s.status, failures: s.failures, successes: s.successes, warning_since: s.warning_since, last_checked: s.last_checked, next_check: s.next_check, result: s.result ? JSON.parse(s.result) : null, checks_24h: stats.total, uptime: stats.total ? Math.round(stats.good / stats.total * 10000) / 100 : null, avg_latency: stats.latency === null ? null : Math.round(stats.latency), history: Array.from({ length: 36 }, (_, i) => { const b = bins.find(v => v.bucket === i); return b ? { status: ['up', 'degraded', 'down', 'maintenance'][b.worst], total: b.total, good: b.good } : null; }) };
    });
    const incidents = this.db.prepare('SELECT * FROM incidents ORDER BY (ended_at IS NULL) DESC,started_at DESC LIMIT 200').all();
    const pendingAlerts = this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL AND cancelled_at IS NULL AND attempts<5').get().count;
    const failedAlerts = this.db.prepare('SELECT COUNT(*) count FROM outbox WHERE sent_at IS NULL AND cancelled_at IS NULL AND attempts>=5').get().count;
    return { now, monitors, incidents, pending_alerts: pendingAlerts, failed_alerts: failedAlerts };
  }
  history(id) { return this.db.prepare('SELECT * FROM checks WHERE monitor_id=? ORDER BY ts DESC LIMIT 60').all(id).map(r => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null })); }
  series(id, range = '24h', now = Date.now()) {
    if (!['24h', '7d'].includes(range)) throw new InputError('Период: 24h или 7d.');
    const step = range === '7d' ? 3600000 : 600000, count = range === '7d' ? 168 : 144;
    const to = Math.floor(now / step) * step + step, from = to - step * count;
    const rows = this.db.prepare(`SELECT CAST((ts-?)/? AS INTEGER) bucket,COUNT(*) samples,SUM(CASE WHEN suppressed=0 THEN healthy ELSE 0 END) ok,SUM(suppressed) suppressed,
      AVG(CASE WHEN healthy=1 THEN latency END) latency,MAX(CASE WHEN healthy=1 THEN latency END) latency_max,
      AVG(json_extract(metrics,'$.cpu')) cpu,MAX(json_extract(metrics,'$.cpu')) cpu_max,
      AVG(json_extract(metrics,'$.ram')) ram,MAX(json_extract(metrics,'$.ram')) ram_max,
      AVG(json_extract(metrics,'$.disk')) disk,MAX(json_extract(metrics,'$.disk')) disk_max
      FROM checks WHERE monitor_id=? AND ts>=? AND ts<=? GROUP BY bucket`).all(from, step, id, from, now);
    const byBucket = new Map(rows.map(r => [r.bucket, r]));
    return { range, from, to: now, step_ms: step, points: Array.from({ length: count }, (_, i) => ({ ts: from + i * step, ...(byBucket.get(i) ?? { samples: 0, ok: 0, suppressed: 0, latency: null, latency_max: null, cpu: null, cpu_max: null, ram: null, ram_max: null, disk: null, disk_max: null }) })) };
  }
  deliveries() { return this.db.prepare("SELECT id,channel,attempts,sent_at,cancelled_at,error,json_extract(payload,'$.monitor.name') name,json_extract(payload,'$.event') event,json_extract(payload,'$.timestamp') created_at FROM outbox ORDER BY rowid DESC LIMIT 20").all(); }
  acknowledge(id) {
    if (!this.db.prepare('UPDATE incidents SET acknowledged=1 WHERE id=?').run(id).changes) throw new InputError('Инцидент не найден.', 404);
    this.db.prepare("UPDATE outbox SET cancelled_at=?,error='Инцидент принят' WHERE sent_at IS NULL AND cancelled_at IS NULL AND json_extract(payload,'$.incident_id')=? AND json_extract(payload,'$.event')='reminder'").run(Date.now(), id);
  }
  prune(days = 7) {
    const boundary = Date.now() - days * 86400000;
    this.db.prepare('DELETE FROM checks WHERE ts<?').run(boundary);
    this.db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at<?').run(boundary);
    this.db.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at<?').run(boundary);
  }
  close() { this.db.close(); }
}
