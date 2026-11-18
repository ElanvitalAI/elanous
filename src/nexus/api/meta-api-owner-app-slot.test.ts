// WEBCHAT-OWNER-APPSLUG-WIRING: a web chat turn hands its tools the verified member's own app slot (from the server member
// store, by the verified id) so a one-line app_build can fill its slot. Expectations are literals (rule 11).
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { DaemonSessionHistory } from '../../boot/daemon-runtime.js';
import * as coreTurnModule from '../../core-turn/run-core-turn.js';
import type { DaemonToolDispatchCtx } from '../../boot/daemon-tools/types.js';
import { handlePromptPost, handlePromptStreamPost, ownerWithAppSlot } from './meta-api.js';

afterEach(() => { mock.restore(); });

describe('ownerWithAppSlot', () => {
  test('no owner: nothing, and the store is never asked', () => {
    const asked: string[] = [];
    expect(ownerWithAppSlot(undefined, { memberAppSlot: (id) => { asked.push(id); return 'concert-a'; } })).toBeUndefined();
    expect(asked).toEqual([]);
  });
  test('an owner with a slot gets it; without one, the id alone', () => {
    const slots: Record<string, string> = { 'member-a': 'concert-a' };
    const memberAppSlot = (id: string) => (Object.hasOwn(slots, id) ? slots[id] : undefined);
    expect(ownerWithAppSlot({ id: 'member-a' }, { memberAppSlot })).toEqual({ id: 'member-a', appSlug: 'concert-a' });
    expect(ownerWithAppSlot({ id: 'member-b' }, { memberAppSlot })).toEqual({ id: 'member-b' });
    expect(ownerWithAppSlot({ id: 'member-a' }, {})).toEqual({ id: 'member-a' });
  });
  test('a blank slot or a failing store read is «no slot» (app_build then says needs_connection)', () => {
    expect(ownerWithAppSlot({ id: 'member-a' }, { memberAppSlot: () => '  ' })).toEqual({ id: 'member-a' });
    expect(ownerWithAppSlot({ id: 'member-a' }, { memberAppSlot: () => { throw new Error('store closed'); } })).toEqual({ id: 'member-a' });
  });
});

type Route = 'prompt' | 'stream';

/** Run one real prompt handler; inside the (mocked) model turn, call app_build and return the context the tool saw. */
async function ownerSeenByTool(route: Route, opts: Record<string, unknown>, body: Record<string, unknown>): Promise<DaemonToolDispatchCtx['verifiedOwner']> {
  let received: DaemonToolDispatchCtx | undefined;
  let dispatched = false;
  spyOn(coreTurnModule, 'runCoreTurn').mockImplementation(async (ctx) => {
    await ctx.dispatchTool('app_build', { ask: '콘서트 티케팅 시스템 만들어 배포해줘' }, { callId: 'call-1' });
    dispatched = true;
    return { stopReason: 'end_turn', finalText: 'OK' };
  });
  const handlerOpts = {
    noAuth: true, history: new DaemonSessionHistory(), toolCwd: process.cwd(),
    toolSurface: { kind: 'chat' as const, specs: [], async dispatch(_name: string, _args: unknown, ctx: DaemonToolDispatchCtx) { received = ctx; return { ok: true }; } },
    ...opts,
  };
  const init = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic' }, body: JSON.stringify(body) };
  if (route === 'prompt') {
    expect((await handlePromptPost(new Request('http://test/v1/prompt', init), handlerOpts)).status).toBe(200);
  } else {
    const response = await handlePromptStreamPost(new Request('http://test/v1/prompt/stream', init), handlerOpts);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) { /* drain the event stream to the end of the turn */ }
  }
  expect(dispatched).toBe(true);
  return received?.verifiedOwner;
}

const memberAppSlot = (id: string) => (id === 'member-a' ? 'concert-a' : undefined);
// The three owner paths of a prompt turn, each alone (the others answer «no owner»).
const OWNER_PATHS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['verifier', { resolveVerifiedOwner: (_req: Request, appSlug?: string) => (appSlug === undefined ? { id: 'member-a' } : undefined) }],
  ['deployment owner (lecture-scrap)', { resolveVerifiedOwner: (_req: Request, appSlug?: string) => (appSlug === 'lecture-scrap'
    ? { id: 'member-a', appSlug, memberId: 'member-a', userSlug: 'alice', plan: 'free', entitlements: {} } : undefined) }],
  ['dynamic owner', { resolveDynamicAppOwner: async () => ({ memberId: 'member-a', userSlug: 'test-slot' }) }],
];

describe('both prompt handlers hand app_build the member slot from the store, on every owner path', () => {
  for (const route of ['prompt', 'stream'] as const) {
    for (const [name, path] of OWNER_PATHS) {
      test(`${route} · ${name}: the tool sees { id: member-a, appSlug: concert-a }`, async () => {
        expect(await ownerSeenByTool(route, { ...path, memberAppSlot }, { userText: '콘서트 앱' })).toEqual({ id: 'member-a', appSlug: 'concert-a' });
      });
    }
  }

  for (const route of ['prompt', 'stream'] as const) {
    test(`${route}: a slot named in the request body is ignored; a member without a slot gets the id alone`, async () => {
      expect(await ownerSeenByTool(route, { resolveVerifiedOwner: (_req: Request, appSlug?: string) => (appSlug === undefined ? { id: 'member-b' } : undefined), memberAppSlot },
        { userText: '콘서트 앱', appSlug: 'spoofed-slot', verifiedOwner: { id: 'member-a', appSlug: 'concert-a' } })).toEqual({ id: 'member-b' });
    });
    test(`${route}: no verified owner — no owner reaches the tool, whatever the body says`, async () => {
      expect(await ownerSeenByTool(route, { memberAppSlot }, { userText: '콘서트 앱', verifiedOwner: { id: 'member-a' } })).toBeUndefined();
    });
  }
});
