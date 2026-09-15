import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { domainToASCII, fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

export function productionConfig(value) {
  const domain = domainToASCII(String(value).trim().toLowerCase());
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw Error('Укажите домен без протокола, порта и пути, например monitor.example.com.');
  return `DOMAIN=${domain}\nACCESS_KEY=${randomBytes(24).toString('hex')}\nHEALTH_TOKEN=${randomBytes(32).toString('hex')}\nRETENTION_DAYS=7\nBACKUP_HOURS=24\nBACKUP_KEEP=7\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), filename = path.join(root, '.env.production');
    if (existsSync(filename)) throw Error('.env.production уже существует. Настройки сохранены; измените файл вручную при необходимости.');
    let domain = process.argv.slice(2).find(v => v !== '--start');
    if (!domain) { const input = createInterface({ input: process.stdin, output: process.stdout }); try { domain = await input.question('Домен панели: '); } finally { input.close(); } }
    writeFileSync(filename, productionConfig(domain), { flag: 'wx', mode: 0o600 });
    console.log('Настройки и ключи сохранены в .env.production. ACCESS_KEY используется для входа.');
    console.log('До запуска направьте DNS на сервер и откройте TCP 80/443.');
    if (process.argv.includes('--start')) {
      const child = spawn('docker', ['compose', '--env-file', '.env.production', '-f', 'compose.production.yaml', 'up', '-d', '--build'], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.on('error', () => { console.error('Не удалось запустить Docker. Проверьте установку и повторите команду из инструкции.'); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    } else console.log('Запуск: docker compose --env-file .env.production -f compose.production.yaml up -d --build');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
