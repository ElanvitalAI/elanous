// Surface-unification ROADMAP §F2 (2026-05-11) — "+ New" workflow
// modal. Entry modes:
//   - Template: card grid of starter templates (F1 catalog)
//   - Blank: minimal manual-trigger scaffold
//   - AI: hands off to the existing WorkflowNLPrompt (Synth flow)
//   - File: import a local YAML draft
//
// Apply path: every mode returns YAML to the caller (parent loads it
// into the editor draft via the existing `creatingNew` flow).
//
// Skill→workflow convert is BACKLOG (separate "convert" affordance in
// the skill picker UI · not part of this modal).

'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import { FileText, Sparkles, FilePlus, X, Loader2 } from 'lucide-react';
import type { WorkflowTemplateEntry, WorkflowTemplateList } from '@/nexus/client';
import { checkImportFile } from './workflow-file';

interface WorkflowCreateModalProps {
  /** Called with the YAML the user picked. Caller flips into
   *  `creatingNew` mode and seeds the editor textarea. */
  onApply: (yaml: string, suggestedName?: string) => void;
  /** Called when the user clicks the "AI generate" tab — caller
   *  shows the existing WorkflowNLPrompt instead of this modal. */
  onOpenAI: () => void;
  /** Called when the user closes / cancels. */
  onClose: () => void;
}

const BLANK_YAML = `name: my-workflow
description: |
  Manual-trigger smoke. Edit me · click ▶ Run now to fire.

nodes:
  - id: start
    manualTrigger:
      description: Click ▶ Run now to fire this workflow

  - id: work
    bash: echo "hello"
    depends_on: [start]
`;

type Mode = 'template' | 'blank' | 'ai' | 'file';

export function WorkflowCreateModal({ onApply, onOpenAI, onClose }: WorkflowCreateModalProps) {
  const [mode, setMode] = useState<Mode>('template');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileSelection = useRef(0);
  const client = useNexusClient();

  useEffect(() => () => { fileSelection.current++; }, []);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const selection = ++fileSelection.current;
    setFileError(null);
    try {
      // Check size before reading, so oversized files never need to enter memory.
      const sizeCheck = checkImportFile({ name: file.name, size: file.size, text: 'pending' });
      if (!sizeCheck.ok) { setFileError(sizeCheck.reason); return; }
      const text = await file.text();
      if (selection !== fileSelection.current) return;
      const result = checkImportFile({ name: file.name, size: file.size, text });
      if (!result.ok) { setFileError(result.reason); return; }
      onApply(result.yaml, result.suggestedName);
      close();
    } catch {
      if (selection === fileSelection.current) setFileError('파일을 읽지 못했습니다. 다시 선택해 주세요.');
    }
  };
  const close = () => { fileSelection.current++; onClose(); };
  const query = useQuery<WorkflowTemplateList>({
    queryKey: ['nexus', 'workflow-templates'],
    queryFn: () => client.getWorkflowTemplates(),
    staleTime: 60_000,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm px-3 py-3 sm:items-center"
      onClick={close}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-2 rounded-t-2xl border border-border bg-surface-elevated shadow-xl sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">New workflow</h2>
          <button
            type="button"
            onClick={close}
            className="rounded p-1 text-text-tertiary hover:bg-surface"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <nav className="flex items-center gap-1 border-b border-border px-2">
          <TabButton active={mode === 'template'} onClick={() => { fileSelection.current++; setMode('template'); }} icon={<FileText className="h-3 w-3" />}>
            Template
          </TabButton>
          <TabButton active={mode === 'blank'} onClick={() => { fileSelection.current++; setMode('blank'); }} icon={<FilePlus className="h-3 w-3" />}>
            Blank
          </TabButton>
          <TabButton active={mode === 'file'} onClick={() => setMode('file')} icon={<FileText className="h-3 w-3" />}>
            파일
          </TabButton>
          <TabButton
            active={mode === 'ai'}
            onClick={() => {
              fileSelection.current++;
              setMode('ai');
              onOpenAI();
            }}
            icon={<Sparkles className="h-3 w-3" />}
          >
            AI generate
          </TabButton>
        </nav>

        <div className="flex-1 overflow-auto px-3 pb-3">
          {mode === 'template' && (
            <TemplatePicker
              query={query}
              onPick={(t) => {
                onApply(t.yaml, t.id);
                close();
              }}
            />
          )}
          {mode === 'blank' && (
            <BlankPanel
              onCreate={() => {
                onApply(BLANK_YAML, 'my-workflow');
                close();
              }}
            />
          )}
          {mode === 'file' && (
            <div className="flex flex-col gap-2 px-3 py-4">
              <label htmlFor="workflow-import-file" className="text-[12px] text-text-secondary">YAML 파일 가져오기 (최대 256KB)</label>
              <input
                id="workflow-import-file"
                type="file"
                accept=".yaml,.yml"
                onChange={(e) => void handleFile(e.currentTarget.files?.[0])}
                className="max-w-full text-xs text-text-primary"
              />
              {fileError && <p role="alert" className="text-[11px] text-error">{fileError}</p>}
            </div>
          )}
          {mode === 'ai' && (
            <div className="px-3 py-4 text-[12px] text-text-tertiary">
              The NL prompt panel is open. Describe your workflow there to let R3 synthesize trigger + nodes for you.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-t-md border-b-2 px-3 py-2 text-[11px] font-medium ${
        active ? 'border-accent text-accent' : 'border-transparent text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function TemplatePicker({
  query,
  onPick,
}: {
  query: ReturnType<typeof useQuery<WorkflowTemplateList>>;
  onPick: (template: WorkflowTemplateEntry) => void;
}) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-4 text-[11px] text-text-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading templates…
      </div>
    );
  }
  if (query.isError) {
    return <div className="px-2 py-4 text-[11px] text-error">Failed to load templates.</div>;
  }
  const items = query.data?.templates ?? [];
  if (items.length === 0) {
    return <div className="px-2 py-4 text-[11px] text-text-tertiary">No templates available.</div>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-left text-xs hover:border-accent/40 hover:bg-surface-elevated"
        >
          <span className="font-medium text-text-primary">{t.title}</span>
          <span className="line-clamp-2 text-[11px] text-text-tertiary">{t.description}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {t.tags.map((tag) => (
              <span key={tag} className="rounded-full border border-border bg-surface px-1.5 py-0.5 text-[9px] text-text-tertiary">
                {tag}
              </span>
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}

function BlankPanel({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      <p className="text-[12px] text-text-secondary">
        Start with a 2-node manual-trigger scaffold. Edit names + bodies in the editor, then click ▶ Run now to fire.
      </p>
      <pre className="rounded-md border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed text-text-primary">{BLANK_YAML}</pre>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onCreate}
          className="rounded-md bg-accent px-4 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover"
        >
          Create
        </button>
      </div>
    </div>
  );
}
