import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { CredentialVaultView } from './CredentialVaultView';
import { createNexusClient } from '@/nexus/client';
import CredentialsPage from './page';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderedRows(tree: ReturnType<typeof create>): string[] {
  const rows: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const item = node as { type?: string; children?: unknown[] };
    if (item.type === 'li') rows.push(JSON.stringify(item));
    for (const child of item.children ?? []) visit(child);
  };
  visit(tree.toJSON());
  return rows;
}

test('fake Nexus slot inventory shows only shared names, presence and last check', async () => {
  const load = async () => ({ credentials: [
    { id: 'cred:openai.api_key', label: 'OpenAI', present: true, lastCheckedAt: null, registerable: true,
      registrationPath: '/credentials/register', healthLabel: '있음 · 만료 정보 없음(측정 안 됨)', value: 'fake-secret-must-not-render' },
    { id: 'cred:elevenlabs.api_key', label: 'ElevenLabs', present: false, lastCheckedAt: '2026-11-10T08:00:00.000Z' },
    { id: 'cred:openrouter.api_key', label: 'OpenRouter', present: false, lastCheckedAt: null, registerable: true,
      registrationPath: '/credentials/register' },
  ] });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialVaultView load={load} startOpenRouter={async () => 'https://openrouter.ai/auth'} />); await Promise.resolve(); });
  const html = JSON.stringify(tree.toJSON());
  expect(html).toContain('cred:openai.api_key');
  expect(html).toContain('있음');
  expect(html).toContain('없음');
  expect(html).toContain('확인 기록 없음');
  expect(html).toContain('/credentials/register?slot=cred%3Aopenai.api_key');
  expect(html).toContain('OpenRouter 계정 연결');
  const openRouterRow = renderedRows(tree).find((row) => row.includes('cred:openrouter.api_key')) ?? '';
  expect(openRouterRow).toContain('QR·키 등록');
  expect(openRouterRow).toContain('/credentials/register?slot=cred%3Aopenrouter.api_key');
  expect(html).toContain('있음 · 만료 정보 없음');
  const absentRow = renderedRows(tree).find((row) => row.includes('cred:elevenlabs.api_key'));
  expect(absentRow).toContain('"없음"');
  expect(html).not.toContain('fake-secret-must-not-render');
  await act(async () => tree.unmount());
});

test('a stale fake response cannot overwrite the newest refresh result', async () => {
  let finishFirst!: (value: { credentials: Array<{ id: string; label: string; present: boolean; lastCheckedAt: null }> }) => void;
  const first = new Promise<{ credentials: Array<{ id: string; label: string; present: boolean; lastCheckedAt: null }> }>((resolve) => { finishFirst = resolve; });
  let calls = 0;
  const load = () => ++calls === 1 ? first : Promise.resolve({ credentials: [
    { id: 'cred:openai.api_key', label: 'OpenAI', present: true, lastCheckedAt: null },
  ] });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialVaultView load={load} />); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); });
  await act(async () => { finishFirst({ credentials: [
    { id: 'cred:openai.api_key', label: 'OpenAI', present: false, lastCheckedAt: null },
  ] }); await Promise.resolve(); });
  const row = renderedRows(tree)[0] ?? '';
  expect(row).toContain('"있음"');
  expect(row).not.toContain('"없음"');
  await act(async () => tree.unmount());
});

test('failed single-use OpenRouter import offers a fresh candidate reload', async () => {
  let listCalls = 0;
  const listOpenRouterImports = async () => {
    listCalls += 1;
    return { candidates: [{ id: `candidate-${listCalls}`, name: 'OPENROUTER_API_KEY', source: 'dotenv', lastFour: String(listCalls) }] };
  };
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<CredentialVaultView load={async () => ({ credentials: [] })} listOpenRouterImports={listOpenRouterImports}
      importOpenRouterCandidate={async () => { throw new Error('candidate consumed after verification rejection'); }} />);
  });
  await act(async () => {
    tree.root.findAllByType('button').find(button => JSON.stringify(button.children).includes('가져오기'))!.props.onClick();
    await Promise.resolve();
  });
  expect(JSON.stringify(tree.toJSON())).toContain('후보를 새로 불러와 다시 시도해 주세요.');
  await act(async () => {
    tree.root.findAllByType('button').find(button => JSON.stringify(button.children).includes('후보 다시 불러오기'))!.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(listCalls).toBe(2);
  expect(JSON.stringify(tree.toJSON())).toContain('끝자리 ","2"');
  expect(JSON.stringify(tree.toJSON())).not.toContain('후보를 새로 불러와 다시 시도해 주세요.');
  await act(async () => tree.unmount());
});

test('successful candidate import reports a saved key without claiming OAuth account connection', async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<CredentialVaultView load={async () => ({ credentials: [
      { id: 'cred:openrouter.api_key', label: 'OpenRouter', present: true, lastCheckedAt: '2026-11-10T09:00:00.000Z' },
    ] })} listOpenRouterImports={async () => ({ candidates: [
      { id: 'candidate-1', name: 'OPENROUTER_API_KEY', source: 'dotenv', lastFour: '1234' },
    ] })} importOpenRouterCandidate={async () => ({ saved: true })} />);
    await Promise.resolve();
  });
  await act(async () => {
    tree.root.findAllByType('button').find(button => JSON.stringify(button.children).includes('가져오기'))!.props.onClick();
    await Promise.resolve();
  });
  const html = JSON.stringify(tree.toJSON());
  expect(html).toContain('감지한 OpenRouter 키를 Nexus가 검증해 저장했습니다.');
  expect(html).not.toContain('OpenRouter 연결을 마쳤고');
  await act(async () => tree.unmount());
});

test('fake Nexus HTTP response uses the owner bearer and returns metadata', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-token', fetchImpl: (async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ credentials: [{ id: 'cred:openai.api_key', label: 'OpenAI', present: true, lastCheckedAt: null }] });
  }) as typeof fetch });
  expect((await client.getCredentialSlots()).credentials[0]?.id).toBe('cred:openai.api_key');
  expect(requests).toEqual([{ url: 'https://nexus.example.test/v1/credentials/slots', authorization: 'Bearer owner-token' }]);
});

test('OpenRouter OAuth start uses the owner-authorized Nexus endpoint and accepts only its fixed origin', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-token', fetchImpl: (async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ authorizationUrl: 'https://openrouter.ai/auth?state=test' });
  }) as typeof fetch });
  expect(await client.startOpenRouterOAuth()).toEqual({ authorizationUrl: 'https://openrouter.ai/auth?state=test' });
  expect(requests).toEqual([{ url: 'https://nexus.example.test/v1/credentials/openrouter/oauth/start', authorization: 'Bearer owner-token' }]);
});

test('the page reads the owner inventory through Nexus context', async () => {
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl: (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/credentials/openrouter/import')) return Response.json({ candidates: [] });
    return Response.json({ credentials: [{ id: 'cred:openai.api_key', label: 'OpenAI', present: true, lastCheckedAt: null }] });
  }) as unknown as typeof fetch });
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<NexusProvider client={client}><CredentialsPage /></NexusProvider>); await Promise.resolve(); });
  expect(renderedRows(tree)[0]).toContain('cred:openai.api_key');
  await act(async () => tree.unmount());
});
