'use client';

// PWA `/settings#personas` — create from presets and edit persona profiles.

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { PersonaEdits, PersonaPresetEntry, PersonaWireEntry } from '@/nexus/client';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { cn } from '@/lib/utils';
import { changedPersonaEdits, personaDraft } from './persona-card-edits';

const MAX_DESCRIPTION_LENGTH = 280; // mirror of src/persona/write-description.ts

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; personas: PersonaWireEntry[] }
  | { status: 'error'; message: string };

interface EditState {
  draft: PersonaEdits;
  saving: boolean;
  error?: string;
}

export function PersonaCard() {
  const client = useOptionalNexusClient();
  const [mounted, setMounted] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [presets, setPresets] = useState<PersonaPresetEntry[]>([]);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [preset, setPreset] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const refresh = useCallback(async (preserveEdits = false) => {
    if (!client) return;
    setReloadError(null);
    if (!preserveEdits) setLoad({ status: 'loading' });
    try {
      const res = await client.getPersonas();
      setLoad({ status: 'ok', personas: res.personas });
      if (!preserveEdits) setEdits({});
    } catch (err) {
      if (preserveEdits) setReloadError((err as Error).message);
      else setLoad({ status: 'error', message: (err as Error).message });
    }
  }, [client]);

  useEffect(() => {
    if (!mounted || !client) return;
    void refresh();
    void client.getPersonaPresets()
      .then((res) => setPresets(res.presets))
      .catch((err: Error) => setPresetError(err.message));
  }, [mounted, client, refresh]);

  const handleCreate = useCallback(async () => {
    if (!client || !preset || !name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    setCreated(null);
    try {
      const res = await client.createPersona({ preset, name: name.trim() });
      setCreated(`${res.persona.displayName} 인격이 생성되었습니다.`);
      setName('');
      await refresh(true);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [client, preset, name, creating, refresh]);

  const handleDraftChange = useCallback(
    (persona: PersonaWireEntry, field: keyof PersonaEdits, value: string) => {
      setEdits((prev) => {
        const draft: PersonaEdits = { ...prev[persona.personaId]?.draft };
        if (value === personaDraft(persona)[field]) delete draft[field];
        else draft[field] = value;
        return {
          ...prev,
          [persona.personaId]: { draft, saving: false, error: undefined },
        };
      });
    },
    [],
  );

  const handleSave = useCallback(
    async (persona: PersonaWireEntry) => {
      if (!client) return;
      const personaId = persona.personaId;
      const edit = edits[personaId];
      if (!edit || edit.saving) return;
      const changes = changedPersonaEdits(persona, { ...personaDraft(persona), ...edit.draft });
      if (Object.keys(changes).length === 0) return;
      setEdits((prev) => ({
        ...prev,
        [personaId]: { ...edit, saving: true, error: undefined },
      }));
      try {
        const res = await client.patchPersona(personaId, changes);
        // Patch local state with server response so UI doesn't lag behind.
        setLoad((prev) => {
          if (prev.status !== 'ok') return prev;
          return {
            status: 'ok',
            personas: prev.personas.map((p) =>
              p.personaId === personaId ? res.persona : p,
            ),
          };
        });
        setEdits((prev) => {
          const { [personaId]: _, ...rest } = prev;
          return rest;
        });
      } catch (err) {
        setEdits((prev) => ({
          ...prev,
          [personaId]: {
            ...edit,
            saving: false,
            error: (err as Error).message,
          },
        }));
      }
    },
    [client, edits],
  );

  if (!mounted || !client) return null;

  return (
    <section
      id="personas"
      data-testid="persona-card"
      className="space-y-3 rounded border border-border bg-card p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Personas</h2>
          <p className="text-xs text-muted-foreground">
            프리셋으로 인격을 만들고 이름, 설명, 시스템 프롬프트를 편집합니다.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { void refresh(); }}
          disabled={load.status === 'loading'}
        >
          Refresh
        </Button>
      </header>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); void handleCreate(); }}
      >
        <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs" htmlFor="persona-preset">
          프리셋
          <select
            id="persona-preset"
            value={preset}
            onChange={(e) => { setPreset(e.target.value); setCreateError(null); setCreated(null); }}
            disabled={creating}
            className="rounded border border-input bg-background px-2.5 py-1.5"
          >
            <option value="">프리셋 선택</option>
            {presets.map((entry) => (
              <option key={entry.personaId} value={entry.personaId}>{entry.displayName}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs" htmlFor="persona-new-name">
          이름
          <input
            id="persona-new-name"
            value={name}
            onChange={(e) => { setName(e.target.value); setCreateError(null); setCreated(null); }}
            disabled={creating}
            placeholder="새 인격 이름"
            className="rounded border border-input bg-background px-2.5 py-1.5"
          />
        </label>
        <Button type="submit" size="sm" disabled={!preset || !name.trim() || creating}>
          {creating ? '생성중…' : '인격 만들기'}
        </Button>
      </form>
      {presetError ? <p role="alert" className="text-xs text-destructive">프리셋 로드 실패: {presetError}</p> : null}
      {createError ? <p role="alert" className="text-xs text-destructive">인격 생성 실패: {createError}</p> : null}
      {created ? <p role="status" className="text-xs text-green-700 dark:text-green-400">{created}</p> : null}
      {reloadError ? <p role="alert" className="text-xs text-destructive">인격 목록 새로고침 실패: {reloadError}</p> : null}

      {load.status === 'idle' || load.status === 'loading' ? (
        <p className="text-xs text-muted-foreground">Loading personas…</p>
      ) : null}

      {load.status === 'error' ? (
        <p className="text-xs text-destructive">
          persona 로드 실패: {load.message}
        </p>
      ) : null}

      {load.status === 'ok' && load.personas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          아직 인격이 없습니다. 위에서 프리셋을 골라 새 인격을 만드세요.
        </p>
      ) : null}

      {load.status === 'ok' && load.personas.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {load.personas.map((persona) => (
            <PersonaRow
              key={persona.personaId}
              persona={persona}
              edit={edits[persona.personaId]}
              onDraftChange={handleDraftChange}
              onSave={handleSave}
            />
          ))}
        </ul>
      ) : null}

      <p className="text-[10px] text-muted-foreground">
        Note: ⚗ Auto describer 와 orchestrator routing 은{' '}
        <a
          href="https://github.com/ElanvitalAI/elanous/blob/main/docs/research/RESEARCH-hermes-pr27572-triage-orchestrator-deferred-2026-05-19.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Hermes PR #27572 research
        </a>{' '}
        채택 시 활성화 예정.
      </p>
    </section>
  );
}

interface PersonaRowProps {
  persona: PersonaWireEntry;
  edit?: EditState;
  onDraftChange: (persona: PersonaWireEntry, field: keyof PersonaEdits, value: string) => void;
  onSave: (persona: PersonaWireEntry) => void;
}

function PersonaRow({ persona, edit, onDraftChange, onSave }: PersonaRowProps) {
  const draft = { ...personaDraft(persona), ...edit?.draft };
  const dirty = Object.keys(changedPersonaEdits(persona, draft)).length > 0;
  const saving = edit?.saving ?? false;
  const remaining = MAX_DESCRIPTION_LENGTH - draft.description.length;
  const overLimit = remaining < 0;

  return (
    <li
      className="flex flex-col gap-2 rounded border border-border bg-background p-3"
      data-testid={`persona-row-${persona.personaId}`}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {persona.brandColor ? (
            <span
              className="inline-block h-3 w-3 rounded"
              style={{ backgroundColor: persona.brandColor }}
              aria-hidden
            />
          ) : null}
          <span className="text-sm font-medium">{persona.displayName}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {persona.personaId}
          </span>
        </div>
        {persona.primaryModel ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {persona.primaryModel}
          </span>
        ) : null}
      </header>

      <label className="flex flex-col gap-1 text-xs">
        표시 이름
        <input
          value={draft.displayName}
          onChange={(e) => onDraftChange(persona, 'displayName', e.target.value)}
          disabled={saving}
          data-testid={`persona-display-name-${persona.personaId}`}
          className="w-full rounded border border-input bg-transparent px-2.5 py-1.5"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        설명
        <textarea
          value={draft.description}
          onChange={(e) => onDraftChange(persona, 'description', e.target.value)}
          rows={2}
          maxLength={MAX_DESCRIPTION_LENGTH * 2}
          placeholder="이 persona 가 무엇을 잘 하는지 1-2 문장으로 적어주세요."
          disabled={saving}
          data-testid={`persona-description-${persona.personaId}`}
          className={cn(
            'w-full rounded border border-input bg-transparent px-2.5 py-1.5 text-xs',
            'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
            overLimit && 'border-destructive',
          )}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        시스템 프롬프트
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => onDraftChange(persona, 'systemPrompt', e.target.value)}
          rows={5}
          disabled={saving}
          data-testid={`persona-system-prompt-${persona.personaId}`}
          className="w-full rounded border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs"
        />
      </label>

      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'font-mono text-[10px]',
            overLimit ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {draft.description.length} / {MAX_DESCRIPTION_LENGTH}
        </span>
        <div className="flex items-center gap-2">
          {edit?.error ? (
            <span className="text-[10px] text-destructive">{edit.error}</span>
          ) : null}
          <Button
            size="sm"
            onClick={() => onSave(persona)}
            disabled={!dirty || saving || overLimit || !draft.displayName.trim()}
            data-testid={`persona-save-${persona.personaId}`}
          >
            {saving ? '저장중…' : '저장'}
          </Button>
        </div>
      </div>
    </li>
  );
}
