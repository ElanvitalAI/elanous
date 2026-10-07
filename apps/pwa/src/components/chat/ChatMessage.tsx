'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { MARKDOWN_REMARK_PLUGINS } from '@/lib/markdown-render';
import { extractElanousCards } from '@/lib/elanous-card';
import { ElanousCard } from './ElanousCard';
import { ContextSourcesCard } from './ContextSourcesCard';
import { HarnessAskCard } from './HarnessAskCard';
import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage as ChatMessageT } from '@/lib/chat-runtime';
import { CollapsibleCodeBlock } from '@/components/agent/CollapsibleCodeBlock';
import { ThinkingPill } from './blocks/ThinkingPill';
import { StatusChip } from './blocks/StatusChip';
import { PlanBlock } from './blocks/PlanBlock';
import { DiffBlock } from './blocks/DiffBlock';
import { SearchHitList } from './blocks/SearchHitList';
import { ToolProgressCard } from './blocks/ToolProgressCard';
import { PerfTickSparkline } from './blocks/PerfTickSparkline';
import { McpAppBlock } from './blocks/McpAppBlock';

const MARKDOWN_COMPONENTS = { pre: CollapsibleCodeBlock };

interface Props {
  message: ChatMessageT;
  mobileSimple?: boolean;
}

/** REL9p — cards only in daemon-side messages; a user's own text is shown exactly as typed. */
function CardTextBody({ text, showCards }: { text: string; showCards: boolean }) {
  if (!showCards) return <MarkdownBody text={text} />;
  const extracted = extractElanousCards(text);
  return (
    <>
      {extracted.text.trim() && <MarkdownBody text={extracted.text} />}
      {extracted.cards.map((card, index) => <ElanousCard key={index} card={card} />)}
    </>
  );
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_code]:font-mono [&_code]:text-xs [&_p]:my-1 [&_table]:text-xs">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Phase B-3 (PWA chat streaming · 2026-05-06) — tool lifecycle pill.
 *  Collapsed: status icon + tool name + 1-line summary. Expanded
 *  (click to toggle): args JSON for inspection. Status icon glyphs
 *  are picked so a screen reader / inspector can distinguish them
 *  even when CSS is stripped: `⋯` running, `✓` done, `✗` error. */
function ToolPill({
  block,
  children,
  mobileSimple = false,
}: {
  block: Extract<ChatBlock, { kind: 'tool_use' }>;
  children?: React.ReactNode;
  mobileSimple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const icon =
    block.status === 'running' ? '⋯' : block.status === 'done' ? '✓' : '✗';
  const tone =
    block.status === 'running'
      ? 'text-muted-foreground border-border'
      : block.status === 'error'
        ? 'text-destructive border-destructive/40'
        : 'text-foreground border-border';
  const hasDetails = mobileSimple || (!!block.args && Object.keys(block.args).length > 0) || !!children;
  const timing = [block.startedAt, block.endedAt]
    .filter((value): value is number => typeof value === 'number')
    .map((value) => new Date(value).toLocaleTimeString())
    .join(' → ');
  return (
    <div
      data-elanous-block-kind="tool_use"
      data-elanous-tool-name={block.name}
      data-elanous-tool-status={block.status}
      className={cn(
        'rounded border bg-muted/40 px-2 py-1 text-xs font-mono',
        mobileSimple && 'min-w-0',
        tone,
      )}
    >
      <button
        type="button"
        onClick={hasDetails ? () => setOpen(!open) : undefined}
        className={cn(
          'flex w-full items-center gap-2 text-left',
          mobileSimple && 'min-w-0 overflow-hidden whitespace-nowrap',
          hasDetails ? 'cursor-pointer' : 'cursor-default',
        )}
        aria-expanded={hasDetails ? open : undefined}
      >
        <span aria-hidden="true">{icon}</span>
        <span className="font-semibold">{block.name}</span>
        {block.summary && (
          <span className="ml-1 truncate text-muted-foreground">
            {block.summary}
          </span>
        )}
        {timing && <span className="ml-auto text-muted-foreground">{timing}</span>}
        {hasDetails && (
          <span className="ml-auto text-muted-foreground" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {open && hasDetails && (mobileSimple ? (
        <div>
          {!!block.args && Object.keys(block.args).length > 0 && <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-1.5 text-[10px] leading-tight">
            {JSON.stringify(block.args, null, 2)}
          </pre>}
          {children}
        </div>
      ) : <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-1.5 text-[10px] leading-tight">
        {JSON.stringify(block.args, null, 2)}
      </pre>)}
    </div>
  );
}

/** Phase B-2/B-3 (PWA chat streaming · 2026-05-06) — multimodal block
 *  renderer. text → markdown; image → inline `<img>`; tool_use →
 *  status pill with optional args expand. */
function BlocksBody({ blocks, showCards, mobileSimple = false }: { blocks: ChatBlock[]; showCards: boolean; mobileSimple?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, idx) => {
        if (block.kind === 'harness_ask') {
          return <HarnessAskCard key={`${block.acceptanceId}-${idx}`} acceptanceId={block.acceptanceId} />;
        }
        if (block.kind === 'text') {
          return <CardTextBody key={idx} text={block.text} showCards={showCards} />;
        }
        if (block.kind === 'image') {
          return (
            <img
              key={idx}
              src={block.src}
              alt={block.alt ?? `inline image (${block.mediaType})`}
              className="max-w-full rounded border border-border"
              data-elanous-block-kind="image"
              data-elanous-media-type={block.mediaType}
            />
          );
        }
        if (block.kind === 'tool_use') {
          return (
            <div key={`${block.id}-${idx}`}>
              <ToolPill block={block} mobileSimple={mobileSimple} {...(mobileSimple && block.sources?.length ? { children: <ContextSourcesCard sources={block.sources} /> } : {})} />
              {!mobileSimple && <ContextSourcesCard sources={block.sources} />}
            </div>
          );
        }
        if (block.kind === 'mcp_app') {
          return <McpAppBlock key={`${block.toolId}-${idx}`} block={block} />;
        }
        // M3 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
        // Feedback Envelope-derived blocks. Merge key is the
        // envelope blockId so React's reconciler keeps the same
        // node across phase=start → delta → end (no remount, no
        // animation reset).
        if (block.kind === 'agent_thinking') {
          return <ThinkingPill key={`thinking-${block.blockId}`} block={block} />;
        }
        if (block.kind === 'agent_status') {
          return <StatusChip key={`status-${block.blockId}`} block={block} />;
        }
        if (block.kind === 'agent_plan') {
          return <PlanBlock key={`plan-${block.blockId}`} block={block} />;
        }
        // M4 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
        // tool.diff / tool.search-hit renderers. Same blockId merge
        // discipline as the M3 agent.* blocks.
        if (block.kind === 'tool_diff') {
          return <DiffBlock key={`diff-${block.blockId}`} block={block} />;
        }
        if (block.kind === 'tool_search_hits') {
          return <SearchHitList key={`search-${block.blockId}`} block={block} />;
        }
        if (block.kind === 'tool_progress') {
          return <ToolProgressCard key={`progress-${block.blockId}`} block={block} />;
        }
        // Opportunistic followup §6.2 #6 (2026-05-13) — perf.tick
        // sparkline. One block per session (`<sid>:perf:session`),
        // SVG rendering of last 60 samples per metric.
        if (block.kind === 'perf_session') {
          return <PerfTickSparkline key={`perf-${block.blockId}`} block={block} />;
        }
        return null;
      })}
    </div>
  );
}

export function ChatMessageView({ message, mobileSimple = false }: Props) {
  const isUser = message.role === 'user';
  const isMeta = message.role === 'meta';
  const isSystem = message.role === 'system';
  const time = new Date(message.timestamp).toLocaleTimeString();

  if (isMeta) {
    return (
      <div className="px-2 py-1 text-[11px] text-muted-foreground italic">
        <pre className="whitespace-pre-wrap font-mono text-[11px]">{message.text}</pre>
        {message.blocks?.some((block) => block.kind === 'harness_ask') &&
          <BlocksBody blocks={message.blocks} showCards={false} mobileSimple={mobileSimple} />}
      </div>
    );
  }

  // PP-9 — daemon-classified system message (REPL meta-command output
  // that used to echo into xterm via ANSI \x1b[31m / \x1b[2m). Renders
  // a red badge for `error`, dim italic for `note`. The styling has to
  // be loud enough to distinguish from a normal agent reply but not so
  // loud that an `:agent error — abort` looks like a fatal runtime crash.
  if (isSystem) {
    const level = message.meta?.systemLevel ?? 'note';
    const isError = level === 'error';
    return (
      <div className="px-3 py-2">
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-xs font-mono',
            isError
              ? 'border-rose-500/60 bg-rose-500/10 text-rose-300'
              : 'border-border/60 bg-muted/40 text-muted-foreground italic',
          )}
        >
          <div className="flex items-baseline gap-2">
            <span className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide',
              isError ? 'text-rose-400' : 'text-muted-foreground/70')}
            >
              {isError ? '⚠ Error' : 'Note'}
            </span>
            <pre className="flex-1 whitespace-pre-wrap break-all">{message.text}</pre>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground/80">{time}</div>
        </div>
      </div>
    );
  }

  // Phase B-2 — when the SSE consumer attached a blocks list, render
  // it instead of the flat text. Empty blocks fall back to the text
  // path so a placeholder message (B-1) still streams correctly.
  const useBlocks = Array.isArray(message.blocks) && message.blocks.length > 0;

  return (
    <div className={cn('flex gap-3 px-4 py-3', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-card text-card-foreground border border-border',
        )}
      >
        {useBlocks
          ? <BlocksBody blocks={message.blocks!} showCards={!isUser} mobileSimple={mobileSimple} />
          : <CardTextBody text={message.text} showCards={!isUser} />}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{time}</span>
          {/* ⭐ 어느 터미널과의 대화인가 — 웹터미널 Dock 만 채운다. 없으면 안 그린다.
              탭을 바꿔도 이 배지는 «그 메시지가 나눈 상대»를 계속 말한다. */}
          {message.terminalId && (
            <span
              title="이 메시지가 나눈 터미널"
              className="rounded border border-border/60 bg-muted/60 px-1 font-mono text-[9px] leading-4"
            >
              {message.terminalId}
            </span>
          )}
          {message.meta?.provider && (
            <span title="답한 LLM">
              · {message.meta.provider}
              {message.meta.model ? ` · ${message.meta.model}` : ''}
            </span>
          )}
          {message.meta?.stopReason && <span>· {message.meta.stopReason}</span>}
        </div>
      </div>
    </div>
  );
}
