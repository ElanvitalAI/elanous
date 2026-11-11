import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { LOOP_MESSAGE_ROUTES } from '../loops/msg-address.js';
import { runCoordinatorInbox } from '../loops/orchestrator/inbox.js';
import { runOrchestratorNode } from '../loops/orchestrator/tick.js';
import { runTrafficTick } from '../loops/orchestrator/traffic.js';
import { probeDegradation } from '../loops/orchestrator/degradation.js';
import { runSeatLoopOnce } from '../seat-loop/seat-loop.js';
import { DecisionLedger, type RaiseInput } from '../decisions/decision-ledger.js';
import { DecisionCardService, type CardRef, type CardTransport, type CardView } from '../decisions/decision-cards.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { resetUserConfig } from '../user-config.js';
import { assembleWorld, runInWorld, type SimWorld, type SimWorldSpec } from './world.js';
import { withSimClock } from './fake-clock.js';

const roots: string[] = [];
const NOW = new Date('2026-11-04T15:05:00.000Z');
const VERSION = { released: '0.3.4', dev: '0.3.5-dev.0' };

afterEach(() => {
  resetElanousConfigDir();
  resetUserConfig();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class CardTransportFixture implements CardTransport {
  readonly platform = 'telegram' as const;
  readonly sent: Array<{ chat: string; view: CardView }> = [];
  async ownerChats() { return ['tc-owner']; }
  async send(chat: string, view: CardView): Promise<CardRef> {
    this.sent.push({ chat, view });
    return { chat, message: String(this.sent.length) };
  }
  async edit() {}
  async notify() {}
}

function launchState(root: string, runId: string, cellId: string) {
  mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'seat-requests'), { recursive: true });
  writeFileSync(join(root, 'loop', 'orchestrator', `${runId}.json`), JSON.stringify({
    runId, window: '08', mode: 'live', day: '2026-11-05', cards: [], skippedCards: [],
    cells: [{ id: cellId, title: `${cellId} 운영 복구`, seat: 'TC', cardId: `card-${cellId}`, version: '0.3.5', origin: 'flow1a' }],
    placed: 1, delegated: 1, wouldDelegate: 0,
    reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
    steps: [], nodes: { intake: 'ok', split: 'ok', place: 'ok', delegate: 'ok', reconcile: 'ok' }, missing: [],
  }));
  const key = `orch:card-${cellId}:${cellId}`;
  writeFileSync(join(root, 'seat-requests', 'requests.jsonl'), `${JSON.stringify({ key, receiptId: key,
    seat: 'TC', text: `${cellId} 운영 복구`, status: 'queued', queuedAt: NOW.toISOString(), source: 'orchestrator',
    cell: cellId, version: '0.3.5' })}\n`);
}

function worldFor(root: string, remainingQuota = 0): SimWorld {
  const spec: SimWorldSpec = {
    world: 'sim-chain-ops', seed: 1104,
    devices: ['fake-kubectl', 'fake-gh', 'fake-llm', 'fake-clock'],
    clock: { start: NOW.toISOString(), speed: 1 },
    hosts: [{ name: 'node-b', arch: 'arm64', cpu: 16, pools: ['ops'], egress: false }],
    providers: { test: { remainingQuota } },
    github: { repo: 'fixture/sim-chain-ops', openPRs: 0 },
    seats: ['TC'], events: [],
  };
  return { id: spec.world, root, spec, networkEvents: [] };
}

test('SIM-CHAIN-OPS: Pod leak holds dispatch; idle traffic queues work; quota exhaustion stays observable through mail and decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sim-chain-ops-'));
  roots.push(root);
  const podRoot = root;
  const configDir = mkdtempSync(join(tmpdir(), 'sim-chain-ops-config-'));
  roots.push(configDir);
  setElanousConfigDir(configDir);
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ loops: { orchestrator: { seatCaps: { TC: 1 } } } }));

  const world = worldFor(root);
  const devices = assembleWorld(world).devices;
  const kubectl = devices.get('fake-kubectl') as {
    kubectl(args: string[]): { status: number; stdout: string };
    putPod(pod: Record<string, unknown>): void;
  };
  const gh = devices.get('fake-gh') as { run(command: string, args: readonly string[]): { status: number; stdout: string }; calls: string[][] };
  const llm = devices.get('fake-llm') as { config: Record<string, Record<string, unknown>>; response(): Promise<string> };
  const clock = devices.get('fake-clock') as { withClock: typeof withSimClock };

  await runInWorld(world, () => clock.withClock(NOW, async () => {
    // Scenario 1: a leaked TA Pod is real capacity evidence at the external Kubernetes boundary.
    kubectl.putPod({ metadata: { name: 'ta-leaked-pod', labels: { 'elanous.dev/seat': 'TC' } }, status: { phase: 'Running' } });
    const podList = JSON.parse(kubectl.kubectl(['--context', 'sim-chain-ops-node-b-context', 'get', 'pods', '-n', 'elanous-test', '-o', 'json']).stdout) as {
      items: Array<{ metadata: { name: string; labels: Record<string, string> }; status: { phase: string } }>;
    };
    expect(podList.items).toHaveLength(1);
    const leakedProcesses = podList.items.filter(pod => pod.status.phase === 'Running').map(pod => ({
      seat: pod.metadata.labels['elanous.dev/seat'] as 'TC', command: `bun bin/elanous.mjs harness ask ${pod.metadata.name}`,
      elapsedSeconds: 3_600, cwd: root,
    }));
    const runId = 'sim-pod-leak';
    launchState(podRoot, runId, 'SIM-POD-LEAK');
    let seatTurns = 0;
    const realCoordinatorInbox = (stateRoot: string) => () => {
      const store = openMsgStore(join(stateRoot, 'msg', 'messages.db'));
      try { return runCoordinatorInbox(store, 20, undefined, { knowhow: false }); }
      finally { store.close(); }
    };
    const held = await runOrchestratorNode('launch', { root: podRoot, runId, window: '08', mode: 'live', now: NOW,
      launchProcesses: () => ({ status: 'ok', records: leakedProcesses }),
      seatTurn: async () => { seatTurns++; return { status: 'queued' }; }, print: () => {}, observe: () => {},
      coordinatorInbox: realCoordinatorInbox(podRoot) });
    expect(seatTurns).toBe(0);
    expect(held.launched).toEqual([]);
    expect(held.inbox).toEqual({ replied: 0, acknowledged: 0 });
    expect(JSON.parse(readFileSync(join(podRoot, 'orchestrator', 'dispatch-ledger.jsonl'), 'utf8').trim().split('\n').at(-1)!))
      .toMatchObject({ runId, eligible: 0, skipped: { capacity: 1 } });

    // The normal seat loop consumes the launch request before traffic adds its next request.
    const consumedLaunch = await runSeatLoopOnce('TC', { root: podRoot, now: () => NOW,
      config: { mode: 'shadow', seats: ['TC'] }, versions: () => [], schedules: () => [], pendingDecisions: () => [] });
    expect(consumedLaunch).toMatchObject({ status: 'shadow', action: 'harness', item: { source: 'request', id: 'orch:card-SIM-POD-LEAK:SIM-POD-LEAK' } });

    // Scenario 2: production traffic policy sees a quiet seat and writes one durable request.
    const trafficRoot = podRoot;
    const idle = runTrafficTick({ now: NOW, processes: [{ seat: 'TC', command: 'bun bin/elanous.mjs harness say prior', elapsedSeconds: 2_400 }],
      caps: { OP: 4, TC: 4, MK: 6, UX: 6 }, openCells: [{ id: 'SIM-IDLE', title: '유휴 TC 기계의 다음 칸', owner: 'TC', status: 'yellow' }],
      mode: 'live', applyDeps: { root: trafficRoot, log: () => {} },
      finishDeps: { listStarts: () => ({ starts: [], unreadable: [] }), runGh: () => {
        const result = gh.run('gh', ['pr', 'list', '--limit', '1']);
        return result.stdout;
      } },
      collectAuthor: () => ({ seats: [], unreadable: [], receiptCounts: { held: 0, queuedForAuthor: 0 } }),
    });
    expect(idle.result.seats.find(row => row.seat === 'TC')).toMatchObject({ idle: true, nextCell: { id: 'SIM-IDLE' } });
    expect(idle.queued).toBe(1);
    const trafficRequest = JSON.parse(readFileSync(join(trafficRoot, 'seat-requests', 'requests.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { key: string };
    expect(trafficRequest)
      .toMatchObject({ seat: 'TC', source: 'orchestrator-traffic', status: 'queued' });
    expect(gh.calls.some(args => args[0] === 'pr' && args[1] === 'list')).toBe(true);
    const consumedTraffic = await runSeatLoopOnce('TC', { root: trafficRoot, now: () => NOW,
      config: { mode: 'shadow', seats: ['TC'] }, versions: () => [], schedules: () => [], pendingDecisions: () => [] });
    expect(consumedTraffic).toMatchObject({ status: 'shadow', action: 'harness', item: { source: 'request', id: trafficRequest.key } });

    // Scenario 3: an exhausted provider is measured as L1; the actual dispatcher can still route rule-based work.
    const quota = llm.config.test?.remainingQuota;
    if (typeof quota !== 'number') throw new Error('SIM-CHAIN-OPS fake-llm quota fixture is required');
    expect(await llm.response()).toContain('test-fake-llm');
    const degradation = probeDegradation(root, {
      usableLlm: () => ({ usable: Number(quota) > 0, why: 'test provider quota exhausted' }),
      board: () => ({ ok: true }),
    });
    expect(degradation).toMatchObject({ llm: false, board: true });
    const quotaRun = 'sim-quota-exhausted';
    const quotaRoot = root;
    launchState(quotaRoot, quotaRun, 'SIM-QUOTA');
    let ruleBasedTurns = 0;
    const ruleBased = await runOrchestratorNode('launch', { root: quotaRoot, runId: quotaRun, window: '08', mode: 'live', now: NOW,
      degradation: () => degradation, launchProcesses: () => ({ status: 'ok', records: [] }),
      seatTurn: async () => { ruleBasedTurns++; return { status: 'queued' }; }, print: () => {}, observe: () => {},
      coordinatorInbox: realCoordinatorInbox(quotaRoot) });
    expect(ruleBased.degradation).toEqual({ level: 1, reason: 'LLM 불가' });
    expect(ruleBasedTurns).toBe(1);

    const healthyWorld = worldFor(root, 1);
    const healthyLlm = assembleWorld(healthyWorld).devices.get('fake-llm') as { config: Record<string, Record<string, unknown>> };
    const healthyQuota = healthyLlm.config.test?.remainingQuota;
    if (typeof healthyQuota !== 'number' || healthyQuota <= 0) throw new Error('SIM-CHAIN-OPS positive quota fixture is required');
    const recovered = probeDegradation(root, {
      usableLlm: () => ({ usable: healthyQuota > 0, why: 'test provider quota available' }),
      board: () => ({ ok: true }),
    });
    expect(recovered.llm).toBe(true);
    const recoveredRoot = root;
    launchState(recoveredRoot, 'sim-quota-recovered', 'SIM-QUOTA-RECOVERED');
    const afterRecovery = await runOrchestratorNode('launch', { root: recoveredRoot, runId: 'sim-quota-recovered', window: '08', mode: 'live', now: NOW,
      degradation: () => recovered, launchProcesses: () => ({ status: 'ok', records: [] }),
      seatTurn: async () => ({ status: 'queued' }), print: () => {}, observe: () => {},
      coordinatorInbox: realCoordinatorInbox(recoveredRoot) });
    expect(afterRecovery.degradation).toBeUndefined();

    // The real report node writes hold notices; the coordinator's next real inbox pass consumes a question tied to that notice.
    const trafficPath = join(podRoot, 'traffic.json');
    const metaPath = join(podRoot, 'hold-meta.jsonl');
    writeFileSync(trafficPath, JSON.stringify({ global: 'green', hold: ['SIM-POD-LEAK'] }));
    writeFileSync(metaPath, '');
    const reportDeps = { root: podRoot, runId, window: '08' as const, mode: 'live' as const, now: NOW,
      print: () => {}, observe: () => {}, coordinatorInbox: realCoordinatorInbox(podRoot),
      hygienePaths: { trafficPath, metaPath, dispatcherDir: join(podRoot, 'dispatchers') },
      hygieneCells: () => [{ id: 'SIM-POD-LEAK', owner: 'TC', status: 'yellow', title: 'TA Pod 누수 조사' }],
      directiveAudit: { root: podRoot, dir: join(podRoot, 'directives'), listFiles: () => [], log: () => {} },
    };
    await runOrchestratorNode('report', reportDeps);
    let store = openMsgStore(join(podRoot, 'msg', 'messages.db'));
    let holdMessageId: number;
    try {
      const holdMail = store.listByRecipient('TC', 0, 100).find(message => message.kind === 'hold-hygiene' && message.body.includes('SIM-POD-LEAK'));
      expect(holdMail).toBeDefined();
      holdMessageId = holdMail!.id;
      store.append({ from: 'TC', to: LOOP_MESSAGE_ROUTES.orchestrator.msgAddress, kind: 'question',
        body: `SIM-CHAIN-OPS: choose next action for received hold notice #${holdMessageId}.` });
    } finally { store.close(); }
    const coordinator = await runOrchestratorNode('report', reportDeps);
    expect(coordinator.inbox).toEqual({ replied: 1, acknowledged: 1 });
    store = openMsgStore(join(podRoot, 'msg', 'messages.db'));
    let coordinatorReplyId: number;
    try {
      const thread = store.listByRecipient('TC', 0, 100);
      const reply = thread.find(message => message.kind === 'reply' && message.replyTo !== undefined);
      expect(reply).toBeDefined();
      coordinatorReplyId = reply!.id;
    } finally { store.close(); }

    const ledger = new DecisionLedger({ stateDir: podRoot, now: () => NOW, resolveVersion: () => VERSION as never });
    const input: RaiseInput = {
      title: 'TA Pod 용량을 회수할까요?', category: 'scope',
      scqa: { s: `운영 우편 #${holdMessageId}: Pod가 TC 한도를 점유하고 있다.`, c: `coordinator 답변 #${coordinatorReplyId}와 상태 근거를 바탕으로 회수 또는 추가 관측을 택한다.` },
      options: [{ key: 'a', label: '회수', consequence: '유휴 Pod를 정리한다' }, { key: 'b', label: '관측', consequence: '한 주기 더 기록한다' }],
      recommendation: { option: 'b', why: '소유 런 여부를 한 번 더 대조한다' },
      raisedBy: { agent: 'TC', track: 'TC' }, refs: ['SIM-CHAIN-OPS', `message:${coordinatorReplyId}`],
    };
    const entry = ledger.raise(input);
    const transport = new CardTransportFixture();
    const cards = new DecisionCardService({ transport, ownerIds: ['tc-owner'], ledger, now: () => NOW });
    expect(await cards.tick()).toEqual({ sent: 1, closed: 0, reminded: 0 });
    expect(transport.sent[0]?.view.text).toContain(entry.id);
    expect((await cards.tap('tc-owner', `dec:${entry.id}:b`)).kind).toBe('decided');
    expect(ledger.show(entry.id)).toMatchObject({ status: 'decided', choice: 'b', decidedBy: { kind: 'human' } });

    store = openMsgStore(join(podRoot, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('TC', 0, 50).some(message => message.kind === 'info' && message.body.includes(entry.id))).toBe(true);
    } finally { store.close(); }
    expect(world.networkEvents.every(event => event.blocked)).toBe(true);
  }));
});
