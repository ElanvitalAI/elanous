import type { ObservatorySubject } from '@/components/observatory/subject-list';
import { DaemonClient, type DaemonLogEntry } from '@/lib/daemon-client';
import { loadDaemonConfig } from '@/lib/daemon-config';
import { buildActivitySnapshot, type ShellActivitySnapshot } from './activity-snapshot';

type TerminalsResponse = { subjects?: ObservatorySubject[] };

type ActivityFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ActivityFetchDeps = {
  fetchImpl?: ActivityFetch;
  /** The connection to ask through (defaults to the PWA's configured base URL + token). */
  client?: Pick<DaemonClient, 'fetchResponse'>;
  listProgressFrames?: () => Promise<{ logs?: DaemonLogEntry[] } | null>;
};

/**
 * WEB-CHAT-ACTIVITY-ERROR (대표 11-17): the activity strip asked `/v1/terminals` without the connection's token, so a
 * Nexus that denies by default answered 401 and the first screen showed a red «activity error». It now asks through
 * the same configured client as the chat (base URL + token, read at call time). A 401 is not an activity failure: the
 * shared auth prompt (reportAuthRequired) handles it, and the strip stays quiet.
 */
function configuredClient(): DaemonClient {
  return new DaemonClient(loadDaemonConfig());
}

export async function fetchActivitySnapshot(
  deps: ActivityFetchDeps = {},
): Promise<ShellActivitySnapshot> {
  const client = deps.fetchImpl ? undefined : deps.client ?? configuredClient();
  const fetchTerminals = (): Promise<Response> => deps.fetchImpl ? deps.fetchImpl('/v1/terminals') : client!.fetchResponse('/v1/terminals');
  // Both requests take the same path: 401 = not connected (quiet, the connect card says it); any other failure is an
  // activity error the strip shows and the next poll retries (a progress-frame failure is no longer swallowed).
  const progressPath = '/v1/logs?event=headless.progress-frame&limit=200';
  const listProgressFrames = deps.listProgressFrames
    ?? (async () => {
      const progress = await (client ?? configuredClient()).fetchResponse(progressPath);
      if (progress.status === 401) return null;
      if (!progress.ok) throw new Error(`GET /v1/logs (progress frames) failed (${progress.status})`);
      return progress.json() as Promise<{ logs?: DaemonLogEntry[] }>;
    });
  try {
    const [response, progressResponse] = await Promise.all([
      fetchTerminals().then(async (terminalResponse) => {
        if (terminalResponse.status === 401) return null;
        if (!terminalResponse.ok) {
          throw new Error(`GET /v1/terminals failed (${terminalResponse.status})`);
        }
        return terminalResponse.json() as Promise<TerminalsResponse>;
      }),
      listProgressFrames(),
    ]);
    if (response === null) return { kind: 'quiet' };
    return buildActivitySnapshot({
      status: 'ready',
      subjects: response.subjects ?? [],
      logs: progressResponse?.logs ?? [],
    });
  } catch (cause: unknown) {
    return buildActivitySnapshot({
      status: 'error',
      message: cause instanceof Error ? cause.message : 'Failed to load activity',
    });
  }
}
