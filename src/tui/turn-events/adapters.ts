import { debug } from '../../debug/log.js';
import type { CapsuleDoneEvent, TurnEvent, TurnEventBus } from '../../turn-capsule/contract.js';

/** Source adapters publish watch and capsule completion events to the turn bus. */
export function createCapsuleEventAdapters(deps: {
  bus: TurnEventBus;
  offer: () => void;
  log?: (name: string, data: Record<string, unknown>) => void;
}) {
  const log = deps.log ?? ((name, data) => debug.log('turn-life', name, data));
  const publish = (event: TurnEvent): { readonly duplicate: boolean } => {
    const result = deps.bus.publish(event);
    if (!result.duplicate) {
      try { log('event-arrived', { eventId: event.id, source: event.source, capsuleId: event.capsule?.capsuleId, arrivedAt: event.arrivedAt }); }
      catch { /* observation cannot stop delivery */ }
      deps.offer();
    }
    return result;
  };
  return {
    watch(input: { id: string; text: string; at: number }) {
      const id = `watch:${input.id}`;
      return publish({ id, source: 'watch', dedupeKey: id, arrivedAt: input.at, text: input.text });
    },
    done(capsule: CapsuleDoneEvent) {
      // Encoding prevents separators in upstream identifiers from creating collisions.
      const id = `capsule-done:${encodeURIComponent(capsule.sessionId)}:${encodeURIComponent(capsule.capsuleId)}`;
      return publish({ id, source: 'capsule-done', dedupeKey: id, arrivedAt: capsule.endedAt, text: capsule.summary, capsule });
    },
  };
}
