import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { NexusClient, PluginCredentialsStatus } from '@/nexus/client';
import { PluginCredentialsField } from './PluginCredentialsField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CredentialsClient = Pick<NexusClient, 'getPluginCredentials' | 'putPluginCredentials'>;
const initial: PluginCredentialsStatus = { fields: [
  { name: 'API_KEY', env: 'PLUGIN_API_KEY', set: false },
  { name: 'TOKEN', env: 'PLUGIN_TOKEN', set: true },
] };
const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
});

async function mount(client: CredentialsClient, plugin = 'plugin/name') {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PluginCredentialsField plugin={plugin} client={client} />);
  });
  mounted.push(renderer);
  const buttons = (label: string) => renderer.root.findAllByType('button').filter(button => button.props.children === label);
  return { renderer, buttons };
}

test('looks up credential status, displays only names and set flags, saves changed values and refreshes status', async () => {
  const reads: string[] = [];
  const writes: Array<{ plugin: string; fields: Record<string, string | null> }> = [];
  let status = initial;
  const client: CredentialsClient = {
    getPluginCredentials: async plugin => { reads.push(plugin); return status; },
    putPluginCredentials: async (plugin, fields) => {
      writes.push({ plugin, fields });
      status = { fields: initial.fields.map(field => ({ ...field, set: field.name === 'API_KEY' || field.set })) };
      return { set: ['API_KEY'] };
    },
  };
  const ui = await mount(client);
  expect(reads).toEqual(['plugin/name']);
  expect(JSON.stringify(ui.renderer.toJSON())).toContain('PLUGIN_API_KEY');
  expect(JSON.stringify(ui.renderer.toJSON())).toContain('비어 있음');
  const inputs = ui.renderer.root.findAllByType('input');
  expect(inputs).toHaveLength(2);
  expect(inputs.every(input => input.props.type === 'password' && input.props.autoComplete === 'new-password')).toBe(true);
  await act(async () => inputs[0]!.props.onChange({ target: { value: 'fresh-sensitive-value' } }));
  expect(JSON.stringify(ui.renderer.toJSON())).not.toContain('fresh-sensitive-value');
  await act(async () => { await ui.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(writes).toEqual([{ plugin: 'plugin/name', fields: { API_KEY: 'fresh-sensitive-value' } }]);
  expect(reads).toEqual(['plugin/name', 'plugin/name']);
  expect(JSON.stringify(ui.renderer.toJSON())).toContain('저장됨');
  expect(ui.renderer.root.findAllByType('input')[0]).not.toBe(inputs[0]);
  expect(JSON.stringify(ui.renderer.toJSON())).not.toContain('fresh-sensitive-value');
});

test('empty credential schema shows an empty state without a form', async () => {
  const ui = await mount({
    getPluginCredentials: async () => ({ fields: [] }),
    putPluginCredentials: async () => { throw new Error('unexpected write'); },
  });
  expect(JSON.stringify(ui.renderer.toJSON())).toContain('필요한 자격 항목이 없습니다.');
  expect(ui.renderer.root.findAllByType('input')).toHaveLength(0);
  expect(ui.renderer.root.findAllByType('form')).toHaveLength(0);
});

test('does not submit empty or whitespace-only entries', async () => {
  const writes: Record<string, string | null>[] = [];
  const ui = await mount({ getPluginCredentials: async () => initial, putPluginCredentials: async (_plugin, fields) => { writes.push(fields); return { set: [] }; } });
  const inputs = ui.renderer.root.findAllByType('input');
  await act(async () => inputs[0]!.props.onChange({ target: { value: '  ' } }));
  expect(ui.buttons('저장')[0]!.props.disabled).toBe(true);
  await act(async () => ui.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(writes).toEqual([]);
});

test('clears a saved credential only after confirmation, sending null and refreshing status', async () => {
  let status = initial;
  const writes: Record<string, string | null>[] = [];
  const ui = await mount({
    getPluginCredentials: async () => status,
    putPluginCredentials: async (_plugin, fields) => {
      writes.push(fields);
      status = { fields: initial.fields.map(field => field.name === 'TOKEN' ? { ...field, set: false } : field) };
      return { set: [] };
    },
  });
  await act(async () => ui.buttons('지우기')[0]!.props.onClick());
  expect(writes).toEqual([]);
  await act(async () => ui.buttons('취소')[0]!.props.onClick());
  expect(writes).toEqual([]);
  await act(async () => ui.buttons('지우기')[0]!.props.onClick());
  await act(async () => { await ui.buttons('지우기 확인')[0]!.props.onClick(); });
  expect(writes).toEqual([{ TOKEN: null }]);
  expect(ui.buttons('지우기')).toHaveLength(0);
  expect(JSON.stringify(ui.renderer.toJSON())).toContain('비어 있음');
});

test('a successful write followed by a failed status refresh clears the input and marks status unverified', async () => {
  const secret = 'refresh-failure-sensitive-value';
  let reads = 0;
  const writes: Record<string, string | null>[] = [];
  const ui = await mount({
    getPluginCredentials: async () => {
      if (++reads > 1) throw new Error(secret);
      return initial;
    },
    putPluginCredentials: async (_plugin, fields) => { writes.push(fields); return { set: ['API_KEY'] }; },
  });
  const input = ui.renderer.root.findAllByType('input')[0]!;
  await act(async () => input.props.onChange({ target: { value: secret } }));
  await act(async () => { await ui.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  const rendered = JSON.stringify(ui.renderer.toJSON());
  expect(writes).toEqual([{ API_KEY: secret }]);
  expect(ui.renderer.root.findAllByType('input')[0]).not.toBe(input);
  expect(rendered).toContain('자격 정보는 저장됐지만 상태를 확인하지 못했습니다.');
  expect(rendered).toContain('확인하지 못함');
  expect(rendered).not.toContain('비어 있음');
  expect(rendered).not.toContain('저장됨');
  expect(rendered).not.toContain('자격 정보를 저장하지 못했습니다.');
  expect(rendered).not.toContain(secret);
  expect(ui.buttons('저장')[0]!.props.disabled).toBe(true);
});

test('ignores an old write refresh when plugin or client changes', async () => {
  for (const change of ['plugin', 'client'] as const) {
    let finishRefresh!: (value: PluginCredentialsStatus) => void;
    let reads = 0;
    const oldClient: CredentialsClient = {
      getPluginCredentials: async plugin => plugin === 'new'
        ? { fields: [{ name: 'NEW', env: 'NEW_ENV', set: false }] }
        : ++reads === 1 ? initial : new Promise(resolve => { finishRefresh = resolve; }),
      putPluginCredentials: async () => ({ set: ['API_KEY'] }),
    };
    const nextClient: CredentialsClient = change === 'client' ? {
      getPluginCredentials: async () => ({ fields: [{ name: 'NEW', env: 'NEW_ENV', set: false }] }),
      putPluginCredentials: async () => ({ set: [] }),
    } : oldClient;
    const ui = await mount(oldClient, 'old');
    await act(async () => ui.renderer.root.findAllByType('input')[0]!.props.onChange({ target: { value: 'secret-old-value' } }));
    let save!: Promise<void>;
    await act(async () => { save = ui.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    await act(async () => ui.renderer.update(<PluginCredentialsField plugin={change === 'plugin' ? 'new' : 'old'} client={nextClient} />));
    await act(async () => finishRefresh({ fields: [{ name: 'STALE', env: 'STALE_ENV', set: true }] }));
    await act(async () => save);
    const rendered = JSON.stringify(ui.renderer.toJSON());
    expect(rendered).not.toContain('STALE_ENV');
    expect(rendered).not.toContain('secret-old-value');
    expect(rendered).toContain('NEW_ENV');
  }
});

test('reports read and write failures without exposing rejected secret values or errors', async () => {
  const secret = 'never-leak-this-credential';
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const failedRead = await mount({
    getPluginCredentials: async () => { throw new Error(secret); },
    putPluginCredentials: async () => { throw new Error(secret); },
  });
  expect(JSON.stringify(failedRead.renderer.toJSON())).toContain('자격 상태를 불러오지 못했습니다.');
  expect(JSON.stringify(failedRead.renderer.toJSON())).not.toContain(secret);

  const failedWrite = await mount({
    getPluginCredentials: async () => initial,
    putPluginCredentials: async () => { throw new Error(secret); },
  });
  await act(async () => failedWrite.renderer.root.findAllByType('input')[0]!.props.onChange({ target: { value: secret } }));
  await act(async () => { await failedWrite.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  expect(JSON.stringify(failedWrite.renderer.toJSON())).toContain('자격 정보를 저장하지 못했습니다.');
  expect(JSON.stringify(failedWrite.renderer.toJSON())).not.toContain(secret);
  expect(failedWrite.renderer.root.findAllByType('input')[0]!.props.value).toBeUndefined();
  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(secret);
  log.mockRestore();
  warn.mockRestore();
  error.mockRestore();
});

test('the node form shows credentials only for plugin kinds, wired to the panel client (W7 harvest)', async () => {
  const { readFileSync } = await import('node:fs');
  const editor = readFileSync(new URL('./WorkflowNodeEditor.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('./WorkflowsPanel.tsx', import.meta.url), 'utf8');
  expect(editor).toMatch(/palette\?\.find\(\(e\) => e\.kind === kind\)\?\.plugin/);
  expect(editor).toMatch(/kindPlugin && credentialsClient && \(/);
  expect(panel).toMatch(/credentialsClient=\{nexusClientForCredentials\}/);
});
