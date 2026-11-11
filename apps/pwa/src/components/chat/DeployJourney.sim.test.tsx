import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeAppAuth } from '../../../../../src/ux-sim/fake-app-auth';
import { createFakeAppHost } from '../../../../../src/ux-sim/fake-app-host';
import { runAppDeploy } from '../../../../../src/agent/app-deploy-plugin';
import { createAcpConfirmChannel } from '../../../../../src/acp/acp-surface-channels';
import type { AppSimulationResult } from '../../../../../src/nexus/apps/app-simulation';
import { deployConfirmation, parseDeployResult } from '@/lib/chat-deploy';
import { DaemonClient } from '@/lib/daemon-client';
import { runChatTurnStreaming } from '@/lib/chat-runtime';
import { ChatMessageView } from './ChatMessage';
import { DeployConfirmCard } from './DeployConfirmCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('PWA 배포해줘: fake auth/host에서 N은 발행 0건, y는 공개 URL 카드까지', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pwa-deploy-sim-'));
  const originalFetch = globalThis.fetch;
  let card: ReactTestRenderer | undefined;
  try {
    const appSlug = 'lecture-scrap';
    const publicUrl = 'https://lecture-scrap--alice.elanous.app/';
    const auth = createFakeAppAuth({ dir, key: 'simulated-app-owner-signing-key-256-bits', now: () => Date.parse('2026-11-09T00:00:00Z') });
    const invitation = auth.issueInvitation({ appSlug, invitedBy: 'owner-1', role: 'owner' });
    const session = auth.acceptInvitation({ appSlug, token: invitation.token });
    expect(session.status).toBe(200);
    expect(auth.verifySession({ appSlug, token: session.cookie! })).toEqual({ status: 200, role: 'owner' });

    const host = createFakeAppHost([{ slug: appSlug, versions: [{ id: 'v1', files: { '/index.html': '<main>강의 스크랩</main>' } }] }]);
    expect(host.fetch(`${appSlug}.app.sim.invalid`, '/').status).toBe(404);
    const passed: AppSimulationResult = { runId: 'sim-run', events: [], receipts: [
      { id: 'sim-pass-1', appId: appSlug, runId: 'sim-run', outcome: 'passed', summary: 'PASS' },
    ] };
    const decisions = ['N', 'y'] as const;
    let asks = 0;
    let publishes = 0;
    let simulations = 0;
    const channel = createAcpConfirmChannel('pwa-owner-chat', async (_sessionId, payload) => {
      expect(simulations).toBe(asks + 1);
      expect(publishes).toBe(0);
      const confirmation = deployConfirmation(payload.request);
      expect(confirmation).toMatchObject({ yes: 'y', no: 'N' });
      expect(confirmation?.question).toContain('sim-pass-1');
      const html = renderToStaticMarkup(<DeployConfirmCard question={confirmation!.question} onYes={() => {}} onNo={() => {}} />);
      expect(html).toContain('공개 배포 확인');
      expect(html).toContain('기본값 N');
      let selected = '';
      await act(async () => {
        card = create(<DeployConfirmCard question={confirmation!.question}
          onYes={() => { selected = confirmation!.yes; }} onNo={() => { selected = confirmation!.no; }} />);
      });
      await act(async () => { card!.root.findAllByType('button')[decisions[asks] === 'y' ? 1 : 0]!.props.onClick(); });
      expect(selected).toBe(decisions[asks]);
      asks += 1;
      await act(async () => { card!.unmount(); });
      card = undefined;
      return { answers: { confirm: selected } };
    });
    const context = {
      surface: 'chat' as const,
      sessionId: 'pwa-owner-chat',
      verifiedOwner: { id: 'owner-1' },
      appDeploymentSession: 'nexus-owner' as const,
      appDeploymentOwner: { appSlug, memberId: 'owner-1', userSlug: 'alice', plan: 'free' as const, entitlements: {} },
      confirmChannels: [channel],
    };
    const deps = {
      simulate: async () => { simulations += 1; return passed; },
      resolveOwner: () => {
        if (auth.verifySession({ appSlug, token: session.cookie! }).role !== 'owner') throw new Error('owner session invalid');
        return 'alice';
      },
      hook: {
        publish: async () => { publishes += 1; host.deploy(appSlug, 'v1'); return { publicUrl }; },
        verifyPublicUrl: async (url: string) => url === publicUrl && host.fetch(`${appSlug}.app.sim.invalid`, '/').status === 200,
      },
    };
    const args = { appId: appSlug, requestText: '배포해줘' };
    const rejected = await runAppDeploy(args, context, deps);
    expect(rejected).toMatchObject({ kind: 'site-deploy', status: 'rejected', simulationReceipt: 'sim-pass-1' });
    expect(publishes).toBe(0);
    expect(host.fetch(`${appSlug}.app.sim.invalid`, '/').status).toBe(404);

    const published = await runAppDeploy(args, context, deps);
    expect(asks).toBe(2);
    expect(publishes).toBe(1);
    expect(published).toMatchObject({ kind: 'site-deploy', status: 'published', publicUrl, simulationReceipt: 'sim-pass-1' });
    expect(host.fetch(`${appSlug}.app.sim.invalid`, '/').body).toContain('강의 스크랩');
    const result = parseDeployResult('app_deploy', published);
    expect(result).toEqual({ status: 'published', publicUrl });
    const stream = [
      `event: turn-begin\ndata: {"sessionId":"pwa-owner-chat"}\n\n`,
      `event: tool-call\ndata: {"id":"deploy-1","name":"app_deploy","args":{"appId":"lecture-scrap"}}\n\n`,
      `event: tool-result\ndata: ${JSON.stringify({ id: 'deploy-1', name: 'app_deploy', ok: true, result: published })}\n\n`,
      `event: turn-end\ndata: {"sessionId":"pwa-owner-chat","text":"배포했습니다.","stopReason":"end_turn"}\n\n`,
    ];
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of stream) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const turn = await runChatTurnStreaming('배포해줘', {
      client: new DaemonClient({ baseUrl: 'http://fake-daemon.invalid', token: 'sim-token', provider: 'anthropic' }),
      sessionId: 'pwa-owner-chat', provider: 'anthropic', setSessionId: () => {},
    });
    expect(turn.message.blocks?.find((block) => block.kind === 'deploy_result')).toEqual({
      kind: 'deploy_result', toolId: 'deploy-1', result: result!,
    });
    const visible = renderToStaticMarkup(<ChatMessageView minimal message={turn.message} />).split('<details')[0];
    expect(visible).toContain('data-elanous-deploy-status="published"');
    expect(visible).toContain(`href="${publicUrl}"`);
    expect(visible).not.toContain('app_deploy');
  } finally {
    globalThis.fetch = originalFetch;
    if (card) await act(async () => { card!.unmount(); });
    rmSync(dir, { recursive: true, force: true });
  }
});
