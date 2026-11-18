// WEB-FIRST-CONNECT-ONBOARDING (대표 11-17): is this device connected to the Nexus? Asked once, first, before any screen
// sends its own requests — a device without a token used to fire a dozen calls that all failed (activity error,
// project error, «socket closed 1008 auth_failed») at once.
import { DaemonClient } from '@/lib/daemon-client';
import { loadDaemonConfig, type DaemonConfig } from '@/lib/daemon-config';

export type DeviceAuth = 'connected' | 'unconnected' | 'unreachable';

// `/v1/nexus` sits behind the default-deny gate and is a cheap in-memory snapshot: 401 means «no valid token».
const PROBE_PATH = '/v1/nexus';
// 출처: OP REVIEW-2 (#38189) «~5s»; the snapshot answers in milliseconds, so a longer wait means the Nexus is not
// answering, which is not an auth answer.
export const PROBE_TIMEOUT_MS = 5_000;

export async function probeDeviceAuth(config: DaemonConfig = loadDaemonConfig(),
  client: Pick<DaemonClient, 'fetchResponse'> = new DaemonClient(config), timeoutMs: number = PROBE_TIMEOUT_MS): Promise<DeviceAuth> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    // The race also covers a fetch that ignores the signal: past the limit the answer is «unreachable».
    const response = await Promise.race([
      client.fetchResponse(PROBE_PATH, { cache: 'no-store', signal: abort.signal }),
      new Promise<never>((_, reject) => { abort.signal.addEventListener('abort', () => reject(new Error('probe timeout')), { once: true }); }),
    ]);
    if (response.status === 401) return 'unconnected';
    return response.ok ? 'connected' : 'unreachable';
  } catch {
    // Offline, the Nexus is down, or no answer within the limit: not an auth answer — the screens keep their own
    // retry and messages.
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
