// Child fixture for test-write-guard.test.ts: a bare spy installed BEFORE outbound-alert is imported must not
// make the captured «real» curl look like a fake. Prints {refused, curlCalls}.
import { spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';

const bare = spyOn(childProcess, 'execFileSync');
const { sendTelegramDirect } = await import('../domains/outbound-alert.js');
const { getUserConfig } = await import('../user-config.js');
const base = getUserConfig();
const config = { ...base, telegram: { ...base.telegram, channels: undefined, botToken: '2:fake', homeChannel: 2 } } as typeof base;
let refused = '';
try { sendTelegramDirect('private-alert-body', 'ops-alert', { config }); } catch (e) { refused = e instanceof Error ? e.name : String(e); }
console.log(JSON.stringify({ refused, curlCalls: bare.mock.calls.length }));
