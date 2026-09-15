import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionOptions, decodeAgentResult } from '../deploy/connect-linux.mjs';

test('SSH connector validates destination arguments and suppresses malformed secret responses', () => {
  assert.deepEqual(connectionOptions(['192.0.2.10']),{address:'192.0.2.10',user:'root',port:22,local:19109});
  for (const args of [['-oProxyCommand=bad'],['host','root;bad'],['host','root','0'],['host','root','22','80']]) assert.throws(()=>connectionOptions(args));
  assert.equal(decodeAgentResult('ordinary installation message'),null);
  const token='a'.repeat(64), encoded=Buffer.from(JSON.stringify({token,platform:'linux'})).toString('base64');
  assert.deepEqual(decodeAgentResult(`PULSEWATCH_RESULT:${encoded}`),{token,platform:'linux'});
  const secret='do-not-expose-this-value';
  for (const value of [secret,Buffer.from(JSON.stringify({token:secret,platform:'linux'})).toString('base64')]) {
    assert.throws(()=>decodeAgentResult(`PULSEWATCH_RESULT:${value}`),e=>e.message==='Invalid agent setup response.'&&!e.message.includes(secret));
  }
});
