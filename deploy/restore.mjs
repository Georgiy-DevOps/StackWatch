import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, chmodSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export function restoreBackup(source, destination) {
  const input = path.resolve(source), output = path.resolve(destination);
  const manifest = JSON.parse(readFileSync(path.join(input, 'manifest.json'), 'utf8'));
  if (manifest.version !== 2 || !manifest.database_verified) throw Error('Неизвестный формат резервной копии.');
  if (existsSync(output) && readdirSync(output).length) throw Error('Каталог назначения должен быть пустым. Действующие данные не изменены.');
  const database = new DatabaseSync(path.join(input, 'pulsewatch.sqlite'), { readOnly: true });
  try {
    if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('Ошибка целостности резервной копии.');
    const settings = database.prepare("SELECT value FROM settings WHERE key='notifications'").get();
    if (settings && JSON.parse(settings.value).token_cipher && !existsSync(path.join(input, 'secrets.key'))) throw Error('В копии нет ключа шифрования Telegram.');
  } finally { database.close(); }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const name of ['pulsewatch.sqlite','secrets.key','health.key','runtime-settings.json']) if (existsSync(path.join(input,name))) { copyFileSync(path.join(input,name), path.join(output,name)); chmodSync(path.join(output,name), 0o600); }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 4) throw Error('Использование: node deploy/restore.mjs <каталог-копии> <новый-пустой-каталог-данных>'); restoreBackup(process.argv[2], process.argv[3]); console.log('Копия проверена и восстановлена. Укажите новый каталог в DATA_DIR.'); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
