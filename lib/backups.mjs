import { backup, DatabaseSync } from 'node:sqlite';
import { mkdirSync, copyFileSync, chmodSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Backups {
  constructor(store, dataDir, { directory = path.join(dataDir, 'backups'), hours = 24, keep = 7, runtimeConfig = {} } = {}) {
    this.store = store; this.dataDir = dataDir; this.directory = path.resolve(directory); this.hours = hours; this.keep = keep; this.runtimeConfig = runtimeConfig; this.active = null;
  }
  status() { return { ...this.store.setting('backup_status', { last_success: null, error: null }), running: Boolean(this.active), interval_hours: this.hours, keep: this.keep }; }
  tick(now = Date.now()) { const last = this.status(); if (!this.active && now - (last.last_attempt ?? 0) > (last.error ? 300000 : this.hours * 3600000)) this.create().catch(() => {}); }
  create() {
    if (this.active) return this.active;
    this.active = this.perform().finally(() => { this.active = null; }); return this.active;
  }
  async perform() {
    const last = this.status(), now = Date.now();
    this.store.setSetting('backup_status', { ...last, running: false, last_attempt: now });
    const name = `backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const folder = path.join(this.directory, name);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      mkdirSync(folder, { mode: 0o700 });
      const dbFile = path.join(folder, 'pulsewatch.sqlite');
      await backup(this.store.db, dbFile); chmodSync(dbFile, 0o600);
      const verify = new DatabaseSync(dbFile, { readOnly: true });
      try { if (verify.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Database verification failed'); } finally { verify.close(); }
      const key = path.join(this.dataDir, 'secrets.key');
      if (existsSync(key)) { copyFileSync(key, path.join(folder, 'secrets.key')); chmodSync(path.join(folder, 'secrets.key'), 0o600); }
      const healthKey = path.join(this.dataDir, 'health.key');
      if (existsSync(healthKey)) { copyFileSync(healthKey, path.join(folder, 'health.key')); chmodSync(path.join(folder, 'health.key'), 0o600); }
      writeFileSync(path.join(folder, 'runtime-settings.json'), JSON.stringify(this.runtimeConfig, null, 2), { mode: 0o600 });
      writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ version: 2, created_at: new Date(now).toISOString(), database_verified: true }), { mode: 0o600 });
      this.store.setSetting('backup_status', { last_attempt: now, last_success: now, name, error: null });
      const owned = readdirSync(this.directory, { withFileTypes: true }).filter(e => e.isDirectory() && /^backup-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/.test(e.name) && existsSync(path.join(this.directory, e.name, 'manifest.json'))).map(e => e.name).sort().reverse();
      for (const old of owned.slice(this.keep)) {
        const target = path.resolve(this.directory, old);
        // Only our known backup directories directly beneath the configured backup root.
        if (path.dirname(target) === this.directory && existsSync(path.join(target, 'manifest.json'))) rmSync(target, { recursive: true });
      }
      return this.status();
    } catch {
      if (path.dirname(path.resolve(folder)) === this.directory && !existsSync(path.join(folder, 'manifest.json'))) { try { rmSync(folder, { recursive: true, force: true }); } catch { /* Leave inaccessible partial data for the administrator. */ } }
      this.store.setSetting('backup_status', { ...last, running: false, last_attempt: now, error: 'Резервная копия не создана. Проверьте доступ и свободное место.' });
      throw Error('Backup failed');
    }
  }
}
