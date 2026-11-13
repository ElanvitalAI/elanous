// NEXUS PWA in-app HITL banner channel — β-1a · 2026-05-08.
//
// Pairs with `test/nexus-hitl-pushcut-channel.test.ts`. Where the
// Pushcut channel proves iPhone push-notification fan-out, this file
// proves the PWA Showroom in-app banner fan-out via the NEXUS event
// bus. Both channels share `runtimeHitlPending` — the same
// `/v1/hitl/callback/:requestId` POST resolves whichever device
// answered first.
//
// What this file proves:
//   1. Default `runNexus()` registers both 'pushcut' AND 'pwa'
//      default confirm channels (Pushcut first by convention).
//   2. `skipPwaChannel: true` opts out of the PWA channel only —
//      Pushcut still registered.
//   3. `skipPushcutChannel: true` + default skipPwaChannel:false
//      registers exactly one 'pwa' channel.
//   4. Both skip → 0 channels registered.
//   5. PWA channel's request() publishes a `hitl.banner.show` event
//      on the event bus with the prompt + requestId payload.
//   6. PWA channel's cancel() publishes `hitl.banner.cancel` when an
//      active request is in-flight.
//   7. PWA channel's awaitCallback resolves through hitlPending —
//      the same `resolveAnswer` the http-server POST handler calls.
//   8. Sequential boots leak nothing into the global registry.
//
// Real e2e via `requestConfirmation` + http-server SSE writer is
// covered by `nexus-runtime-integration.test.ts`; this file pins the
// channel-level contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import {
  getDefaultConfirmChannels,
  registerDefaultConfirmChannels,
} from '../src/hitl/confirm.js';
import { createPwaConfirmChannel, createPwaQuestionChannel } from '../src/nexus/api/hitl-pwa-channel.js';
import {
  getDefaultQuestionChannels,
  registerDefaultQuestionChannels,
} from '../src/hitl/question.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import type { NexusEvent } from '../src/nexus/state/state.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';
import {
  dispatchAskUserQuestion,
  getAskUserQuestionResolver,
  setAskUserQuestionDeps,
  setAskUserQuestionResolver,
} from '../src/ask-user-question/index.js';
import { AskQuestionBridge } from '../src/acp/ask-question-bridge.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-hitl-pwa-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.HOME = tmpRoot;
  setIntakeStoreForTest(createIntakeStore({ archiveDir: null, replayOnInit: false }));
  registerDefaultConfirmChannels([]);
  registerDefaultQuestionChannels([]);
  setAskUserQuestionDeps(null);
  setAskUserQuestionResolver(null);
});

afterEach(async () => {
  try {
    if (activeHandle) await activeHandle.release();
  } finally {
    activeHandle = undefined;
    if (prevNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
    else process.env.ELANOUS_NEXUS_DIR = prevNexusDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    setIntakeStoreForTest(null);
    registerDefaultConfirmChannels([]);
    registerDefaultQuestionChannels([]);
    setAskUserQuestionDeps(null);
    setAskUserQuestionResolver(null);
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function uniquePort(): number {
  return 53000 + Math.floor(Math.random() * 2000);
}

async function bootNexus(extra: Parameters<typeof runNexus>[0] = {}): Promise<RunNexusHandle> {
  const handle = await runNexus({
    detachForTesting: true,
    skipHttpServer: true,
    skipRuntimeApi: false,
    skipSupervisor: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    httpStartPort: uniquePort(),
    voiceAdapter: createStubPwaVoiceAdapter(),
    toolCwd: tmpRoot,
    ...extra,
  });
  if (!handle) throw new Error('runNexus returned undefined');
  activeHandle = handle;
  return handle;
}

describe('NEXUS PWA HITL channel · runNexus integration', () => {
  test('default boot registers pushcut + pwa (in that order)', async () => {
    await bootNexus();
    const channels = getDefaultConfirmChannels();
    expect(channels.map((c) => c.name)).toEqual(['pushcut', 'pwa']);
  });

  test('skipPwaChannel:true keeps only pushcut', async () => {
    await bootNexus({ skipPwaChannel: true });
    const channels = getDefaultConfirmChannels();
    expect(channels.map((c) => c.name)).toEqual(['pushcut']);
  });

  test('skipPushcutChannel:true keeps only pwa', async () => {
    await bootNexus({ skipPushcutChannel: true });
    const channels = getDefaultConfirmChannels();
    expect(channels.map((c) => c.name)).toEqual(['pwa']);
  });

  test('both skip flags → no channels registered', async () => {
    await bootNexus({ skipPushcutChannel: true, skipPwaChannel: true });
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('release() clears both default channels', async () => {
    const h = await bootNexus();
    expect(getDefaultConfirmChannels()).toHaveLength(2);
    await h.release();
    activeHandle = undefined;
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('skipRuntimeApi:true short-circuits both channel registrations', async () => {
    await bootNexus({ skipRuntimeApi: true });
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('two sequential boots — no inherited channel from prior NEXUS', async () => {
    const h1 = await bootNexus();
    expect(getDefaultConfirmChannels()).toHaveLength(2);
    await h1.release();
    activeHandle = undefined;
    expect(getDefaultConfirmChannels()).toHaveLength(0);

    await bootNexus();
    expect(getDefaultConfirmChannels()).toHaveLength(2);
  });
});

describe('createPwaConfirmChannel · channel contract', () => {
  function captureBus() {
    const bus = new NexusEventBus();
    const events: NexusEvent[] = [];
    bus.subscribe((ev) => events.push(ev));
    return { bus, events };
  }

  test('request() publishes hitl.banner.show with prompt + requestId', async () => {
    const { bus, events } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      // Hold forever — we only inspect the publish, not the resolution.
      awaitCallback: () => new Promise(() => {}),
      mintRequestId: () => 'req-fixed',
    });

    void channel.request({
      prompt: 'Approve file edit?',
      detail: 'src/foo.ts (modify)',
      yesLabel: 'Approve',
      noLabel: 'Deny',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('hitl.banner.show');
    expect(events[0]!.detail).toMatchObject({
      requestId: 'req-fixed',
      prompt: 'Approve file edit?',
      detail: 'src/foo.ts (modify)',
      yesLabel: 'Approve',
      noLabel: 'Deny',
    });
  });

  test('request() honors caller-supplied requestId', async () => {
    const { bus, events } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => new Promise(() => {}),
    });

    void channel.request({
      prompt: 'OK?',
      requestId: 'caller-supplied-42',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(events[0]!.detail).toMatchObject({ requestId: 'caller-supplied-42' });
  });

  test('request() defaults yes/no labels when caller omits them', async () => {
    const { bus, events } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => new Promise(() => {}),
      mintRequestId: () => 'req-defaults',
    });

    void channel.request({ prompt: 'Continue?' });

    await new Promise((r) => setTimeout(r, 0));
    expect(events[0]!.detail).toMatchObject({
      yesLabel: 'Yes',
      noLabel: 'No',
    });
    expect((events[0]!.detail as Record<string, unknown>)['detail']).toBeUndefined();
  });

  test('cancel() publishes hitl.banner.cancel for the active request', async () => {
    const { bus, events } = captureBus();
    let resolveCallback: (a: boolean | null) => void = () => {};
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => new Promise<boolean | null>((r) => { resolveCallback = r; }),
      mintRequestId: () => 'req-cancel',
    });

    void channel.request({ prompt: 'OK?' });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('hitl.banner.show');

    channel.cancel();
    expect(events).toHaveLength(2);
    expect(events[1]!.kind).toBe('hitl.banner.cancel');
    expect(events[1]!.detail).toMatchObject({ requestId: 'req-cancel' });

    // Idempotent — second cancel after activeRequestId cleared is a
    // no-op so a sibling-channel race doesn't double-fire the event.
    channel.cancel();
    expect(events).toHaveLength(2);

    // Resolve the dangling await so the test doesn't leak.
    resolveCallback(null);
  });

  test('cancel() before any request is a no-op', () => {
    const { bus, events } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => new Promise(() => {}),
    });
    channel.cancel();
    expect(events).toHaveLength(0);
  });

  test('request() resolves with the awaitCallback answer (true)', async () => {
    const { bus } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => Promise.resolve(true),
      mintRequestId: () => 'req-yes',
    });

    const answer = await channel.request({ prompt: 'OK?' });
    expect(answer).toBe(true);
  });

  test('request() resolves with null when awaitCallback returns null (sibling owns pending)', async () => {
    const { bus } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => Promise.resolve(null),
      mintRequestId: () => 'req-null',
    });

    const answer = await channel.request({ prompt: 'OK?' });
    expect(answer).toBeNull();
  });

  test('request() returning null leaves activeRequestId set so cancel() still fires', async () => {
    // Mirrors the sibling-channel-wins case: PWA's awaitCallback got
    // null because Pushcut already held the pending entry, but the
    // banner is still showing in the PWA. confirm.ts cancel() must
    // dismiss it.
    const { bus, events } = captureBus();
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => Promise.resolve(null),
      mintRequestId: () => 'req-null-keep-active',
    });

    const answer = await channel.request({ prompt: 'OK?' });
    expect(answer).toBeNull();
    expect(events.find((e) => e.kind === 'hitl.banner.show')).toBeDefined();

    channel.cancel();
    const cancelEvents = events.filter((e) => e.kind === 'hitl.banner.cancel');
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]!.detail).toMatchObject({ requestId: 'req-null-keep-active' });
  });

  test('bus.publish failure does not crash request()', async () => {
    const bus = new NexusEventBus();
    // Shimming bus.publish to throw simulates a downstream consumer
    // wrapper failure (rare but possible). The channel must still
    // return the awaitCallback answer.
    bus.publish = () => { throw new Error('bus down'); };
    const channel = createPwaConfirmChannel({
      bus,
      awaitCallback: () => Promise.resolve(true),
      mintRequestId: () => 'req-bus-throws',
    });

    const answer = await channel.request({ prompt: 'OK?' });
    expect(answer).toBe(true);
  });
});

describe('PWA channel ⇄ runtimeHitlPending integration', () => {
  test('boot exposes hitlPending for the PWA channel to delegate through', async () => {
    const h = await bootNexus();
    expect(h.hitlPending).toBeDefined();
    expect(typeof h.hitlPending!.awaitCallback).toBe('function');
    expect(typeof h.hitlPending!.resolveAnswer).toBe('function');

    // Direct round-trip: the PWA channel registered above wraps the
    // same hitlPending. Resolving the requestId via resolveAnswer
    // unblocks any awaiter — proving channel ⇄ http-server share.
    const reqId = `rid-${Date.now()}`;
    const pending = h.hitlPending!.awaitCallback(reqId, 1_000);
    const fired = h.hitlPending!.resolveAnswer(reqId, true);
    expect(fired).toBe(true);
    await expect(pending).resolves.toBe(true);
  });
});

describe('NEXUS PWA question channel · runNexus wiring', () => {
  test('default boot registers a pwa question channel on the existing SSE topic', async () => {
    await bootNexus();
    expect(getDefaultQuestionChannels().map((c) => c.name)).toEqual(['pwa']);
  });

  test('skipPwaChannel:true leaves the question registry empty', async () => {
    await bootNexus({ skipPwaChannel: true });
    expect(getDefaultQuestionChannels()).toHaveLength(0);
  });

  test('skipRuntimeApi:true short-circuits question channel registration', async () => {
    await bootNexus({ skipRuntimeApi: true });
    expect(getDefaultQuestionChannels()).toHaveLength(0);
  });

  test('release() clears the question channel registry', async () => {
    const h = await bootNexus();
    expect(getDefaultQuestionChannels()).toHaveLength(1);
    await h.release();
    activeHandle = undefined;
    expect(getDefaultQuestionChannels()).toHaveLength(0);
  });

  const threeOptionReq = {
    questions: [{
      id: 'pick',
      header: 'Pick',
      question: 'A, B, or C?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
        { label: 'C', description: 'third' },
      ],
    }],
  };

  test('ACP-less boot installs a resolver that reaches the registered PWA channel', async () => {
    const h = await bootNexus();
    expect(getAskUserQuestionResolver()).not.toBeNull();
    const unsub = h.eventBus.subscribe(() => {}, ['hitl.banner.']);
    const pending = dispatchAskUserQuestion(threeOptionReq);
    await new Promise((r) => setTimeout(r, 20));
    const pendingIds = h.hitlPending!.pending();
    expect(pendingIds.length).toBeGreaterThanOrEqual(1);
    expect(h.hitlPending!.resolveAnswer(pendingIds[0]!, { answers: { pick: 'B' } })).toBe(true);
    const r = await pending;
    unsub();
    expect(r.output).not.toMatch(/no resolver hook/);
    expect(r.result).toEqual({ answers: { pick: 'B' } });
    expect(r.absenceReason).toBeUndefined();
  });

  test('empty question registry returns structured failure immediately via requestQuestion', async () => {
    await bootNexus({ skipPwaChannel: true });
    expect(getAskUserQuestionResolver()).not.toBeNull();
    expect(getDefaultQuestionChannels()).toHaveLength(0);
    const started = Date.now();
    const r = await dispatchAskUserQuestion(threeOptionReq);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.output).not.toMatch(/no resolver hook/);
    expect(r.result).toEqual({ answers: {}, cancelled: true });
  });

  test('ACP onHandle replacement still takes precedence over the default resolver', async () => {
    await bootNexus();
    const pushAskRequestCalls: Array<{ sessionId: string; payload: unknown }> = [];
    const bridge = new AskQuestionBridge({
      handle: {
        async pushAskRequest(sessionId, payload) {
          pushAskRequestCalls.push({ sessionId, payload });
          return { answers: { pick: 'ACP' } };
        },
        async pushAskCancel() {},
      },
    });
    // Same replacement the production ACP onHandle performs.
    setAskUserQuestionResolver(bridge.resolve);
    const r = await dispatchAskUserQuestion(threeOptionReq, { sessionId: 'sess-acp' });
    expect(pushAskRequestCalls).toHaveLength(1);
    expect(pushAskRequestCalls[0]!.sessionId).toBe('sess-acp');
    expect(r.result).toMatchObject({ answers: { pick: 'ACP' } });
  });

  test('release() does not clear a resolver it did not install', async () => {
    const prior = async () => ({ answers: { pick: 'prior' } });
    setAskUserQuestionResolver(prior);
    const h = await bootNexus();
    expect(getAskUserQuestionResolver()).toBe(prior);
    await h.release();
    activeHandle = undefined;
    expect(getAskUserQuestionResolver()).toBe(prior);
  });

  test('release() clears the default resolver this boot installed', async () => {
    const h = await bootNexus();
    expect(getAskUserQuestionResolver()).not.toBeNull();
    await h.release();
    activeHandle = undefined;
    expect(getAskUserQuestionResolver()).toBeNull();
  });
});

describe('createPwaQuestionChannel · structured options are enclosed, not folded', () => {
  const threeOptionReq = {
    questions: [{
      id: 'pick',
      header: 'Pick',
      question: 'A, B, or C?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
        { label: 'C', description: 'third' },
      ],
    }],
  };

  test('ask() publishes hitl.banner.show with all three options on the existing topic', async () => {
    const bus = new NexusEventBus();
    const events: NexusEvent[] = [];
    bus.subscribe((ev) => events.push(ev), ['hitl.banner.']);
    const channel = createPwaQuestionChannel({
      bus,
      awaitCallback: () => new Promise(() => {}),
      mintRequestId: () => 'q-three',
    });

    void channel.ask(threeOptionReq);
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('hitl.banner.show');
    expect(events[0]!.detail).toMatchObject({
      requestId: 'q-three',
      prompt: 'A, B, or C?',
      questions: threeOptionReq.questions,
    });
    const detail = events[0]!.detail as { questions: typeof threeOptionReq.questions; yesLabel?: string };
    expect(detail.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(detail.yesLabel).toBeUndefined();
  });

  test('ask() resolves with the second option value, correlated by requestId', async () => {
    const bus = new NexusEventBus();
    const channel = createPwaQuestionChannel({
      bus,
      awaitCallback: (requestId) => {
        expect(requestId).toBe('q-second');
        return Promise.resolve({ answers: { pick: 'B' } });
      },
      mintRequestId: () => 'q-second',
    });
    const result = await channel.ask(threeOptionReq);
    expect(result).toEqual({ answers: { pick: 'B' } });
  });

  test('two in-flight asks: answering one requestId leaves the other pending', async () => {
    const bus = new NexusEventBus();
    const resolvers = new Map<string, (value: { answers: Record<string, string> } | null) => void>();
    let n = 0;
    const channel = createPwaQuestionChannel({
      bus,
      awaitCallback: (requestId) => new Promise((resolve) => { resolvers.set(requestId, resolve); }),
      mintRequestId: () => (n += 1) === 1 ? 'q-one' : 'q-two',
    });
    const first = channel.ask(threeOptionReq);
    const second = channel.ask({
      questions: [{
        id: 'other',
        header: 'Other',
        question: 'X or Y?',
        options: [
          { label: 'X', description: 'x' },
          { label: 'Y', description: 'y' },
        ],
      }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvers.has('q-one')).toBe(true);
    expect(resolvers.has('q-two')).toBe(true);
    resolvers.get('q-two')!({ answers: { other: 'Y' } });
    await expect(second).resolves.toEqual({ answers: { other: 'Y' } });
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(firstSettled).toBe(false);
    resolvers.get('q-one')!({ answers: { pick: 'A' } });
    await expect(first).resolves.toEqual({ answers: { pick: 'A' } });
  });
});
