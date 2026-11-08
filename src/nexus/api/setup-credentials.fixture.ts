import { setElanousConfigDir } from '../../elanous-config-dir.js';
import { commitCredentialRegistrationBearer } from '../../auth/setup-link-tokens.js';
import { hasCredentialSlotWriteReceipt, writeCredentialSlotBatchValue } from '../config/secrets/registry.js';

const [dir, bearer, slot, value, now, phase] = process.argv.slice(2);
if (!dir || !bearer || !slot || value === undefined || !now || (phase !== 'before-write' && phase !== 'after-write')) throw new Error('missing interruption fixture arguments');
setElanousConfigDir(dir);
commitCredentialRegistrationBearer(bearer, slot, value, (receipt) => {
  if (phase === 'after-write') writeCredentialSlotBatchValue({ [slot]: value }, receipt);
  process.kill(process.pid, 'SIGKILL');
}, { dir, now: Number(now), isCommitted: hasCredentialSlotWriteReceipt });
throw new Error('interruption fixture unexpectedly survived commit');
