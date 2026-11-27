/**
 * ELN-PERSISTENCE-LADDER ③ — 목표 루프의 «진척» 판정(pure · §⑫ OP orders ELN-UNIVERSAL-AGENT-1124 · OP #144681).
 * 턴 상한 끊음은 «진척 없음» 기준만: 진척 = 새 파일 · 새 근거 · 새 산출.
 * run-goal-loop ⑥ spin 검출(동일 tool 시그니처 반복)이 같은 시그니처여도 새 산물을 냈는지 묻는 단일 입구.
 * 같은 도구를 다시 불러도 결과 내용이 달라졌거나(새 근거·새 산출) 새 파일 경로에 썼으면(새 파일)
 * 무진척이 아니다 — 루프는 이어 돈다(doneWhen 판정식 또는 탐색 사다리 ⑥ 까지).
 */
import type { LLMMessage } from '../llm.js';

/** 한 턴이 남긴 관측 가능한 산물 토큰 — 새 파일 경로 · 결과 내용 해시 · 도구 이름. */
export interface ProgressTokens {
  readonly filePaths: ReadonlySet<string>;
  readonly resultHashes: ReadonlySet<string>;
  readonly toolNames: ReadonlySet<string>;
}

export const EMPTY_PROGRESS_TOKENS: ProgressTokens = { filePaths: new Set<string>(), resultHashes: new Set<string>(), toolNames: new Set<string>() };

/** 쓰기 계열 도구 — 대상 경로가 «새 파일» 토큰이 된다(이름 집합은 대소문자 그대로). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'multi_edit',
]);

function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `r${(h >>> 0).toString(36)}`;
}

/** 턴의 새 메시지에서 진척 토큰을 모은다 — tool_use 는 이름·쓰기 경로, tool_result 는 내용 해시. */
export function progressTokens(newMessages: readonly LLMMessage[]): ProgressTokens {
  const filePaths = new Set<string>();
  const resultHashes = new Set<string>();
  const toolNames = new Set<string>();
  for (const m of newMessages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      const type = b['type'];
      if (type === 'tool_use') {
        const name = String(b['name'] ?? '');
        if (!name) continue;
        toolNames.add(name);
        if (!WRITE_TOOL_NAMES.has(name)) continue;
        const input = (b['input'] ?? {}) as Record<string, unknown>;
        for (const key of ['file_path', 'path', 'filePath']) {
          const v = input[key];
          if (typeof v === 'string' && v) filePaths.add(v);
        }
        const many = input['files'] ?? input['edits'];
        if (Array.isArray(many)) {
          for (const f of many) {
            const one = f as Record<string, unknown>;
            for (const key of ['path', 'file_path', 'filePath']) {
              const v = one[key];
              if (typeof v === 'string' && v) filePaths.add(v);
            }
          }
        }
      } else if (type === 'tool_result') {
        const raw = b['content'] ?? b['text'] ?? '';
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
        resultHashes.add(hashText(text));
      }
    }
  }
  return { filePaths, resultHashes, toolNames };
}

/** prev 턴에 없던 산물이 curr 턴에 하나라도 있으면 진척(true) — 없으면 무진척(false). */
export function progressBeyondSignature(prev: ProgressTokens, curr: ProgressTokens): boolean {
  for (const p of curr.filePaths) if (!prev.filePaths.has(p)) return true;
  for (const r of curr.resultHashes) if (!prev.resultHashes.has(r)) return true;
  for (const t of curr.toolNames) if (!prev.toolNames.has(t)) return true;
  return false;
}