import { existsSync, readdirSync } from 'node:fs';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { recordRunExit } from './harness-incidents.js';
import { appendRunLedgerEntry } from '../self-implement/run-ledger.js';

const root = prodInstanceRoot();
if (effectiveInstanceRoot() !== root) throw new Error('not the effective production root');
const before = existsSync(root) ? readdirSync(root) : null;
recordRunExit({ runId: 'run-test', reason: 'signal', status: 1, signal: null, at: new Date().toISOString() }, process.argv[2] ?? root);
appendRunLedgerEntry({ runId: 'run-test', event: 'start', data: {} }, process.argv[3] ?? `${root}/run-ledger`);
const after = existsSync(root) ? readdirSync(root) : null;
console.log(JSON.stringify({ env: { NODE_ENV: process.env.NODE_ENV, ELANOUS_TEST_HOME: process.env.ELANOUS_TEST_HOME, HOME: process.env.HOME, ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR }, root, effectiveInstanceRoot: effectiveInstanceRoot(), before, after }));
