// ROADMAP Tier 1 W2 (2026-05-11) — inline node editor.
//
// When the user clicks a node card in WorkflowGraph, the parent
// WorkflowsPanel routes the id here and renders a variant-aware form
// in a bottom drawer (iPad) / side panel (desktop). Auto-save fires
// on a 500ms debounce after the last field change so the user never
// hits an explicit Save in this surface — the workflow's outer Save
// button (panel footer) still gates the write to disk.
//
// Why a separate file: the form is variant-specific enough that
// inlining it into WorkflowGraph would push that module past the
// "single responsibility" line. Keeping it here also makes the
// editor reusable for the future Tier 4 quick-run modal.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import {
  classifyNodeVariant,
  nodeBadgeLabel,
  type NodeVariant,
  type WorkflowDefinitionLike,
} from './workflow-graph-layout';
import { editNode, type NodeEditPatch } from './workflow-graph-mutations';
import { ScheduleTriggerEditor } from './triggers/ScheduleTriggerEditor';
import { WebhookTriggerEditor } from './triggers/WebhookTriggerEditor';
import { HttpRequestEditor } from './triggers/HttpRequestEditor';
import { DiscordTriggerEditor } from './triggers/DiscordTriggerEditor';
import { TelegramTriggerEditor } from './triggers/TelegramTriggerEditor';
import { ManualTriggerEditor } from './triggers/ManualTriggerEditor';
import { ChatTriggerEditor } from './triggers/ChatTriggerEditor';
import { SchemaForm, type SchemaValue } from './SchemaForm';
import type { GraphKindEntry } from '@/nexus/client';

interface WorkflowNodeEditorProps {
  /** Parsed workflow definition the form pulls the current node from. */
  definition: WorkflowDefinitionLike;
  /** Currently-selected node id. */
  nodeId: string;
  /** Available skill names (Tier 1 W1's catalog hook) — when set, the
   *  skill variant renders a datalist for autocomplete. */
  skills?: string[];
  /** Called after the 500ms debounce with the patched definition.
   *  Parent should pipe through definitionToYaml + setDraftYaml. */
  onChange: (next: WorkflowDefinitionLike) => void;
  /** Called when the user clicks the close X. */
  onClose: () => void;
  /** Called when the user clicks "Delete node" — parent invokes the
   *  existing `defDeleteNode` helper. */
  onDelete: () => void;
  /** Server vocabulary (`GET /v1/graph/kinds?graph=workflow`). A plugin
   *  kind that carries a `schema` gets a generated form for `inputs`. */
  palette?: GraphKindEntry[];
}

const AUTO_SAVE_DEBOUNCE_MS = 500;

export function WorkflowNodeEditor({
  definition,
  nodeId,
  skills,
  onChange,
  onClose,
  onDelete,
  palette,
}: WorkflowNodeEditorProps) {
  const node = useMemo(
    () => (definition.nodes ?? []).find((n) => n.id === nodeId) ?? null,
    [definition, nodeId],
  );

  // Local form state — initialized from the node, updates live, fires
  // a debounced commit upstream. Resetting key when nodeId changes so
  // the form rehydrates cleanly on selection switch (no stale draft
  // from the previous node leaks into the new one).
  const variant = useMemo<NodeVariant>(() => (node ? classifyNodeVariant(node) : 'unknown'), [node]);
  const [draftId, setDraftId] = useState<string>(node?.id ?? '');
  const [draftBash, setDraftBash] = useState<string>(typeof node?.['bash'] === 'string' ? (node['bash'] as string) : '');
  const [draftPrompt, setDraftPrompt] = useState<string>(typeof node?.['prompt'] === 'string' ? (node['prompt'] as string) : '');
  const [draftSkill, setDraftSkill] = useState<string>(typeof node?.['skill'] === 'string' ? (node['skill'] as string) : '');
  const [draftArgs, setDraftArgs] = useState<string>(typeof node?.['arguments'] === 'string' ? (node['arguments'] as string) : '');
  const [draftCft, setDraftCft] = useState<string>(typeof node?.['cft'] === 'string' ? (node['cft'] as string) : '');
  const approvalObj =
    node?.['approval'] && typeof node['approval'] === 'object'
      ? (node['approval'] as { message?: string; delivery?: string; capture_response?: boolean })
      : null;
  const [draftApprovalMsg, setDraftApprovalMsg] = useState<string>(approvalObj?.message ?? '');
  const [draftDelivery, setDraftDelivery] = useState<string>(approvalObj?.delivery ?? 'modal');
  const [draftWhen, setDraftWhen] = useState<string>(typeof node?.['when'] === 'string' ? (node['when'] as string) : '');
  const [draftDeps, setDraftDeps] = useState<string[]>(Array.isArray(node?.['depends_on']) ? [...(node!['depends_on'] as string[])] : []);

  // Rehydrate every state when the selected node changes.
  useEffect(() => {
    if (!node) return;
    setDraftId(node.id);
    setDraftBash(typeof node['bash'] === 'string' ? (node['bash'] as string) : '');
    setDraftPrompt(typeof node['prompt'] === 'string' ? (node['prompt'] as string) : '');
    setDraftSkill(typeof node['skill'] === 'string' ? (node['skill'] as string) : '');
    setDraftArgs(typeof node['arguments'] === 'string' ? (node['arguments'] as string) : '');
    setDraftCft(typeof node['cft'] === 'string' ? (node['cft'] as string) : '');
    const a =
      node['approval'] && typeof node['approval'] === 'object'
        ? (node['approval'] as { message?: string; delivery?: string })
        : null;
    setDraftApprovalMsg(a?.message ?? '');
    setDraftDelivery(a?.delivery ?? 'modal');
    setDraftWhen(typeof node['when'] === 'string' ? (node['when'] as string) : '');
    setDraftDeps(Array.isArray(node['depends_on']) ? [...(node['depends_on'] as string[])] : []);
  }, [nodeId, node]);

  // Plugin node `inputs` — schema form (0.2.5 K3). Local draft + debounced
  // commit like the other fields; compared by JSON so the parent → node →
  // draft round trip never re-commits (no render loop).
  const kindSchema = useMemo(() => {
    const kind = typeof node?.['kind'] === 'string' ? (node['kind'] as string) : null;
    return kind ? palette?.find((e) => e.kind === kind && e.schema)?.schema ?? null : null;
  }, [node, palette]);
  const nodeInputs = useMemo<SchemaValue>(() => {
    const raw = node?.['inputs'];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SchemaValue) : {};
  }, [node]);
  const [draftInputs, setDraftInputs] = useState<SchemaValue>(nodeInputs);
  useEffect(() => { setDraftInputs(nodeInputs); }, [nodeId, nodeInputs]);
  useEffect(() => {
    if (!node || !kindSchema) return;
    if (JSON.stringify(draftInputs) === JSON.stringify(nodeInputs)) return;
    const t = setTimeout(() => {
      onChange({ ...definition, nodes: (definition.nodes ?? []).map((n) => (n.id === nodeId ? { ...n, inputs: draftInputs } : n)) });
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draftInputs, nodeInputs, kindSchema, node, nodeId, definition, onChange]);

  // Build a patch from the current draft state. Only includes fields
  // that have actually changed to keep the diff narrow.
  const buildPatch = useCallback((): NodeEditPatch => {
    if (!node) return {};
    const patch: NodeEditPatch = {};
    if (draftId !== node.id && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(draftId)) {
      patch.id = draftId;
    }
    if (variant === 'bash' && draftBash !== node['bash']) patch.bash = draftBash;
    if (variant === 'prompt' && draftPrompt !== node['prompt']) patch.prompt = draftPrompt;
    if (variant === 'skill') {
      if (draftSkill !== node['skill']) patch.skill = draftSkill;
      if (draftArgs !== (node['arguments'] ?? '')) patch.arguments = draftArgs;
    }
    if (variant === 'cft' && draftCft !== node['cft']) patch.cft = draftCft;
    if (variant === 'approval') {
      const orig = approvalObj ?? { message: '', delivery: 'modal' };
      if (draftApprovalMsg !== orig.message || draftDelivery !== (orig.delivery ?? 'modal')) {
        patch.approval = {
          message: draftApprovalMsg,
          delivery: draftDelivery as NonNullable<NodeEditPatch['approval']>['delivery'],
        };
      }
    }
    const origWhen = typeof node['when'] === 'string' ? (node['when'] as string) : '';
    if (draftWhen !== origWhen) patch.when = draftWhen.trim() ? draftWhen : null;
    const origDeps = Array.isArray(node['depends_on']) ? (node['depends_on'] as string[]) : [];
    if (draftDeps.length !== origDeps.length || draftDeps.some((d, i) => origDeps[i] !== d)) {
      patch.depends_on = draftDeps;
    }
    return patch;
  }, [node, variant, approvalObj, draftId, draftBash, draftPrompt, draftSkill, draftArgs, draftCft, draftApprovalMsg, draftDelivery, draftWhen, draftDeps]);

  // Debounced auto-commit. Cleared when the form mounts or unmounts.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!node) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const patch = buildPatch();
      if (Object.keys(patch).length === 0) return;
      const nextDef = editNode(definition, nodeId, patch);
      if (nextDef !== definition) onChange(nextDef);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [node, nodeId, definition, buildPatch, onChange]);

  if (!node) {
    return (
      <div className="border-t border-border bg-surface-elevated px-3 py-3 text-[11px] text-text-tertiary">
        Node not found — it may have been deleted.
      </div>
    );
  }

  // Surface-unification §B1-B7 (2026-05-11) — trigger + http variants
  // route to dedicated editors (Schedule · Webhook · HTTP · Discord ·
  // Telegram · Manual · Chat). The legacy bash/prompt/skill/cft/
  // approval form below stays in place for non-trigger variants.
  if (
    variant === 'scheduleTrigger'
    || variant === 'webhookTrigger'
    || variant === 'http'
    || variant === 'discordTrigger'
    || variant === 'telegramTrigger'
    || variant === 'manualTrigger'
    || variant === 'chatTrigger'
  ) {
    return (
      <div className="border-t border-border bg-surface-elevated">
        <header className="flex items-center justify-between px-3 py-2">
          <span className="font-mono text-xs text-text-primary">{nodeId}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onDelete}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-error hover:bg-error/10"
              title="Delete this node"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-text-tertiary hover:bg-surface"
              aria-label="Close node editor"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </header>
        <div className="px-3 pb-3">
          {variant === 'scheduleTrigger' && (
            <ScheduleTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'webhookTrigger' && (
            <WebhookTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'http' && (
            <HttpRequestEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'discordTrigger' && (
            <DiscordTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'telegramTrigger' && (
            <TelegramTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'manualTrigger' && (
            <ManualTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
          {variant === 'chatTrigger' && (
            <ChatTriggerEditor definition={definition} nodeId={nodeId} onChange={onChange} />
          )}
        </div>
      </div>
    );
  }

  const otherNodes = (definition.nodes ?? []).filter((n) => n.id !== nodeId);

  return (
    <div className="border-t border-border bg-surface-elevated">
      <header className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
            {node ? nodeBadgeLabel(node, variant) : variant}
          </span>
          <span className="font-mono text-xs text-text-primary">{nodeId}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-error hover:bg-error/10"
            title="Delete this node"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-tertiary hover:bg-surface"
            aria-label="Close node editor"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </header>
      <div className="grid grid-cols-1 gap-2 px-3 pb-3 md:grid-cols-2">
        <Field label="id">
          <input
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            spellCheck={false}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
          />
        </Field>
        <Field label="when (gating expression)">
          <input
            value={draftWhen}
            onChange={(e) => setDraftWhen(e.target.value)}
            placeholder={`e.g. "$prev.output == 'ok'"`}
            spellCheck={false}
            className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
          />
        </Field>
        {kindSchema && (
          <SchemaForm schema={kindSchema} value={draftInputs} onChange={setDraftInputs} />
        )}
        {variant === 'bash' && (
          <Field label="bash" full>
            <textarea
              value={draftBash}
              onChange={(e) => setDraftBash(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
            />
          </Field>
        )}
        {variant === 'prompt' && (
          <Field label="prompt" full>
            <textarea
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 text-xs"
            />
          </Field>
        )}
        {variant === 'skill' && (
          <>
            <Field label="skill">
              <input
                value={draftSkill}
                onChange={(e) => setDraftSkill(e.target.value)}
                list="workflow-skill-options"
                spellCheck={false}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
              />
              {skills && skills.length > 0 && (
                <datalist id="workflow-skill-options">
                  {skills.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </Field>
            <Field label="arguments" full>
              <textarea
                value={draftArgs}
                onChange={(e) => setDraftArgs(e.target.value)}
                rows={3}
                spellCheck={false}
                className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
              />
            </Field>
          </>
        )}
        {variant === 'cft' && (
          <Field label="cft" full>
            <input
              value={draftCft}
              onChange={(e) => setDraftCft(e.target.value)}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
            />
          </Field>
        )}
        {variant === 'approval' && (
          <>
            <Field label="message" full>
              <textarea
                value={draftApprovalMsg}
                onChange={(e) => setDraftApprovalMsg(e.target.value)}
                rows={2}
                spellCheck={false}
                className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1 text-xs"
              />
            </Field>
            <Field label="delivery channel">
              <select
                value={draftDelivery}
                onChange={(e) => setDraftDelivery(e.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs"
              >
                <option value="all">all (race)</option>
                <option value="modal">modal (PWA)</option>
                <option value="terminal">terminal</option>
                <option value="telegram">telegram</option>
                <option value="discord">discord</option>
                <option value="pushcut">pushcut</option>
              </select>
            </Field>
          </>
        )}
        <Field label="depends_on" full>
          <DependsOnPicker
            value={draftDeps}
            options={otherNodes.map((n) => n.id)}
            onChange={setDraftDeps}
          />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? 'md:col-span-2' : ''}`}>
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
      {children}
    </label>
  );
}

function DependsOnPicker({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string): void => {
    if (value.includes(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  };
  if (options.length === 0) {
    return <span className="text-[11px] text-text-tertiary">No other nodes to depend on.</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((id) => {
        const active = value.includes(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className={`rounded-md border px-2 py-0.5 font-mono text-[10px] transition-colors ${
              active
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-border text-text-tertiary hover:bg-surface'
            }`}
          >
            {id}
          </button>
        );
      })}
    </div>
  );
}
