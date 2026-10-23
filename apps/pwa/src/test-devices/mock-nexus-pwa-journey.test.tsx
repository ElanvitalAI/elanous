import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { act } from 'react-test-renderer';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../../../../src/elanous-config-dir';
import { GraphWizardChat } from '../components/editor/GraphWizardChat';
import { HARNESS_EXAMPLE } from '../../../../src/graph-wizard/generate';
import { createMockNexusPwaJourney } from './mock-nexus-pwa-journey';

const SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('N04 timed out waiting for Nexus response');
    await Bun.sleep(5);
  }
}
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (close) await close();
  close = undefined;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

test('N04: owner POST reaches Nexus and the real PWA wizard renders its reply; unauthenticated requests stop at 401', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const runId = 'mock-n04-wizard-1';
  const journey = createMockNexusPwaJourney({ runId, sourceSha: SHA,
    callLLM: async () => `SLUG: digest\nSUMMARY: 요약\n\`\`\`yaml\n${HARNESS_EXAMPLE}\n\`\`\``,
  });
  close = journey.close;
  const deniedGet = await fetch(`${journey.url}/v1/graphs/wizard/packs`, { headers: { 'sec-fetch-site': 'cross-site' } });
  const deniedPost = await fetch(`${journey.url}/v1/graphs/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ prompt: '뉴스 요약' }),
  });
  expect([deniedGet.status, deniedPost.status]).toEqual([401, 401]);
  const wrongBearer = await fetch(`${journey.url}/v1/graphs/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ prompt: '뉴스 요약' }),
  });
  expect(wrongBearer.status).toBe(401);

  const applied: string[] = [];
  const root = await journey.mount(client => <GraphWizardChat
    client={{ graphWizard: (body, opts) => client.graphWizard!(body, opts) }}
    current={() => null}
    onApply={graph => applied.push(graph.graphId)}
    onRestore={() => {}}
  />);
  const before = journey.frame();
  expect(before).toMatchObject({ runId, sourceSha: SHA });
  expect(JSON.stringify(before.tree)).toContain('만들고 싶은 일');
  await act(async () => {
    root.root.findByProps({ 'aria-label': '만들고 싶은 일' }).props.onChange({ target: { value: '뉴스 요약' } });
  });
  await act(async () => {
    root.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await waitFor(() => journey.requests.some(request => request.path === '/v1/graphs/wizard' && request.status === 200));
  });
  const after = journey.frame();
  expect(after.runId).toBe(runId);
  expect(JSON.stringify(after.tree)).toContain('검증 통과');
  expect(applied).toHaveLength(1);
  expect(journey.requests).toContainEqual({ runId, sourceSha: SHA, method: 'POST', path: '/v1/graphs/wizard', status: 200 });
});

test('N04: closing the journey restores a preexisting config directory override', async () => {
  const previous = getElanousConfigDirOverride();
  const prior = '/tmp/mock-n04-prior-config';
  setElanousConfigDir(prior);
  try {
    const journey = createMockNexusPwaJourney({ runId: 'mock-n04-restore', sourceSha: SHA, callLLM: async () => '' });
    close = journey.close;
    expect(getElanousConfigDirOverride()).not.toBe(prior);
    await journey.close();
    close = undefined;
    expect(getElanousConfigDirOverride()).toBe(prior);
  } finally {
    if (previous === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previous);
  }
});
