import { goalFilePath } from '../../tui-client/goal-file-harness-command.js';
import { runGoalFileHarnessCommand } from '../../tui-client/goal-file-harness-command.js';
import { runLocalHarnessCommand } from '../../tui-client/local-harness-command.js';

export type ClassicHarnessPreview =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'preview'; readonly source: 'file' | 'prose'; readonly value: string };

/** Keep a requested preview out of the classic live author-and-launch path. */
export function resolveClassicHarnessPreview(input: string): ClassicHarnessPreview {
  const trimmed = input.trim();
  if (!/^--dry-run(?:\s|$)/u.test(trimmed)) return { kind: 'ordinary' };
  const value = trimmed.slice('--dry-run'.length).trim();
  if (!value) return { kind: 'invalid', reason: '사용법: /harness ask --dry-run <목표 또는 골 파일>' };
  const path = goalFilePath(value);
  if (path) return { kind: 'preview', source: 'file', value: path };
  const quoted = /^(["'])(.*)\1$/su.exec(value)?.[2];
  if ((quoted ?? value).endsWith('.md') && (quoted !== undefined || !/\s/u.test(value))) {
    return { kind: 'invalid', reason: `골 파일을 찾을 수 없습니다: ${value}` };
  }
  return { kind: 'preview', source: 'prose', value };
}

/** Execute only a parsed preview, using the same CLI adapters as Next TUI. */
export function runClassicHarnessPreview(
  preview: Extract<ClassicHarnessPreview, { readonly kind: 'preview' }>,
  signal: AbortSignal,
  onLine: (line: string) => void,
  cli = process.argv[1],
): Promise<void> {
  return preview.source === 'file'
    ? runGoalFileHarnessCommand(preview.value, true, signal, onLine, cli)
    : runLocalHarnessCommand('ask', `--dry-run ${preview.value}`, signal, onLine, cli);
}
