import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { openMsgStore, type MsgStore } from '../msg/msg-store.js';
import type { GraphEventBus } from './graph-events.js';
import { graphRunEventLedgerPath } from './graph-run-event-ledger.js';
import { matchesGraphSubscriptionEvent } from './graph-subscriptions.js';

export interface GraphRunMsgSubscriber {
  readonly to: string;
  readonly type: string;
  readonly match?: Readonly<Record<string, string>>;
}

function directory(root: string, graphId: string, runId: string): string {
  return join(dirname(graphRunEventLedgerPath(root, graphId, runId)), `${runId}.subscribers`);
}

function recipientFile(root: string, graphId: string, runId: string, to: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(to)) throw new Error('subscriber must be a seat address');
  return join(directory(root, graphId, runId), `${to}.json`);
}

/** A subscriber can change its filter while the runner is active; each event reads the latest declaration. */
export function saveGraphRunMsgSubscriber(root: string, graphId: string, runId: string, subscriber: GraphRunMsgSubscriber): void {
  if (!subscriber.type.trim()) throw new Error('subscriber event type is required');
  const file = recipientFile(root, graphId, runId, subscriber.to);
  if (!existsSync(join(dirname(dirname(file)), `${runId}.json`)))
    throw new Error(`no run: ${graphId}/${runId}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(subscriber)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

function subscribers(root: string, graphId: string, runId: string): GraphRunMsgSubscriber[] {
  const dir = directory(root, graphId, runId);
  if (!existsSync(dir)) return [];
  const found: GraphRunMsgSubscriber[] = [];
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
    try {
      const subscriber: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!subscriber || typeof subscriber !== 'object' || Array.isArray(subscriber) ||
          typeof (subscriber as GraphRunMsgSubscriber).to !== 'string' ||
          typeof (subscriber as GraphRunMsgSubscriber).type !== 'string' ||
          name !== `${(subscriber as GraphRunMsgSubscriber).to}.json`)
        throw new Error('invalid subscriber declaration');
      found.push(subscriber as GraphRunMsgSubscriber);
    } catch (error) {
      debug.log('graph.run-msg', 'subscriber-unreadable', { graphId, runId, file: name,
        reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }
  }
  return found;
}

/** Reuses the graph bus and graph-subscriptions matcher; idempotent msg provenance is per recipient and event. */
export function registerGraphRunMsgSubscribers(bus: GraphEventBus, scope: { graphId: string; runId: string; dryRun?: boolean },
  root: string, openStore: () => MsgStore = () => openMsgStore(join(root, 'msg', 'messages.db'))): () => void {
  let store: MsgStore | undefined;
  const unsubscribe = bus.subscribe(event => {
    if (scope.dryRun || event.graphId !== scope.graphId || event.runId !== scope.runId) return;
    try {
      for (const subscriber of subscribers(root, scope.graphId, scope.runId)) {
        if (subscriber.type !== event.type || !matchesGraphSubscriptionEvent(event, subscriber.match)) continue;
        try {
          const digest = createHash('sha256').update(`${event.eventId}\0${subscriber.to}`).digest('hex');
          const outcome = typeof event.data?.outcome === 'string' ? event.data.outcome : '-';
          (store ??= openStore()).appendWithProvenance({ from: 'GRAPH', to: subscriber.to, kind: 'progress',
            body: `Graph ${event.graphId} / run ${event.runId} · ${event.type} · node=${event.source.nodeId ?? '-'} · outcome=${outcome} · sequence=${event.sequence} · event=${event.eventId}` },
          `coord:${digest}:${subscriber.to}`);
        } catch (error) {
          debug.log('graph.run-msg', 'delivery-failed', { graphId: scope.graphId, runId: scope.runId,
            eventId: event.eventId, subscriber: subscriber.to, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        }
      }
    } catch (error) {
      debug.log('graph.run-msg', 'delivery-failed', { graphId: scope.graphId, runId: scope.runId,
        eventId: event.eventId, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }
  });
  return () => { unsubscribe(); store?.close(); };
}
