import { describe, expect, it } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppSimLiveView } from './AppSimLiveView';
import type { AppSimReceipt, AppSimLiveEvent } from './AppSimLiveView';
import type { NexusClient } from '@/nexus/client';
import type { NexusEvent } from '../../../../../src/nexus/state/state';

function renderedText(tree: ReactTestRenderer): string {
  return JSON.stringify(tree.toJSON());
}

describe('AppSimLiveView', () => {
  it('filters initial events to the selected app and shows its five newest receipts', () => {
    const receipts: AppSimReceipt[] = Array.from({ length: 6 }, (_, index) => ({
      id: `receipt-${index}`,
      createdAt: `2026-11-0${index + 1}T00:00:00.000Z`,
      outcome: index === 5 ? 'passed' : 'failed',
      summary: `실행 ${index}`,
    }));
    const events: AppSimLiveEvent[] = [{
      kind: 'app.sim.step-completed', ts: Date.parse('2026-11-07T01:00:00Z'), appId: 'voice-notes',
      data: { step: 'transcribe', message: '전사 완료' },
    }];
    const client = { subscribeEvents: () => () => {} } as unknown as Pick<NexusClient, 'subscribeEvents'>;
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<AppSimLiveView appId="voice-notes" appName="음성 노트" client={client} receipts={receipts} initialEvents={[
      ...events,
      { kind: 'app.sim.secret', ts: 1, appId: 'other-app', data: { message: 'other app event' } },
    ]} />); });
    const html = renderedText(tree);

    expect(html).toContain('사건 흐름');
    expect(html).toContain('app.sim.step-completed');
    expect(html).toContain('transcribe');
    expect(html).toContain('전사 완료');
    expect(html).toContain('receipt-5');
    expect(html).not.toContain('receipt-0');
    expect(html).not.toContain('other app event');
  });

  it('shows empty states when no events or receipts exist', () => {
    const client = { subscribeEvents: () => () => {} } as unknown as Pick<NexusClient, 'subscribeEvents'>;
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<AppSimLiveView appId="empty-app" appName="새 앱" client={client} receipts={[]} />); });
    const html = renderedText(tree);
    expect(html).toContain('시뮬레이션 사건을 기다리고 있습니다.');
    expect(html).toContain('아직 시뮬레이션 영수증이 없습니다.');
  });

  it('appends only matching live events and unsubscribes when unmounted', () => {
    let onEvent: ((event: NexusEvent) => void) | undefined;
    let unsubscribed = false;
    const client = {
      subscribeEvents: ({ onEvent: listener }: { onEvent: (event: NexusEvent) => void }) => {
        onEvent = listener;
        return () => { unsubscribed = true; };
      },
    } as unknown as Pick<NexusClient, 'subscribeEvents'>;
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<AppSimLiveView appId="voice-notes" appName="음성 노트" client={client} receipts={[]} />); });

    act(() => { onEvent?.({ kind: 'app.sim.step-completed', ts: 1, appId: 'another-app', data: { message: 'wrong app' } } as NexusEvent); });
    expect(renderedText(tree)).not.toContain('wrong app');
    act(() => { onEvent?.({ kind: 'app.sim.step-completed', ts: 2, appId: 'voice-notes', data: { message: '전사 완료' } } as NexusEvent); });
    expect(renderedText(tree)).toContain('전사 완료');
    act(() => { tree.unmount(); });
    expect(unsubscribed).toBe(true);
  });

  it('does not render the previous app event stream during an app switch', () => {
    const client = { subscribeEvents: () => () => {} } as unknown as Pick<NexusClient, 'subscribeEvents'>;
    let tree!: ReactTestRenderer;
    act(() => { tree = create(<AppSimLiveView appId="first-app" appName="첫 앱" client={client} receipts={[]} initialEvents={[
      { kind: 'app.sim.started', ts: 1, appId: 'first-app', data: { message: 'first app event' } },
    ]} />); });
    act(() => { tree.update(<AppSimLiveView appId="second-app" appName="둘째 앱" client={client} receipts={[]} />); });
    expect(renderedText(tree)).not.toContain('first app event');
    expect(renderedText(tree)).toContain('시뮬레이션 사건을 기다리고 있습니다.');
  });
});
