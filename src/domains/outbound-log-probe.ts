import { inQuietHours, kstMinutes, sendOutbound, setInProcessOutbound } from './outbound-alert.js';
import { setUserConfigOverlay } from '../user-config.js';

// Focused subprocess fixture: isolated state/config roots and a fake curl on PATH.
setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
process.env.SEND_VIA_ELANOUS = '0';
// Quiet hours (00:00~06:30 KST) defer instead of sending, so a gate run at night saw no `sent` row.
// Shift this fixture's clock back to 23:59 KST of the previous day; the shift stays inside this process.
const quietShiftMs = inQuietHours() ? (kstMinutes() + 1) * 60_000 : 0;
if (quietShiftMs > 0) {
  const RealDate = Date;
  const shifted = () => RealDate.now() - quietShiftMs;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(shifted());
      else super(...(args as [string | number | Date]));
    }
    static override now(): number { return shifted(); }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
setInProcessOutbound(null);
if (!sendOutbound('SECRET-BODY-DO-NOT-LOG', 'ops-alert', { channel: 'cli', surface: process.env.OUTBOUND_PROBE_SOURCE ?? 'outbound-log-probe' })) process.exitCode = 1;
