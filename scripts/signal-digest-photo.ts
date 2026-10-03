import type { UserConfig } from '../src/user-config.js';
import { getUserConfig } from '../src/user-config.js';
import { sendReportPhotoBuffer } from '../src/telegram-report.js';

/** The callback passed to runDigest for trading signal images. */
export function createDigestPhotoSender(
  config: () => UserConfig = getUserConfig,
  sendPhoto: typeof sendReportPhotoBuffer = sendReportPhotoBuffer,
): (png: Buffer, opts?: { caption?: string }) => Promise<boolean> {
  return (png, opts) => sendPhoto(config(), png, { ...opts, kind: 'digest' });
}
