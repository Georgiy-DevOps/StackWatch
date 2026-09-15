import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const token = process.env.HEALTH_TOKEN || readFileSync(path.join(process.env.DATA_DIR || './data', 'health.key'), 'utf8').trim();
const port = Number(process.env.PORT || 4310);
const host = new URL(process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`).host;
const request = http.get(`http://127.0.0.1:${port}/healthz`, { headers: { Host: host, Authorization: `Bearer ${token}` }, timeout: 5000 }, response => { response.resume(); process.exitCode = response.statusCode === 200 ? 0 : 1; });
request.on('timeout', () => { request.destroy(); process.exitCode = 1; });
request.on('error', () => { process.exitCode = 1; });
