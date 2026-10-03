import { expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { NexusClient } from '@/nexus/client';
import { WorkflowCreateModal } from './WorkflowCreateModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount() {
  const onApply = mock((_yaml: string, _name?: string) => {});
  const onClose = mock(() => {});
  const onOpenAI = mock(() => {});
  const getWorkflowTemplates = mock(async () => ({ templates: [{ id: 'starter', title: 'Starter', description: 'Example', tags: ['basic'], yaml: 'name: starter\n' }] }));
  const client = { getWorkflowTemplates } as unknown as NexusClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={queryClient}>
      <WorkflowCreateModal onApply={onApply} onClose={onClose} onOpenAI={onOpenAI} />
    </NexusProvider>);
  });
  const button = (label: string) => renderer.root.findAllByType('button').find((b) => b.children.includes(label))!;
  const choose = async (name: string, size: number, text: string) => {
    const file = { name, size, text: async () => text } as File;
    await act(async () => renderer.root.findByType('input').props.onChange({ currentTarget: { files: [file] } }));
  };
  const close = async () => { await act(async () => renderer.unmount()); queryClient.clear(); };
  return { renderer, button, choose, close, onApply, onClose, onOpenAI, getWorkflowTemplates };
}

test('file tab imports YAML and calls onApply with file-derived name', async () => {
  const modal = await mount();
  await act(async () => modal.button('파일').props.onClick());
  expect(modal.renderer.root.findByType('input').props).toMatchObject({ type: 'file', accept: '.yaml,.yml' });
  await modal.choose('My Flow.yml', 15, 'name: my flow\n');
  expect(modal.onApply).toHaveBeenCalledTimes(1);
  expect(modal.onApply).toHaveBeenCalledWith('name: my flow\n', 'my-flow');
  expect(modal.onClose).toHaveBeenCalledTimes(1);
  await modal.close();
});

test('file tab reports rejection inside the modal and does not apply', async () => {
  const modal = await mount();
  await act(async () => modal.button('파일').props.onClick());
  await modal.choose('invalid.txt', 5, 'hello');
  expect(modal.renderer.root.findByProps({ role: 'alert' }).children.join('')).toBe('YAML 파일(.yaml 또는 .yml)을 선택해 주세요.');
  expect(modal.onApply).toHaveBeenCalledTimes(0);
  expect(modal.onClose).toHaveBeenCalledTimes(0);
  await modal.choose('too-big.yaml', 256 * 1024 + 1, 'hello');
  expect(modal.renderer.root.findByProps({ role: 'alert' }).children.join('')).toBe('파일 크기는 256KB 이하여야 합니다.');
  await modal.choose('empty.yaml', 1, ' \n ');
  expect(modal.renderer.root.findByProps({ role: 'alert' }).children.join('')).toBe('내용이 비어 있는 파일은 가져올 수 없습니다.');
  expect(modal.onApply).toHaveBeenCalledTimes(0);
  await modal.close();
});

test('closing during an asynchronous file read never applies the pending draft', async () => {
  const modal = await mount();
  await act(async () => modal.button('파일').props.onClick());
  let finishRead!: (text: string) => void;
  const file = { name: 'pending.yaml', size: 10, text: () => new Promise<string>((resolve) => { finishRead = resolve; }) } as File;
  await act(async () => modal.renderer.root.findByType('input').props.onChange({ currentTarget: { files: [file] } }));
  await act(async () => modal.renderer.root.findByProps({ 'aria-label': 'Close' }).props.onClick());
  await act(async () => finishRead('name: pending\n'));
  expect(modal.onApply).toHaveBeenCalledTimes(0);
  expect(modal.onClose).toHaveBeenCalledTimes(1);
  await modal.close();
});

test('existing Template, Blank and AI actions preserve their callback behavior', async () => {
  const template = await mount();
  expect(template.getWorkflowTemplates).toHaveBeenCalledTimes(1);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const starter = template.renderer.root.findAllByType('button').find((b) => b.findAllByType('span').some((s) => s.children.includes('Starter')))!;
  await act(async () => starter.props.onClick());
  expect(template.onApply).toHaveBeenCalledWith('name: starter\n', 'starter');
  expect(template.onClose).toHaveBeenCalledTimes(1);
  await template.close();

  const blank = await mount();
  await act(async () => blank.button('Blank').props.onClick());
  await act(async () => blank.button('Create').props.onClick());
  expect(blank.onApply).toHaveBeenCalledTimes(1);
  expect(blank.onApply.mock.calls[0]?.[0]).toContain('name: my-workflow');
  expect(blank.onApply.mock.calls[0]?.[1]).toBe('my-workflow');
  expect(blank.onClose).toHaveBeenCalledTimes(1);
  await blank.close();

  const ai = await mount();
  await act(async () => ai.button('AI generate').props.onClick());
  expect(ai.onOpenAI).toHaveBeenCalledTimes(1);
  expect(ai.onApply).toHaveBeenCalledTimes(0);
  await ai.close();
});
