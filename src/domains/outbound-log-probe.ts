import { sendOutbound, setInProcessOutbound } from './outbound-alert.js';
import { setUserConfigOverlay } from '../user-config.js';

// Focused subprocess fixture: isolated state/config roots and a fake curl on PATH.
setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
process.env.SEND_VIA_ELANOUS = '0';
setInProcessOutbound(null);
if (!sendOutbound('SECRET-BODY-DO-NOT-LOG', 'ops-alert', { channel: 'cli', surface: process.env.OUTBOUND_PROBE_SOURCE ?? 'outbound-log-probe' })) process.exitCode = 1;
