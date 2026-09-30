// Surface-unification v2 (2026-05-11) — trigger event bridge tests.

import { describe, expect, it } from 'bun:test';
import { NexusEventBus } from '../src/nexus/api/event-bus';
import {
  publishTriggerSubscribed,
  publishTriggerUnsubscribed,
  publishTriggerFired,
  setTriggerEventBus,
} from '../src/nexus/api/trigger-event-bridge';
import type { NexusEvent } from '../src/nexus/state/state';

function harness() {
  const bus = new NexusEventBus();
  const seen: NexusEvent[] = [];
  bus.subscribe((ev) => seen.push(ev), ['trigger.']);
  setTriggerEventBus(bus);
  return { bus, seen };
}

describe('trigger-event-bridge', () => {
  it('publishes trigger.subscribed with detail', () => {
    const { seen } = harness();
    publishTriggerSubscribed({ workflowName: 'wf', nodeId: 'tick', variant: 'schedule' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('trigger.subscribed');
    expect(seen[0]?.detail).toEqual({ workflowName: 'wf', nodeId: 'tick', variant: 'schedule' });
    setTriggerEventBus(null);
  });

  it('publishes trigger.unsubscribed', () => {
    const { seen } = harness();
    publishTriggerUnsubscribed({ workflowName: 'wf', nodeId: 'tick', variant: 'webhook' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('trigger.unsubscribed');
    setTriggerEventBus(null);
  });

  it('publishes trigger.fired with runId on success', () => {
    const { seen } = harness();
    publishTriggerFired({
      workflowName: 'wf',
      nodeId: 'hook',
      variant: 'webhook',
      result: { ok: true, runId: 'wf-abc-123' },
    });
    expect(seen[0]?.detail).toMatchObject({
      workflowName: 'wf',
      nodeId: 'hook',
      variant: 'webhook',
      ok: true,
      runId: 'wf-abc-123',
    });
    setTriggerEventBus(null);
  });

  it('publishes trigger.fired with error on failure', () => {
    const { seen } = harness();
    publishTriggerFired({
      workflowName: 'wf',
      nodeId: 'hook',
      variant: 'webhook',
      result: { ok: false, error: 'workflow failed' },
    });
    expect(seen[0]?.detail).toMatchObject({ ok: false, error: 'workflow failed' });
    setTriggerEventBus(null);
  });

  it('no-op when bus unwired', () => {
    setTriggerEventBus(null);
    expect(() => publishTriggerSubscribed({ workflowName: 'wf', nodeId: 'tick', variant: 'schedule' })).not.toThrow();
    expect(() => publishTriggerFired({
      workflowName: 'wf',
      nodeId: 'tick',
      variant: 'schedule',
      result: { ok: true, runId: 'r' },
    })).not.toThrow();
  });
});
