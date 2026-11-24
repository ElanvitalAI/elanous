/** Cloud lifecycle policy. Adapters must provide independent authorization, durable audit and host serialization. */
export type CloudState = 'running' | 'stopped' | 'unknown';
export type CloudAction = 'start' | 'stop' | 'repair';
export interface CloudMachine { id: string; state: CloudState; protected: boolean; lastBusyAt: number | null }
export interface CloudEvent { host: string; action: CloudAction; phase: 'requested' | 'confirmed' | 'failed'; at: number; actor: string; reason: string; state: CloudState; hourlyUsd: number | null }
export interface CloudLifecycleDeps {
  now(): number;
  authorize(host: CloudMachine, action: CloudAction, actor: string, reason: string): Promise<boolean>;
  audit(event: CloudEvent): Promise<void>;
  execute(host: CloudMachine, action: CloudAction): Promise<void>;
  probe(host: CloudMachine): Promise<CloudState>;
  /** Must serialize across all processes that can mutate this host, not just this JS instance. */
  withHostLock<T>(id: string, work: () => Promise<T>): Promise<T>;
}

/** No action without a known host, named actor, reason, authorization and a recorded request. */
export async function changeCloudMachine(host: CloudMachine, action: CloudAction, actor: string, reason: string,
  hourlyUsd: number | null, deps: CloudLifecycleDeps): Promise<CloudMachine> {
  if (!host.id.trim() || !actor.trim() || !reason.trim() || host.state === 'unknown') throw new Error('cloud lifecycle: incomplete identity or state');
  if (host.protected && (action === 'stop' || action === 'repair')) throw new Error('cloud lifecycle: protected host');
  if (hourlyUsd !== null && (!Number.isFinite(hourlyUsd) || hourlyUsd < 0)) throw new Error('cloud lifecycle: invalid cost');
  return deps.withHostLock(host.id, async () => {
    const actual = await deps.probe(host);
    if (actual === 'unknown' || actual !== host.state) throw new Error('cloud lifecycle: stale or unavailable state');
    if (!(await deps.authorize(host, action, actor, reason))) throw new Error('cloud lifecycle: not authorized');
    const event = (phase: CloudEvent['phase'], state: CloudState): CloudEvent => ({ host: host.id, action, phase, at: deps.now(), actor, reason, state, hourlyUsd });
    await deps.audit(event('requested', actual));
    try {
      await deps.execute(host, action);
      const state = await deps.probe(host);
      if (state === 'unknown' || (action === 'start' && state !== 'running') || (action === 'stop' && state !== 'stopped')) {
        throw new Error('cloud lifecycle: result not confirmed');
      }
      await deps.audit(event('confirmed', state));
      return { ...host, state };
    } catch (error) {
      await deps.audit(event('failed', 'unknown'));
      throw error;
    }
  });
}

/** Idle is actionable only with an actual busy timestamp and explicit work-free observation. */
export function idleStopEligible(host: CloudMachine, now: number, workFree: boolean): boolean {
  return !host.protected && host.state === 'running' && workFree && Number.isFinite(now)
    && host.lastBusyAt !== null && Number.isFinite(host.lastBusyAt) && now >= host.lastBusyAt
    && now - host.lastBusyAt >= 30 * 60_000;
}
