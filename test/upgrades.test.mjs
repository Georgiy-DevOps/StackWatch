import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { validateMonitor } from '../lib/probe.mjs';
import { inMaintenance, validateMaintenance } from '../lib/maintenance.mjs';
import { NotificationSettings, sendNotification, telegramText } from '../lib/notifications.mjs';
import { Backups } from '../lib/backups.mjs';
import { Engine } from '../lib/engine.mjs';
import { Watchdog } from '../watchdog.mjs';
import { createApp } from '../server.mjs';
import { restoreBackup } from '../deploy/restore.mjs';
import { productionConfig } from '../deploy/setup.mjs';

const cfg = (values = {}) => validateMonitor({ name: 'Production API', target: 'http://127.0.0.1:1', ...values });
const res = (status = 'up', metrics = null) => ({ healthy: status !== 'down', status, latency: 50, detail: status === 'up' ? 'OK' : status === 'down' ? 'Connection failed' : 'CPU: 95%', metrics, tls_days: null });
const channels = [{ channel: 'webhook', destination: '' }];
const folder = () => mkdtempSync(path.join(os.tmpdir(), 'pulsewatch-v2-'));

test('persistent warning duration, confirmed recovery and interruptions reset the evidence', () => {
  const store = new Store(':memory:');
  try {
    const id = store.add(cfg()), m = store.get(id), t = Date.now();
    store.record(m, res('degraded'), t, channels);
    assert.equal(store.state(id).status, 'watching');
    store.record(m, res('degraded'), t+30000, channels);
    assert.equal(store.snapshot().incidents.length, 0);
    store.record(m, res('degraded'), t+60000, channels);
    assert.equal(store.state(id).status, 'degraded');
    assert.equal(store.snapshot().incidents.length, 1);
    store.record(m, res(), t+90000, channels);
    assert.equal(store.state(id).status, 'recovering'); assert.equal(store.snapshot().incidents[0].ended_at, null);
    store.record(m, res('down'), t+120000, channels);
    store.record(m, res(), t+150000, channels);
    assert.equal(store.state(id).status, 'recovering');
    store.record(m, res(), t+180000, channels);
    assert.equal(store.state(id).status, 'up'); assert.equal(store.snapshot().incidents[0].closure, 'recovered');
    store.record(m, res('degraded'), t+210000, channels);
    store.record(m, res('degraded'), t+600000, channels);
    assert.equal(store.state(id).status, 'watching'); assert.equal(store.state(id).warning_since, t+600000);
  } finally { store.close(); }
});

test('weekly maintenance handles timezone, midnight and end-exclusive boundaries', () => {
  const maintenance = validateMaintenance({ mode:'weekly', days:[0], start_time:'23:00', end_time:'02:00', timezone:'Europe/Moscow' });
  assert.equal(inMaintenance({maintenance}, Date.parse('2026-09-13T19:59:59Z')), false);
  assert.equal(inMaintenance({maintenance}, Date.parse('2026-09-13T20:00:00Z')), true);
  assert.equal(inMaintenance({maintenance}, Date.parse('2026-09-13T22:59:59Z')), true);
  assert.equal(inMaintenance({maintenance}, Date.parse('2026-09-13T23:00:00Z')), false);
  assert.throws(() => validateMaintenance({mode:'weekly',days:[1],start_time:'10:00',end_time:'10:00',timezone:'UTC'}));
  assert.throws(() => validateMaintenance({mode:'weekly',days:[1],start_time:'10:00',end_time:'11:00',timezone:'Not/AZone'}));
  assert.throws(() => validateMaintenance({mode:'once',start_at:1000,end_at:999}));
});

test('maintenance preserves graph data, suppresses alerts, closes with the correct reason and resets failure count', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now(), id = store.add(cfg({ failure_threshold:1, maintenance:{mode:'once',start_at:now+10000,end_at:now+100000} })), m = store.get(id);
    store.record(m, res('down'), now, channels);
    assert.equal(store.snapshot().incidents.length, 1);
    store.syncMaintenance(now+10000);
    assert.equal(store.snapshot().incidents[0].closure, 'maintenance');
    assert.ok(store.db.prepare('SELECT cancelled_at FROM outbox').get().cancelled_at);
    store.record(m, res('down'), now+30000, channels);
    assert.equal(store.state(id).status, 'maintenance'); assert.equal(store.state(id).failures, 0);
    assert.equal(store.history(id)[0].suppressed, 1);
    const chart = store.series(id,'24h',now+30000);
    assert.equal(chart.points.reduce((s,p)=>s+p.samples,0), 2);
    assert.equal(chart.points.reduce((s,p)=>s+p.suppressed,0), 1);
    store.syncMaintenance(now+100000);
    assert.equal(store.state(id).status, 'unknown'); assert.equal(store.state(id).next_check, 0);
    store.record(m, res('down'), now+100001, channels);
    assert.equal(store.snapshot().incidents.filter(i=>!i.ended_at).length, 1);
  } finally { store.close(); }
});

test('reminders are durable, do not flood and stop after acknowledgement', () => {
  const store = new Store(':memory:');
  try {
    const t = Date.now(), id = store.add(cfg({ failure_threshold:1, repeat_minutes:1 })), m = store.get(id);
    store.record(m,res('down'),t,channels);
    store.remind(t+59999,channels); assert.equal(store.deliveries().length, 1);
    store.remind(t+60000,channels); store.remind(t+60001,channels);
    assert.equal(store.deliveries().length, 2); assert.equal(store.deliveries()[0].event,'reminder');
    const i = store.snapshot().incidents[0]; assert.equal(i.reminders,1);
    store.acknowledge(i.id); store.remind(t+180000,channels);
    assert.equal(store.deliveries().length, 2); assert.ok(store.deliveries()[0].cancelled_at);
  } finally { store.close(); }
});

test('24-hour and week graphs aggregate peaks and means, leave gaps, and do not invent resource data', () => {
  const store = new Store(':memory:');
  try {
    const t = Math.floor(Date.now()/3600000)*3600000+300000, id = store.add(cfg()), m = store.get(id);
    store.record(m,{...res(),latency:20,metrics:{cpu:20,ram:30,disk:40}},t-7200000);
    store.record(m,{...res(),latency:80,metrics:{cpu:80,ram:50,disk:60}},t-7200000+1000);
    store.record(m,res('down'),t-1000);
    const day = store.series(id,'24h',t), week = store.series(id,'7d',t);
    assert.equal(day.points.length,144); assert.equal(week.points.length,168);
    const two = day.points.find(p=>p.samples === 2);
    assert.equal(two.cpu,50); assert.equal(two.cpu_max,80); assert.equal(two.latency,50); assert.equal(two.latency_max,80);
    assert.equal(day.points.find(p=>p.samples === 1).latency,null);
    assert.equal(day.points.filter(p=>p.samples === 0).length,142);
    assert.throws(()=>store.series(id,'forever',t));
  } finally { store.close(); }
});

test('Telegram secrets are encrypted, blank preserves token, channel changes cancel queued deliveries', () => {
  const dir = folder(), store = new Store(path.join(dir,'db.sqlite'));
  try {
    const notifications = new NotificationSettings(store,dir);
    const token = '12345:secretTokenThatMustNeverAppear';
    notifications.save({enabled:true,token,chat_id:'-10012345678',only_prod:true});
    assert.equal(notifications.get().token,token);
    assert.ok(!JSON.stringify(store.setting('notifications')).includes(token));
    assert.ok(!JSON.stringify(notifications.public()).includes(token));
    const engine = new Engine(store,{notifications});
    assert.equal(engine.channels({environment:'dev'}).length,0);
    assert.equal(engine.channels({environment:'prod'}).length,1);
    const id = store.add(cfg({failure_threshold:1})), m = store.get(id);
    store.record(m,res('down'),Date.now(),engine.channels(m));
    notifications.save({enabled:true,token:'',chat_id:'-10098765432'});
    assert.equal(notifications.get().token,token); assert.ok(store.deliveries()[0].cancelled_at);
    assert.equal(new NotificationSettings(store,dir).get().token,token);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('Telegram sendMessage contract includes outage and recovery duration; 429 retry metadata is respected', async () => {
  const event = {event:'recovered',monitor:{name:'prod-api',environment:'prod'},message:'OK',started_at:new Date(0).toISOString(),timestamp:new Date(65000).toISOString(),duration_seconds:65};
  assert.match(telegramText(event),/Восстановление/); assert.match(telegramText(event),/1 мин 5 с/);
  let payload;
  await sendNotification({channel:'telegram',token:'12345:fakeTokenForContractTest',chat_id:'-100123'},event,{fetchImpl:async(url, options)=>{assert.equal(url,'https://api.telegram.org/bot12345:fakeTokenForContractTest/sendMessage'); payload=JSON.parse(options.body); return new Response(JSON.stringify({ok:true}),{status:200});}});
  assert.equal(payload.chat_id,'-100123'); assert.equal(payload.link_preview_options.is_disabled,true); assert.ok(!('parse_mode' in payload));
  await assert.rejects(sendNotification({channel:'telegram',token:'12345:fakeTokenForContractTest',chat_id:'-100123'},event,{fetchImpl:async()=>new Response(JSON.stringify({ok:false,parameters:{retry_after:31}}),{status:429})}),error=>error.retryAfter===31);
});

test('webhook failure does not block Telegram; channel retries remain independent', async () => {
  const dir = folder(), store = new Store(':memory:');
  try {
    const notifications = new NotificationSettings(store,dir); notifications.save({enabled:true,token:'12345:fakeTokenForQueueTest',chat_id:'123'});
    const calls=[]; const engine=new Engine(store,{notifications,webhook:'https://test.invalid',sender:async(c)=>{calls.push(c.channel);if(c.channel==='webhook')throw Error('offline');}});
    const id=store.add(cfg({failure_threshold:1})),m=store.get(id);
    store.record(m,res('down'),Date.now(),engine.channels(m)); await engine.deliver();
    assert.deepEqual(new Set(calls),new Set(['webhook','telegram']));
    assert.ok(store.deliveries().find(r=>r.channel==='telegram').sent_at);
    assert.equal(store.deliveries().find(r=>r.channel==='webhook').attempts,1);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('online backup restores history, encrypted settings and keys; existing destination remains untouched', async () => {
  const dir=folder(), dataDir=path.join(dir,'source');
  const {mkdirSync}=await import('node:fs'); mkdirSync(dataDir);
  const store=new Store(path.join(dataDir,'pulsewatch.sqlite')); let restored;
  try {
    const n=new NotificationSettings(store,dataDir); n.save({enabled:true,chat_id:'123',token:'12345:restorableSecretToken'});
    const id=store.add(cfg()),m=store.get(id); store.record(m,res());
    const backups=new Backups(store,dataDir,{runtimeConfig:{ACCESS_KEY:'private-test-key'}});
    await backups.create();
    const name=backups.status().name, source=path.join(dataDir,'backups',name), target=path.join(dir,'restored');
    assert.ok(existsSync(path.join(source,'manifest.json'))); assert.ok(backups.status().last_success);
    restoreBackup(source,target); restored=new Store(path.join(target,'pulsewatch.sqlite'));
    assert.equal(restored.all().length,1); assert.equal(restored.history(id).length,1);
    assert.equal(new NotificationSettings(restored,target).get().token,'12345:restorableSecretToken');
    assert.throws(()=>restoreBackup(source,target),/пустым/);
    assert.ok(readFileSync(path.join(source,'runtime-settings.json'),'utf8').includes('private-test-key'));
  } finally {restored?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('watchdog detects loss and recovery without the primary service, persists state and rejects stale health', async () => {
  const dir=folder(); let good=false, stale=false; const events=[]; let now=Date.now();
  const make=()=>new Watchdog({url:'http://127.0.0.1:12345/healthz',token:'read-only-test-token-long-enough',directory:dir,channels:[{channel:'webhook',url:'http://127.0.0.1:12346'}],fetchImpl:async()=>new Response(JSON.stringify({service:'pulsewatch',ok:good,timestamp:now,last_tick:now-(stale?60000:1)}),{status:good?200:503}),sender:async(_,e)=>events.push(e)});
  try {
    let watcher=make(); await watcher.check(now); now+=30000; await watcher.check(now); assert.equal(events.length,0);
    now+=30000; await watcher.check(now); assert.equal(events[0].event,'down');
    watcher=make(); assert.equal(watcher.state.status,'down');
    good=true; now+=30000; await watcher.check(now); assert.equal(events.length,1);
    now+=30000; await watcher.check(now); assert.equal(events[1].event,'recovered'); assert.equal(events[1].duration_seconds,60);
    stale=true; now+=30000; assert.equal(await watcher.check(now),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('authenticated v2 API serves live detail, guards health key, and queues Telegram tests with a local fake sender', async t => {
  const dir=folder(), sent=[];
  const app=await createApp({port:0,host:'127.0.0.1',accessKey:'',publicOrigin:'',webhook:'',telegramToken:'',telegramChatId:'',dataDir:dir,healthToken:'separate-health-key-long-enough',notificationSender:async(_,event)=>sent.push(event),autoBackup:false});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const headers={'Content-Type':'application/json',Origin:app.origin};
  const call=(route,options={})=>fetch(app.origin+route,{...options,headers:{...headers,...options.headers}});
  for(const route of ['/upgrade.js','/upgrade.css','/guide.html'])assert.equal((await call(route)).status,200);
  assert.equal((await call('/healthz')).status,401);
  const health=await call('/healthz',{headers:{Authorization:'Bearer separate-health-key-long-enough','X-Pulsewatch-Observer':'watchdog'}});assert.equal(health.status,200);
  assert.equal((await health.json()).service,'pulsewatch');
  const created=await (await call('/api/monitors',{method:'POST',body:JSON.stringify({name:'Local',target:app.origin})})).json();
  const detail=await (await call(`/api/monitors/${created.id}/detail?range=7d`)).json();
  assert.equal(detail.series.points.length,168);assert.equal(detail.monitor.name,'Local');
  const save=await call('/api/notifications',{method:'PUT',body:JSON.stringify({enabled:true,chat_id:'123',token:'12345:fakeTokenForAPITest'})});assert.equal(save.status,200);
  assert.ok(!(await save.text()).includes('fakeTokenForAPITest'));
  assert.equal((await call('/api/notifications/test',{method:'POST'})).status,202);await app.engine.deliver();
  assert.ok(sent.some(e=>e.event==='test'));
  const snapshot=await (await call('/api/snapshot')).json();assert.ok(snapshot.settings.watchdog.last_seen);assert.ok(!JSON.stringify(snapshot).includes('separate-health-key-long-enough'));
  assert.equal((await call('/api/notifications',{method:'PUT',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
});

test('production setup rejects injection and generates different login and observer keys', () => {
  assert.throws(()=>productionConfig('https://monitor.example.com'));
  assert.throws(()=>productionConfig('x.example.com\nACCESS_KEY=bad'));
  const values=Object.fromEntries(productionConfig('monitor.example.com').trim().split('\n').map(line=>line.split('=')));
  assert.equal(values.DOMAIN,'monitor.example.com');assert.ok(values.ACCESS_KEY.length>=32);assert.notEqual(values.ACCESS_KEY,values.HEALTH_TOKEN);
});

test('schema upgrades from v1 are additive and retain existing configuration and checks', () => {
  const dir=folder(),file=path.join(dir,'old.sqlite'); const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE monitors(id TEXT PRIMARY KEY,config TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
    CREATE TABLE states(monitor_id TEXT PRIMARY KEY,status TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,last_checked INTEGER,next_check INTEGER NOT NULL DEFAULT 0,result TEXT);
    CREATE TABLE checks(id INTEGER PRIMARY KEY,monitor_id TEXT NOT NULL,ts INTEGER NOT NULL,healthy INTEGER NOT NULL,status TEXT NOT NULL,latency INTEGER NOT NULL,detail TEXT NOT NULL,metrics TEXT,tls_days INTEGER);`);
  db.prepare('INSERT INTO monitors VALUES (?,?,1,?)').run('legacy',JSON.stringify({name:'Existing server',target:'http://127.0.0.1:1',kind:'http',environment:'prod',agent_token:'existing-secret',enabled:true,interval_seconds:30,timeout_ms:5000}),Date.now());
  db.exec("INSERT INTO states(monitor_id,status) VALUES ('legacy','up'); INSERT INTO checks(monitor_id,ts,healthy,status,latency,detail) VALUES('legacy',123,1,'up',8,'OK')");db.close();
  const store=new Store(file);
  try {assert.equal(store.get('legacy').agent_token,'existing-secret');assert.equal(store.get('legacy').recovery_threshold,2);assert.equal(store.history('legacy').length,1);assert.equal(store.history('legacy')[0].suppressed,0);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
