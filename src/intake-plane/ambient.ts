import { createTextChannelIntakeRecord } from './adapters/text.js';
import { buildIntakePresentationLines } from './presenter.js';
import { getIntakeStore } from './runtime.js';
import { ingestIntakeRecord } from './service.js';
import type { IntakeStore } from './store.js';
import type { RawIntakeRecord } from './types.js';
import type { NormalizedAttachment } from '../acp/content-blocks.js';
import type { IntakeAmbientCaptureMode } from '../user-config/types.js';

type AmbientSurface = 'telegram' | 'discord';

export interface AmbientIntakeContext {
  surface: AmbientSurface;
  source: 'telegram' | 'discord';
  text: string;
  attachments?: NormalizedAttachment[];
  actor?: RawIntakeRecord['actor'];
  channelContext?: RawIntakeRecord['channelContext'];
  receivedAt?: string;
  mode?: IntakeAmbientCaptureMode;
  store?: IntakeStore;
  now?: () => Date;
  createIntakeId?: () => string;
}

export interface AmbientDetection {
  matched: boolean;
  reason?: string;
  score?: number;
}

const URL_RE = /https?:\/\/\S+/gi;
const BULLET_RE = /^\s*(?:[-*•]|\d+\.)\s+/;
const SEPARATOR_RE = /^[=\-_*]{4,}$/;

function defaultIntakeId(now: Date): string {
  return `intake-${now.toISOString().replace(/[:.]/g, '-').toLowerCase()}`;
}

export function detectAmbientIntakeCandidate(text: string): AmbientDetection {
  const trimmed = text.trim();
  if (!trimmed) return { matched: false };
  if (/^(?:\/|!)\S+/.test(trimmed)) return { matched: false };
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletCount = lines.filter((line) => BULLET_RE.test(line)).length;
  const separatorCount = lines.filter((line) => SEPARATOR_RE.test(line)).length;
  const urlCount = (trimmed.match(URL_RE) ?? []).length;
  const longText = trimmed.length >= 180;
  const multiLine = lines.length >= 3;
  const score = (
    (multiLine ? 1 : 0)
    + (bulletCount >= 2 ? 2 : 0)
    + (separatorCount >= 1 ? 1 : 0)
    + (urlCount >= 2 ? 2 : urlCount >= 1 ? 1 : 0)
    + (longText ? 1 : 0)
  );
  if (score < 3) return { matched: false, score };
  const reasons: string[] = [];
  if (bulletCount >= 2) reasons.push('multiple bullet items');
  if (urlCount >= 1) reasons.push(`${urlCount} link${urlCount === 1 ? '' : 's'}`);
  if (separatorCount >= 1) reasons.push('note separators');
  if (longText) reasons.push('long memo-like text');
  return {
    matched: true,
    score,
    reason: reasons.join(', '),
  };
}

function captureHintPrefix(surface: AmbientSurface): string {
  return surface === 'telegram' ? '/intake' : '!intake';
}

export async function maybeHandleAmbientTextIntake(
  ctx: AmbientIntakeContext,
): Promise<string | null> {
  const mode = ctx.mode ?? 'off';
  if (mode === 'off') return null;
  const detection = detectAmbientIntakeCandidate(ctx.text);
  if (!detection.matched) return null;
  const prefix = captureHintPrefix(ctx.surface);
  if (mode === 'suggest') {
    return [
      `This looks like a scratch note (${detection.reason ?? 'memo-like text'}).`,
      `capture: ${prefix} ${ctx.text.slice(0, 80).replace(/\s+/g, ' ')}${ctx.text.length > 80 ? '…' : ''}`,
      `fast paths: ${prefix} now <text...> | ${prefix} backlog <text...> | ${prefix} when <schedule> -- <text...>`,
    ].join('\n');
  }
  const store = ctx.store ?? getIntakeStore();
  const now = ctx.now?.() ?? new Date();
  const intakeId = ctx.createIntakeId?.() ?? defaultIntakeId(now);
  const result = await ingestIntakeRecord(
    store,
    createTextChannelIntakeRecord({
      intakeId,
      source: ctx.source,
      text: ctx.text,
      receivedAt: ctx.receivedAt ?? now.toISOString(),
      attachments: ctx.attachments,
      actor: ctx.actor,
      channelContext: ctx.channelContext,
    }),
    { mode: 'review' },
  );
  return [
    `Ambient intake: ${result.intakeId} [${result.state}]`,
    `reason: ${detection.reason ?? 'memo-like text'}`,
    ...buildIntakePresentationLines(result.session, ctx.surface, {
      heading: `title: ${result.session.draft?.title ?? result.intakeId}`,
    }).slice(1),
  ].join('\n');
}
