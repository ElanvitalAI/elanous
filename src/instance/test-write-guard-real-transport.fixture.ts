// Child fixture for test-write-guard.test.ts (TEST-PROD-LEAK-2 ledger): call-through wrappers installed over
// the ORIGINAL spill and send functions must not soften the outbound-alert guard. spillLongContent gets a
// mock.module call-through wrapper (not a fake — it delegates to the original) that counts operational S3
// upload attempts, and the original curl send primitive gets a bare pass-through spy that counts external
// sends. The refusal must fire BEFORE spillLongContent runs, so the ledger prints 0 s3Uploads and 0
// curlCalls alongside the refusal reason. Prints {refused, refusalReason, curlCalls, s3Uploads}.
import { mock, spyOn } from 'bun:test';
import * as childProcess from 'node:child_process';

// Pass-through wrapper over the original external-send primitive (curl via execFileSync), installed before
// outbound-alert is imported so even the module-load capture of the «real» sender sees a wrapper, not a fake.
const sendWrapper = spyOn(childProcess, 'execFileSync');

const spill = await import('../storage/content-spill.js');
const originalSpill = spill.spillLongContent;
let s3Uploads = 0;
await mock.module('../storage/content-spill.js', () => ({
  ...spill,
  spillLongContent: (...args: Parameters<typeof originalSpill>) => {
    s3Uploads += 1; // every spill that reaches the original is an operational S3 upload attempt
    return originalSpill(...args);
  },
}));

const { sendTelegramDirect } = await import('../domains/outbound-alert.js');
const { getUserConfig } = await import('../user-config.js');
const base = getUserConfig();
const config = { ...base, telegram: { ...base.telegram, channels: undefined, botToken: '2:fake', homeChannel: 2 } } as typeof base;
type DirectDeps = NonNullable<Parameters<typeof sendTelegramDirect>[2]>;
const deps = { config } as DirectDeps;
// LEAK2_INJECT_SENDRAW=1 also injects a real (non-test-double) send transport into the delivery deps — a
// plain curl-invoking function, no mock scaffolding — so the companion ledger proves the guard refuses an
// injected external transport, not merely an empty one.
if (process.env.LEAK2_INJECT_SENDRAW === '1') {
  (deps as { sendRaw?: (url: string) => string }).sendRaw = (url) =>
    childProcess.execFileSync('curl', ['-sS', url], { encoding: 'utf8' }) as string;
  // An injected transport turns the external branch off (:710 — a test double cannot target the ops
  // universe), so the companion ledger proves the ops-routed branch: the routing roots resolve inside the
  // ops universe, exactly as production does, and the guard refuses it faked or not.
  const { EXTRA_OPS_ROOTS_ENV } = await import('../instance/test-write-guard.js');
  const { getElanousConfigDir } = await import('../elanous-config-dir.js');
  process.env[EXTRA_OPS_ROOTS_ENV] = getElanousConfigDir();
}
let refused = false;
let refusalReason = '';
try {
  sendTelegramDirect('private-alert-body', 'ops-alert', deps);
} catch (e) {
  refused = true;
  refusalReason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
console.log(JSON.stringify({ refused, refusalReason, curlCalls: sendWrapper.mock.calls.length, s3Uploads }));
