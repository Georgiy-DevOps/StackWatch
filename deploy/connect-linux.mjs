import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as promptInterface } from 'node:readline/promises';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = 'PULSEWATCH_RESULT:';
export function decodeAgentResult(line) {
  if (!line.startsWith(prefix)) return null;
  let value;
  try { value = JSON.parse(Buffer.from(line.slice(prefix.length), 'base64').toString('utf8')); } catch { throw Error('Invalid agent setup response.'); }
  if (!/^[a-f0-9]{64}$/.test(value.token) || value.platform !== 'linux') throw Error('Invalid agent setup response.');
  return value;
}
export function connectionOptions(args) {
  const [address, user = 'root', port = '22', local = '19109'] = args;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(address ?? '') || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw Error('Usage: node deploy/connect-linux.mjs SERVER [root] [SSH_PORT] [LOCAL_PORT]');
  if (![port,local].every(v => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535) || Number(local) < 1024) throw Error('Invalid port.');
  return {address,user,port:Number(port),local:Number(local)};
}
async function assertFreePort(port) {
  await new Promise((resolve,reject) => {
    const socket = createServer();
    socket.once('error', () => reject(Error('Local tunnel port is occupied. Close the earlier tunnel or choose another local port.')));
    socket.listen(port,'127.0.0.1',() => socket.close(resolve));
  });
}
export async function connectLinux(options) {
  const {address,user,port,local} = options;
  const root = path.resolve(import.meta.dirname,'..'), data = path.join(root,'data');
  const origin = 'http://127.0.0.1:4310', target = `http://127.0.0.1:${local}/health`;
  mkdirSync(data,{recursive:true,mode:0o700});
  const status = state => writeFileSync(path.join(data,`connection-${address}.json`),JSON.stringify({state,server:address,time:new Date().toISOString()}),{mode:0o600});
  async function api(route,{method='GET',body}={}) {
    const r = await fetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body ? JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
    if (!r.ok) throw Error(`Local panel returned HTTP ${r.status}. Ensure StackWatch is running on port 4310 without a login key.`);
    return r.json();
  }
  let child, connected=false;
  try {
    await api('/api/snapshot'); await assertFreePort(local);
    const encoded = readFileSync(path.join(root,'agent.mjs')).toString('base64');
    const template = readFileSync(path.join(import.meta.dirname,'linux-bootstrap.sh'),'utf8').replace(/\r\n/g,'\n');
    const knownHosts = path.join(data,'ssh_known_hosts').replaceAll('\\','/');
    const args = ['-T','-p',String(port),'-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','ConnectTimeout=15','-o',`UserKnownHostsFile="${knownHosts}"`,'-L',`127.0.0.1:${local}:127.0.0.1:9109`,`${user}@${address}`,'bash -s'];
    console.log(`StackWatch: Linux metrics for ${address}`);
    console.log('Enter your SSH password in this window when prompted. Characters stay hidden.');
    console.log('On first connection, verify the server SSH fingerprint before accepting.');
    console.log('The installer adds a localhost-only agent and a systemd service.');
    console.log('If needed, it downloads a private Node.js 24 runtime from nodejs.org.');
    console.log('Keep this window open for local monitoring. Ctrl+C closes the tunnel.');
    status('awaiting_ssh');
    child = spawn(process.platform==='win32'?'ssh.exe':'ssh',args,{stdio:['pipe','pipe','inherit'],windowsHide:false});
    const exited = new Promise(resolve => {
      child.once('error',()=>resolve({error:true}));
      child.once('close',code=>resolve({code}));
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(`AGENT_SOURCE_BASE64='${encoded}'\n${template}\n`);
    const lines = createInterface({input:child.stdout});
    for await (const line of lines) {
      let result = decodeAgentResult(line);
      if (!result) { console.log(line); continue; }
      const r = await fetch(target,{headers:{Authorization:`Bearer ${result.token}`},signal:AbortSignal.timeout(8000)});
      if (!r.ok) throw Error('The agent started, but its health check through SSH failed.');
      const metrics = await r.json();
      if (metrics.platform!=='linux' || ![metrics.cpu,metrics.ram,metrics.disk].every(v=>Number.isFinite(v)&&v>=0&&v<=100)) throw Error('Agent metrics were invalid.');
      const name = `Linux metrics - ${address}`, snapshot = await api('/api/snapshot');
      const matching = snapshot.monitors.filter(m=>m.name===name&&m.kind==='agent'&&m.target===target);
      if (matching.length>1) throw Error('Multiple matching agent checks exist; resolve them in the panel.');
      if (matching.length===1) await api(`/api/monitors/${matching[0].id}`,{method:'PUT',body:{agent_token:result.token,enabled:true}});
      else await api('/api/monitors',{method:'POST',body:{name,kind:'agent',target,environment:'prod',agent_token:result.token,interval_seconds:30,timeout_ms:5000,failure_threshold:2,enabled:true}});
      result = null; connected=true; status('connected');
      console.log(`Connected. CPU: ${metrics.cpu}% | RAM: ${metrics.ram}% | Disk: ${metrics.disk}%`);
      console.log(`Open ${origin} - metrics update every 30 seconds.`);
    }
    const outcome = await exited;
    if (outcome.error || outcome.code!==0) throw Error('SSH connection ended. Check the message above and run the launcher again.');
  } catch (e) {
    status(connected?'disconnected':'error');
    console.error(e.message);
    process.exitCode=1;
  } finally {
    child?.kill();
    if (connected) { status('disconnected'); console.log('Tunnel closed. Run the launcher again to resume metric collection.'); }
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let args = process.argv.slice(2);
    const defaultsFile = path.resolve(import.meta.dirname,'../data/connection-default.json');
    if (!args.length && existsSync(defaultsFile)) {
      const saved = JSON.parse(readFileSync(defaultsFile,'utf8'));
      args = [saved.address,saved.user ?? 'root',String(saved.port ?? 22),String(saved.local ?? 19109)];
    }
    if (!args.length) {
      const input = promptInterface({input:process.stdin,output:process.stdout});
      try { args = [(await input.question('Linux server IP or domain: ')).trim(),'root']; } finally { input.close(); }
    }
    await connectLinux(connectionOptions(args));
  } catch(e) { console.error(e.message); process.exitCode=1; }
  const prompt=promptInterface({input:process.stdin,output:process.stdout});
  try { await prompt.question('Press Enter to close this window.'); } finally { prompt.close(); }
}
