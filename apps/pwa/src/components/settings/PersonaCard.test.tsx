// PersonaCard mount, create, and edit behavior with an injected Nexus client.

import { afterAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { create, act } from 'react-test-renderer';
import type { NexusClient, PersonaWireEntry } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';

import { PersonaCard } from './PersonaCard';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => { reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment; });

describe('PersonaCard — mount surface', () => {
  test('exports a component', () => {
    expect(typeof PersonaCard).toBe('function');
  });

  test('SSR pre-mount returns null (NexusProvider 미mount 시 hide)', () => {
    // 본 컴포넌트는 mounted + client 가 둘 다 있어야 렌더. SSR 에선 둘
    // 다 null → static markup 도 빈 문자열.
    const html = renderToStaticMarkup(<PersonaCard />);
    expect(html).toBe('');
  });

  test('creation remains successful when list reload fails and cannot be retried with the old name', async () => {
    const calls: string[] = [];
    let listCount = 0;
    const client = {
      getPersonas: async () => {
        listCount++;
        if (listCount === 2) throw new Error('connection lost');
        return { personas: [], count: 0 };
      },
      getPersonaPresets: async () => ({ presets: [{ personaId: 'sora', displayName: '소라' }] }),
      createPersona: async ({ name }: { name: string }) => {
        calls.push(name);
        return { persona: { personaId: 'new-sora', displayName: name } };
      },
      patchPersona: async () => { throw new Error('unexpected save'); },
    } as unknown as NexusClient;
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<NexusProvider client={client}><PersonaCard /></NexusProvider>); });
    const root = tree!.root;
    await act(async () => {
      root.findByProps({ id: 'persona-preset' }).props.onChange({ target: { value: 'sora' } });
      root.findByProps({ id: 'persona-new-name' }).props.onChange({ target: { value: '새 소라' } });
    });
    await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(calls).toEqual(['새 소라']);
    expect(root.findByProps({ role: 'status' }).children.join('')).toBe('새 소라 인격이 생성되었습니다.');
    expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('인격 목록 새로고침 실패: connection lost');
    expect(root.findByProps({ id: 'persona-new-name' }).props.value).toBe('');
    expect(root.findByType('form').findByType('button').props.disabled).toBe(true);
    await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(calls).toEqual(['새 소라']);
    expect(listCount).toBe(2);
    await act(async () => { tree!.unmount(); });
  });

  test('creation reload adds a persona while retaining unsaved drafts on existing personas', async () => {
    const original: PersonaWireEntry = {
      personaId: 'mira', displayName: '미라', description: '원래 설명', systemPrompt: '원래 프롬프트',
    };
    let personas: PersonaWireEntry[] = [original];
    const client = {
      getPersonas: async () => ({ personas, count: personas.length }),
      getPersonaPresets: async () => ({ presets: [{ personaId: 'sora', displayName: '소라' }] }),
      createPersona: async ({ name }: { name: string }) => {
        const persona = { personaId: 'new-sora', displayName: name };
        personas = [...personas, persona];
        return { persona };
      },
      patchPersona: async () => { throw new Error('unexpected save'); },
    } as unknown as NexusClient;
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<NexusProvider client={client}><PersonaCard /></NexusProvider>); });
    const root = tree!.root;
    await act(async () => {
      root.findByProps({ 'data-testid': 'persona-description-mira' }).props.onChange({ target: { value: '저장하지 않은 설명' } });
      root.findByProps({ 'data-testid': 'persona-system-prompt-mira' }).props.onChange({ target: { value: '첫 줄\n둘째 줄' } });
      root.findByProps({ id: 'persona-preset' }).props.onChange({ target: { value: 'sora' } });
      root.findByProps({ id: 'persona-new-name' }).props.onChange({ target: { value: '새 소라' } });
    });
    await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(root.findByProps({ 'data-testid': 'persona-row-new-sora' })).toBeDefined();
    expect(root.findByProps({ 'data-testid': 'persona-description-mira' }).props.value).toBe('저장하지 않은 설명');
    expect(root.findByProps({ 'data-testid': 'persona-system-prompt-mira' }).props.value).toBe('첫 줄\n둘째 줄');
    expect(root.findByProps({ 'data-testid': 'persona-save-mira' }).props.disabled).toBe(false);
    await act(async () => { tree!.unmount(); });
  });

  test('creation reload rebases untouched fields and PATCH does not overwrite another user’s changes', async () => {
    const original: PersonaWireEntry = {
      personaId: 'mira', displayName: '미라', description: '원래 설명', systemPrompt: '원래 프롬프트',
    };
    let personas: PersonaWireEntry[] = [original];
    let sentEdits: unknown;
    const client = {
      getPersonas: async () => ({ personas, count: personas.length }),
      getPersonaPresets: async () => ({ presets: [{ personaId: 'sora', displayName: '소라' }] }),
      createPersona: async ({ name }: { name: string }) => {
        personas = [
          { ...original, description: '다른 사용자의 설명', systemPrompt: '다른 사용자의 프롬프트' },
          { personaId: 'new-sora', displayName: name },
        ];
        return { persona: personas[1] };
      },
      patchPersona: async (id: string, changes: unknown) => {
        expect(id).toBe('mira');
        sentEdits = changes;
        return { persona: { ...personas[0], ...changes as object } };
      },
    } as unknown as NexusClient;
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<NexusProvider client={client}><PersonaCard /></NexusProvider>); });
    const root = tree!.root;
    await act(async () => {
      root.findByProps({ 'data-testid': 'persona-display-name-mira' }).props.onChange({ target: { value: '내 새 이름' } });
      root.findByProps({ id: 'persona-preset' }).props.onChange({ target: { value: 'sora' } });
      root.findByProps({ id: 'persona-new-name' }).props.onChange({ target: { value: '새 소라' } });
    });
    await act(async () => { root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(root.findByProps({ 'data-testid': 'persona-display-name-mira' }).props.value).toBe('내 새 이름');
    expect(root.findByProps({ 'data-testid': 'persona-description-mira' }).props.value).toBe('다른 사용자의 설명');
    expect(root.findByProps({ 'data-testid': 'persona-system-prompt-mira' }).props.value).toBe('다른 사용자의 프롬프트');
    await act(async () => { root.findByProps({ 'data-testid': 'persona-save-mira' }).props.onClick(); });
    expect(sentEdits).toEqual({ displayName: '내 새 이름' });
    await act(async () => { tree!.unmount(); });
  });

  test('loads presets, creates a named persona, reloads the list, and saves prefilled edits', async () => {
    const calls: string[] = [];
    const original: PersonaWireEntry = {
      personaId: 'mira', displayName: '미라', description: '이전 설명', systemPrompt: '첫 줄\n둘째 줄',
    };
    let personas = [original];
    let sentEdits: unknown;
    const client = {
      getPersonas: async () => { calls.push('list'); return { personas, count: personas.length }; },
      getPersonaPresets: async () => {
        calls.push('presets');
        return { presets: [{ personaId: 'sora', displayName: '소라' }] };
      },
      createPersona: async ({ preset, name }: { preset: string; name: string }) => {
        calls.push(`create:${preset}:${name}`);
        const persona = { personaId: 'sora-new', displayName: name };
        personas = [...personas, persona];
        return { persona };
      },
      patchPersona: async (id: string, edits: unknown) => {
        calls.push(`patch:${id}`);
        sentEdits = edits;
        return { persona: { ...original, ...edits as object } };
      },
    } as NexusClient;
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<NexusProvider client={client}><PersonaCard /></NexusProvider>); });
    expect(calls).toEqual(['list', 'presets']);
    const root = tree!.root;
    const preset = root.findByProps({ id: 'persona-preset' });
    expect(preset.findAllByType('option').map((o) => o.props.value)).toEqual(['', 'sora']);
    await act(async () => {
      preset.props.onChange({ target: { value: 'sora' } });
      root.findByProps({ id: 'persona-new-name' }).props.onChange({ target: { value: '  새 소라  ' } });
    });
    await act(async () => {
      await root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(calls).toEqual(['list', 'presets', 'create:sora:새 소라', 'list']);
    expect(root.findByProps({ role: 'status' }).children.join('')).toBe('새 소라 인격이 생성되었습니다.');
    expect(root.findByProps({ 'data-testid': 'persona-row-sora-new' })).toBeDefined();
    const name = root.findByProps({ 'data-testid': 'persona-display-name-mira' });
    const description = root.findByProps({ 'data-testid': 'persona-description-mira' });
    const prompt = root.findByProps({ 'data-testid': 'persona-system-prompt-mira' });
    expect([name.props.value, description.props.value, prompt.props.value]).toEqual(['미라', '이전 설명', '첫 줄\n둘째 줄']);
    await act(async () => {
      name.props.onChange({ target: { value: '새 미라' } });
      prompt.props.onChange({ target: { value: '새 첫 줄\n새 둘째 줄' } });
    });
    await act(async () => { await root.findByProps({ 'data-testid': 'persona-save-mira' }).props.onClick(); });
    expect(sentEdits).toEqual({ displayName: '새 미라', systemPrompt: '새 첫 줄\n새 둘째 줄' });
    expect(root.findByProps({ 'data-testid': 'persona-description-mira' }).props.value).toBe('이전 설명');
    await act(async () => { tree!.unmount(); });
  });
});
