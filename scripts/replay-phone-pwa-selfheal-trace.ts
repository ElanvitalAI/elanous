import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertPhonePwaSelfHealTraceMatchesResult,
  formatPhonePwaSelfHealTrace,
  simulatePhonePwaSelfHeal,
  type PhonePwaSelfHealTrace,
} from '../src/ux-sim/phone-pwa-selfheal.js';

const tracePath = resolve(process.argv[2] ?? 'scenarios/ux-sim/phone-pwa-selfheal-trace.json');
const trace = JSON.parse(await readFile(tracePath, 'utf8')) as PhonePwaSelfHealTrace;
const fixturePath = resolve('scenarios/ux-sim/fixtures/phone-pwa-selfheal-broken.html');
const fixture = await readFile(fixturePath, 'utf8');
const simulated = simulatePhonePwaSelfHeal(fixture, { viewportWidth: trace.viewport.width, autoRepair: true });
assertPhonePwaSelfHealTraceMatchesResult(trace, simulated);
process.stdout.write(`${formatPhonePwaSelfHealTrace(trace)}\n`);
