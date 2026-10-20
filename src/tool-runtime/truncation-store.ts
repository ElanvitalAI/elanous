import { promises as fsp } from 'fs';
import { join, dirname } from 'path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ChatToolOutputConfig } from '../user-config.js';

function defaultToolResultsRoot(): string {
  return join(effectiveInstanceRoot(), 'tool-results');
}
/** 넘침 파일 뿌리 — TUI 가 «넘침 파일 다시 읽기» 를 잡무로 접을 때 같은 뿌리로 판별한다(TUI-TURN-NARRATION FU-5). */
export function toolResultsRoot(): string {
  return defaultToolResultsRoot();
}
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const lastSweepAt = new Map<string, number>();

export interface PersistToolOutputOpts {
  sessionId: string;
  toolName: string;
  config: ChatToolOutputConfig;
  allowAgentReference?: boolean;
  baseDir?: string;
  nowMs?: number;
}

export interface PersistToolOutputResult {
  output: string;
  persisted: boolean;
  path?: string;
  previewLines: number;
  totalLines: number;
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'unknown';
}

function formatReferenceLine(path: string, allowAgentReference: boolean): string {
  return allowAgentReference
    ? `... Full output saved to \`${path}\`. Delegate further reading to the Agent tool.`
    : `... Full output saved to \`${path}\`. Read with offset/limit or Grep against that path.`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

export async function sweepToolResults(
  opts: { baseDir?: string; retentionDays?: number; nowMs?: number } = {},
): Promise<{ removedFiles: number; removedDirs: number }> {
  const baseDir = opts.baseDir ?? defaultToolResultsRoot();
  const cutoffMs = (opts.nowMs ?? Date.now()) - ((opts.retentionDays ?? 7) * 24 * 60 * 60 * 1000);
  let removedFiles = 0;
  let removedDirs = 0;

  async function walk(dir: string): Promise<boolean> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      let hasChildren = false;
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          const childHasChildren = await walk(path);
          if (!childHasChildren) {
            try {
              await fsp.rmdir(path);
              removedDirs++;
            } catch { /* best-effort */ }
          } else {
            hasChildren = true;
          }
          continue;
        }
        try {
          const stat = await fsp.stat(path);
          if (stat.mtimeMs < cutoffMs) {
            await fsp.unlink(path);
            removedFiles++;
          } else {
            hasChildren = true;
          }
        } catch { /* best-effort */ }
      }
      if (!hasChildren) {
        try {
          const rest = await fsp.readdir(dir);
          return rest.length > 0;
        } catch {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  await walk(baseDir);
  return { removedFiles, removedDirs };
}

async function sweepIfDue(baseDir: string, retentionDays: number, nowMs: number): Promise<void> {
  const last = lastSweepAt.get(baseDir) ?? 0;
  if (nowMs - last < SWEEP_INTERVAL_MS) return;
  lastSweepAt.set(baseDir, nowMs);
  await sweepToolResults({ baseDir, retentionDays, nowMs });
}

export async function persistToolOutputPreview(
  text: string,
  opts: PersistToolOutputOpts,
): Promise<PersistToolOutputResult> {
  const totalLines = countLines(text);
  const previewLines = opts.config.previewLines;
  if (!opts.config.persistOnOverflow || totalLines <= previewLines) {
    return { output: text, persisted: false, previewLines, totalLines };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const baseDir = opts.baseDir ?? defaultToolResultsRoot();
  await sweepIfDue(baseDir, opts.config.retentionDays, nowMs);

  const sessionId = sanitizeSegment(opts.sessionId);
  const toolName = sanitizeSegment(opts.toolName);
  const fileId = `${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const path = join(baseDir, sessionId, `${toolName}-${fileId}`);
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, text, 'utf-8');

  const preview = text.split('\n').slice(0, previewLines).join('\n').trimEnd();
  const referenceLine = formatReferenceLine(path, !!opts.allowAgentReference);
  return {
    output: preview ? `${preview}\n${referenceLine}` : referenceLine,
    persisted: true,
    path,
    previewLines,
    totalLines,
  };
}

export function toolOutputStoreRoot(): string {
  return defaultToolResultsRoot();
}
