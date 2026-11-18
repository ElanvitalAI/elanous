// APP-BUILD-DECLINE-NO-BYPASS-DEPLOY — 11-16 14:02 예행 (UX #77384): a declined app_build was
// followed by a Bash build and `tailscale serve`. The scripted tool calls below stand in for the
// model's turn (a fake model): app_build → declined → Bash bypass attempts in the same request.
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createPluginRouteAdapter } from '../plugins/core/route-adapter.js';
import { APP_BUILD_DECLINED_CODE, createAppBuildDeclineTurnGuard, matchBypassDeploy } from '../plugins/core/app-build-decline-guard.js';
import { buildReplTools } from './index.js';

const pluginRoot = fileURLToPath(new URL('../../plugins/', import.meta.url));
const owner = { id: 'synthetic-member', appSlug: 'yongpyong-ski' };
const ownerContext = { surface: 'tui' as const, verifiedOwner: owner };
const buildArgs = { ask: '용평 스키 강습 예약 앱 만들어줘' };

function world(confirm: () => Promise<boolean>) {
  const graphCalls: string[] = [];
  const bashCalls: string[] = [];
  let requestId = 'request-1';
  const route = createPluginRouteAdapter({
    pluginRoot, dispatchCore: async () => null, requestConfirmation: confirm,
    dispatchGraph: async (_pluginId, graphId) => { graphCalls.push(graphId); return { graphId, status: 'done' }; },
  });
  const tools = buildReplTools({
    getRequestId: () => requestId,
    dispatchBash: async (args) => { bashCalls.push(String(args.command)); return { output: 'ran', exitCode: 0 }; },
    pluginRuntime: { hostTools: [], dispatchPluginTool: async (name, args) =>
      await route.dispatch(name, args, false, ownerContext) ?? { ok: false, error: `unknown tool ${name}` } },
  });
  return { route, tools, graphCalls, bashCalls, nextRequest: () => { requestId = 'request-2'; } };
}

test('declined app_build returns a structured APP_BUILD_DECLINED result', async () => {
  const { route, graphCalls } = world(async () => false);
  const result = await route.dispatch('app_build', buildArgs, false, ownerContext) as Record<string, unknown>;
  expect(result).toMatchObject({ ok: false, code: APP_BUILD_DECLINED_CODE, declined: true, reason: 'declined' });
  expect(String(result.instruction)).toContain('Do not build or deploy by other means in this turn');
  expect(String(result.error)).toContain('APP_BUILD_DECLINED');
  expect(String(result.error)).toContain('ask the user');
  expect(graphCalls).toEqual([]);
});

test('an unanswered confirmation that fails closed is the same structured decline', async () => {
  const { route, graphCalls } = world(async () => { throw new Error('approval window closed'); });
  const result = await route.dispatch('app_build', buildArgs, false, ownerContext);
  expect(result).toMatchObject({ ok: false, code: APP_BUILD_DECLINED_CODE, declined: true, reason: 'confirmation-failed' });
  expect(graphCalls).toEqual([]);
});

test('after a decline, Bash tailscale serve and funnel in the same turn are refused and never run', async () => {
  const { tools, bashCalls } = world(async () => false);
  const declined = await tools.dispatch('app_build', buildArgs) as Record<string, unknown>;
  expect(declined.code).toBe(APP_BUILD_DECLINED_CODE);
  expect(declined.instruction).toBeDefined();
  for (const command of [
    'tailscale serve --bg --tls-terminated-tcp 31507 tcp://127.0.0.1:31507',
    'cd app && bun install && sudo tailscale funnel 443 on',
    'bun run backend/entry.ts --host 0.0.0.0 &',
  ]) {
    const refused = await tools.dispatch('Bash', { command }) as Record<string, unknown>;
    expect(refused).toMatchObject({ code: 'APP_BUILD_DECLINED_BYPASS_REFUSED', refused: true });
    expect(String(refused.error)).toContain('declined app_build');
  }
  expect(bashCalls).toEqual([]);
  // Read-only shell work in the same turn still runs.
  expect(await tools.dispatch('Bash', { command: 'ls' })).toMatchObject({ output: 'ran' });
  expect(bashCalls).toEqual(['ls']);
});

test('the guard ends with the declined turn', async () => {
  const { tools, bashCalls, nextRequest } = world(async () => false);
  await tools.dispatch('app_build', buildArgs);
  expect(await tools.dispatch('Bash', { command: 'tailscale serve status --json' })).toMatchObject({ refused: true });
  nextRequest();
  expect(await tools.dispatch('Bash', { command: 'tailscale serve status --json' })).toMatchObject({ output: 'ran' });
  expect(bashCalls).toEqual(['tailscale serve status --json']);
});

test('without a decline, ordinary Bash is unaffected', async () => {
  const { tools, bashCalls } = world(async () => false);
  expect(await tools.dispatch('Bash', { command: 'echo hello' })).toMatchObject({ output: 'ran' });
  expect(await tools.dispatch('Bash', { command: 'tailscale serve status --json' })).toMatchObject({ output: 'ran' });
  expect(bashCalls).toEqual(['echo hello', 'tailscale serve status --json']);
});

test('an accepted app_build runs the graph and does not arm the guard', async () => {
  const { tools, graphCalls, bashCalls } = world(async () => true);
  expect(await tools.dispatch('app_build', buildArgs)).toMatchObject({ graphId: 'app-build', status: 'done' });
  expect(graphCalls).toEqual(['app-build']);
  expect(await tools.dispatch('Bash', { command: 'tailscale serve status --json' })).toMatchObject({ output: 'ran' });
  expect(bashCalls).toEqual(['tailscale serve status --json']);
});

test('bypass pattern list is explicit and leaves local work alone', () => {
  expect(matchBypassDeploy('tailscale serve --bg 31507')).toBe('tailscale-serve');
  expect(matchBypassDeploy('sudo tailscale --socket=/x funnel 443')).toBe('tailscale-funnel');
  expect(matchBypassDeploy('ngrok http 3000')).toBe('public-tunnel');
  expect(matchBypassDeploy('python3 -m http.server')).toBe('python-http-server');
  expect(matchBypassDeploy('vercel --prod')).toBe('deploy-cli');
  expect(matchBypassDeploy('python3 -m http.server --bind 127.0.0.1')).toBeNull();
  expect(matchBypassDeploy('bun test backend')).toBeNull();
  expect(matchBypassDeploy('curl -s http://127.0.0.1:31507/health')).toBeNull();
  const guard = createAppBuildDeclineTurnGuard(() => undefined);
  expect(guard.refuse('Bash', { command: 'tailscale serve status' })).toBeNull();
  guard.observe({ ok: false, code: APP_BUILD_DECLINED_CODE });
  expect(guard.refuse('RunShell', { command: ['tailscale', 'serve', '--bg', '31507'] })).toMatchObject({ refused: true });
  expect(guard.refuse('Read', { command: 'tailscale serve' })).toBeNull();
});
