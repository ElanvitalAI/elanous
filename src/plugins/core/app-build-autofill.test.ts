import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { autofillAppBuildArgs, classifyAppBuildIntent, inferAppBuildDataNeeds } from './app-build-autofill.js';
import { createPluginRouteAdapter } from './route-adapter.js';

const SLOT = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const member = { verifiedOwner: { id: 'member-a', appSlug: SLOT } };
const pluginRoot = resolve(import.meta.dir, '../../../plugins');

test.each([
  ['용평 스키 강습 예약 앱 만들어줘', { database: true, mail: false, auth: false, seed: false }, '용평 스키 강습 예약'],
  ['콘서트 티케팅 시스템 만들어서 가상 데이터로 채워 넣고 배포해줘', { database: true, mail: false, auth: false, seed: true }, '콘서트 티케팅'],
  ['회원 로그인되는 동호회 게시판 앱 만들고 가입하면 이메일 보내줘', { database: true, mail: true, auth: true, seed: false }, undefined],
  ['Build a ski lesson booking app with sample data', { database: true, mail: false, auth: false, seed: true }, 'ski lesson booking'],
  ['create a newsletter signup website', { database: false, mail: true, auth: true, seed: false }, 'newsletter signup'],
] as const)('one line fills intent, member slot, handle source and data needs: %s', (line, needs, name) => {
  expect(classifyAppBuildIntent(line)).toBe(true);
  const result = autofillAppBuildArgs({ ask: line }, member);
  if (result.status !== 'filled') throw new Error(result.error);
  expect(result.filled).toMatchObject({ intent: 'app-build', intentSource: 'line-cue', appSlug: SLOT,
    appSlugSource: 'verified-member-slot', appSlugReplaced: false, handleSource: 'nexus-owner-endpoint-at-reserve',
    dataNeeds: needs, seedRequested: needs.seed, runtimeSource: 'default' });
  if (name) expect(result.filled.appName).toBe(name);
  expect(result.filled.appSlug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  expect(result.args).toMatchObject({ appSlug: SLOT, seedRequested: needs.seed,
    artifactMetadata: { runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } } });
  expect(String(result.args.ask).startsWith(line)).toBe(true);
  expect(String(result.args.ask)).toContain('[host-filled · not user text] runtime: bun backend/entry.ts');
});

test('non-app lines are not classified as a new app build', () => {
  for (const line of ['오늘 용평 날씨 알려줘', '등록된 앱 배포해줘', '기존 앱 산출물을 배포해줘', '앱 만드는 법 알려줘',
    'deploy existing app', 'how to build an app?', 'summarize this document']) {
    expect(classifyAppBuildIntent(line)).toBe(false);
  }
  expect(inferAppBuildDataNeeds('오늘 날씨 알려줘')).toEqual({ database: false, mail: false, auth: false, seed: false });
});

test('missing member binding stays needs_connection and never guesses a slot', () => {
  expect(autofillAppBuildArgs({ ask: '예약 앱 만들어줘', appSlug: 'model-guess' }, {}))
    .toMatchObject({ status: 'needs_connection', code: 'VERIFIED_OWNER_REQUIRED' });
  expect(autofillAppBuildArgs({ ask: '예약 앱 만들어줘', appSlug: 'model-guess' }, { verifiedOwner: { id: 'member-a' } }))
    .toMatchObject({ status: 'needs_connection', code: 'MEMBER_APP_SLOT_REQUIRED' });
  for (const unsafe of ['Bad_Slot', '../etc', '-leading', 'a'.repeat(SLOT.length + 1)]) {
    const result = autofillAppBuildArgs({ ask: '예약 앱 만들어줘' }, { verifiedOwner: { id: 'member-a', appSlug: unsafe } });
    expect(result).toMatchObject({ status: 'needs_connection', code: 'MEMBER_APP_SLOT_REQUIRED' });
  }
  expect(autofillAppBuildArgs({ ask: '  ' }, member)).toMatchObject({ status: 'invalid', code: 'APP_BUILD_ASK_REQUIRED' });
});

test('colliding or unsafe model slug and identity arguments are replaced by the verified member context', () => {
  const result = autofillAppBuildArgs({ ask: 'Build a ticketing app', appSlug: '../other-member', handle: 'someone-else',
    userSlug: 'someone-else', ownerId: 'member-b', memberId: 'member-b', verifiedOwner: { id: 'member-b' },
    seedRequested: false, context: { memberId: 'member-b' },
    artifactMetadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], healthPath: '/healthz' } } }, member);
  if (result.status !== 'filled') throw new Error(result.error);
  expect(result.filled).toMatchObject({ appSlug: SLOT, appSlugReplaced: true, runtimeSource: 'caller' });
  expect(result.args.appSlug).toBe(SLOT);
  for (const key of ['handle', 'userSlug', 'ownerId', 'memberId', 'verifiedOwner']) expect(Object.hasOwn(result.args, key)).toBe(false);
  expect(Object.hasOwn(result.args.context as object, 'memberId')).toBe(false);
  expect(result.args.artifactMetadata).toEqual({ runtime: { startCommand: ['bun', 'backend/server.ts'], healthPath: '/healthz' } });
  expect(String(result.args.ask)).not.toContain('runtime:');
  const again = autofillAppBuildArgs(result.args, member);
  if (again.status !== 'filled') throw new Error(again.error);
  expect(again.args.ask).toBe(result.args.ask);
  const traversal = autofillAppBuildArgs({ ask: '예약 앱 만들어줘',
    artifactMetadata: { runtime: { startCommand: ['bun', 'backend/../../escape.ts'], healthPath: '/health' } } }, member);
  expect(traversal.status === 'filled' && traversal.filled.runtimeSource).toBe('default');
});

test('route adapter fills the built-in app_build route before confirmation and keeps needs_connection typed', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const adapter = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null,
    requestConfirmation: async prompt => { prompts.push(prompt); return true; },
    dispatchGraph: async (_pluginId, graphId, _file, args) => { calls.push({ graphId, ...args }); return { status: 'done' }; } });
  const anonymous = await adapter.dispatch('app_build', { ask: '용평 스키 강습 예약 앱 만들어줘' }, false, { surface: 'tui' });
  expect(anonymous).toMatchObject({ ok: false, code: 'VERIFIED_OWNER_REQUIRED' });
  expect(prompts).toEqual([]);
  expect(calls).toEqual([]);
  const filled = await adapter.dispatch('app_build', { ask: '용평 스키 강습 예약 앱 만들어줘', appSlug: 'model-guess' }, false,
    { surface: 'tui', ...member });
  expect(filled).toMatchObject({ ok: true, result: { status: 'done' } });
  expect(prompts.length).toBe(1);
  expect(calls[0]).toMatchObject({ graphId: 'app-build', appSlug: SLOT, seedRequested: false,
    artifactMetadata: { runtime: { startCommand: ['bun', 'backend/entry.ts'], healthPath: '/health' } },
    context: { oneLineAutofill: { appSlugReplaced: true, dataNeeds: { database: true } } } });
  const tool = adapter.hostTools([]).find(item => item.name === 'app_build');
  expect((tool?.parameters as { required?: string[] }).required).toEqual(['ask']);
});

test('APP-BUILD-LOCAL-PATH: a local host opt-in turns the missing member into a local build, never a confirmation or graph run', async () => {
  const calls: unknown[] = [];
  const local: Array<Record<string, unknown>> = [];
  const adapter = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null,
    requestConfirmation: async () => { calls.push('confirm'); return true; },
    dispatchGraph: async () => { calls.push('graph'); return { status: 'done' }; },
    localAppBuild: async args => { local.push(args); return { status: 'local-build', workspace: '/tmp/translator' }; } });
  const out = await adapter.dispatch('app_build', { ask: '번역 서비스 만들어줘', capabilities: ['translation'] }, false, { surface: 'tui' });
  expect(out).toEqual({ ok: true, result: { status: 'local-build', workspace: '/tmp/translator' } });
  expect(local).toEqual([{ ask: '번역 서비스 만들어줘', capabilities: ['translation'] }]);
  expect(calls).toEqual([]);
  // A connected member still takes the member graph, not the local path.
  await adapter.dispatch('app_build', { ask: '번역 서비스 만들어줘' }, false, { surface: 'tui', ...member });
  expect(local.length).toBe(1);
  expect(calls).toEqual(['confirm', 'graph']);
  const tool = adapter.hostTools([]).find(item => item.name === 'app_build');
  expect(Object.keys((tool?.parameters as { properties: Record<string, unknown> }).properties)).toContain('capabilities');
});

test('APP-BUILD-LOCAL-PATH: app_create refusal names the local path only where the host offers it', async () => {
  const local = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null, localAppBuild: async () => ({}) });
  const withLocal = await local.dispatch('app_create', { root: '/tmp/x', files: [], metadata: {} }, false, { surface: 'tui' });
  expect((withLocal as { error: string }).error).toContain('call app_build — it builds in a local workspace');
  const daemon = createPluginRouteAdapter({ pluginRoot, dispatchCore: async () => null });
  const withoutLocal = await daemon.dispatch('app_create', { root: '/tmp/x', files: [], metadata: {} }, false, { surface: 'tui' });
  expect((withoutLocal as { error: string }).error).toBe('file artifact creation context required: app_create writes only inside a member app_build run (eln member connect).');
});
