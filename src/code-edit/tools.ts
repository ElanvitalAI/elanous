import type { LLMToolSpec } from '../llm/tool-spec.js';
// LLM tool descriptors + dispatchers — Phase CE2.
//
// Three tools: Read, Edit, Write. Descriptors follow the spec of
// claude-code-fork's FileEdit/FileRead/FileWrite verbatim where it
// matters (schema shape + read-before-edit language) so LLMs trained
// on or exposed to that UX hit the same patterns.
//
// Each dispatcher takes the raw tool args (as the LLM emitted them),
// validates + coerces, calls the apply.ts helpers, and returns a
// `{ output: string, edit?: EditResult }` shape. The optional `edit`
// field lets downstream UI (the diff renderer) pick up the structured
// patch without re-parsing the text output.


import { debug } from '../debug/log.js';
import { ReadFileStateStore } from './read-state.js';
import { applyEdit, applyRead, applyWrite } from './apply.js';
import { EditErrorCode } from './types.js';
import type { EditOutcome, EditResult } from './types.js';

// ── Singleton store (process-lifetime) ───────────────────────────
// One store per process. Created lazily so tests can bypass it by
// passing an explicit store to the apply.ts helpers. Production
// callers (dashboard) use this singleton.

let _store: ReadFileStateStore | null = null;

export function getCodeEditStore(): ReadFileStateStore {
  if (!_store) _store = new ReadFileStateStore();
  return _store;
}

/** For tests — swap in a scoped store and get a disposer. */
export function _setCodeEditStoreForTesting(store: ReadFileStateStore | null): () => void {
  const prev = _store;
  _store = store;
  return () => { _store = prev; };
}

// ── Dispatcher output shape ──────────────────────────────────────

export interface CodeEditDispatchResult {
  output: string;
  /** Present on successful Edit/Write so the dashboard can hand the
   *  structured patch to the diff renderer without re-parsing. */
  edit?: EditResult;
}

// ── Read ─────────────────────────────────────────────────────────

export function buildReadTool(): LLMToolSpec {
  return {
    name: 'Read',
    description:
      'Read a file from disk and record that the file has been read this turn, enabling Edit/Write on it. '
      + 'Use offset/limit for very large files — note that partial reads block subsequent Edit calls (you '
      + 'need a full re-Read before editing). Returns the file content as text.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        offset: { type: 'integer', description: '0-indexed starting line. Omit for full file.' },
        limit: { type: 'integer', description: 'Number of lines to return starting at offset.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  };
}

export async function dispatchRead(
  raw: Record<string, unknown>,
  store: ReadFileStateStore = getCodeEditStore(),
): Promise<CodeEditDispatchResult> {
  const file_path = typeof raw.file_path === 'string' ? raw.file_path : '';
  const offset = typeof raw.offset === 'number' ? raw.offset : undefined;
  const limit = typeof raw.limit === 'number' ? raw.limit : undefined;
  const r = await applyRead(file_path, store, { offset, limit });
  if (!r.ok) return { output: `Read failed: ${r.message}` };
  const header = r.truncated
    ? `Read ${file_path} (showing ${offset ?? 0}..${(offset ?? 0) + (limit ?? 0) - 1} of ${r.lines} lines)\n`
    : `Read ${file_path} (${r.lines} lines)\n`;
  return { output: header + r.content };
}

// ── Edit ─────────────────────────────────────────────────────────

export function buildEditTool(): LLMToolSpec {
  return {
    name: 'Edit',
    description:
      'Performs exact string replacements in a file. Supports batching multiple edits in one call.\n\n'
      + 'Usage:\n'
      + '- You MUST use Read on the file at least once in this conversation before Edit. Edit will error otherwise.\n'
      + '- `old_string` must uniquely identify the text to replace. If it appears more than once, either include more surrounding context to make it unique, or set `replace_all: true`.\n'
      + '- When editing text from Read output, preserve the exact indentation as it appears after the line-number prefix. The prefix format is `NNN<tab>`; everything after that tab is the real content.\n'
      + '- ALWAYS prefer editing existing files over creating new ones. NEVER write new files unless explicitly required.\n'
      + '- Edits apply in order; the first failure stops the batch and reports its editIndex.\n'
      + '- AU3: If the intent behind the edit is ambiguous (multiple valid approaches, unclear which function to modify, or destructive replace that the user did not explicitly request), call AskUserQuestion FIRST. One question beats a long rollback.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file.' },
        edits: {
          type: 'array',
          description: 'Batch of substitutions. Apply in order; first failure stops the batch.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to find.' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
          minItems: 1,
        },
      },
      required: ['file_path', 'edits'],
      additionalProperties: false,
    },
  };
}

export async function dispatchEdit(
  raw: Record<string, unknown>,
  store: ReadFileStateStore = getCodeEditStore(),
): Promise<CodeEditDispatchResult> {
  const file_path = typeof raw.file_path === 'string' ? raw.file_path : '';
  const editsRaw = Array.isArray(raw.edits) ? raw.edits : [];
  const edits = editsRaw.map((e) => {
    const o = e as Record<string, unknown>;
    return {
      old_string: typeof o.old_string === 'string' ? o.old_string : '',
      new_string: typeof o.new_string === 'string' ? o.new_string : '',
      replace_all: o.replace_all === true,
    };
  });
  let outcome: EditOutcome = await applyEdit({ file_path, edits }, store);
  // ── Self-healing 툴콜링(2026-07-11) — partial-read Edit 자동복구 ───────────
  // 파일을 "부분 읽기(offset/limit)" 한 뒤 Edit 하면 partialView 가드로 막힌다(전체
  // 재읽기 필요). codex 계열(gpt-5.6-sol/terra)은 큰 파일을 offset/limit 로 부분 읽는
  // 습관이 있어 이 가드에 걸려 편집 자체를 시작 못 하는 병리가 있었다(elanous-self 튜닝
  // dogfood 2026-07-11). 이 경우 에러가 지시하는 행동(전체 파일 재읽기)을 자동 수행 후
  // 1회 재시도한다 — 모델이 파일을 이미 본(부분이라도) 상태이므로 안전하고, 전체 재읽기
  // 후 old_string 이 매칭되면 적용, 아니면 명확한 mismatch 로 실패. 반면 "한 번도 안 읽음"
  // (verifyBeforeEdit === null)은 복구하지 않는다 — 모델이 파일을 보게 하는 정당한 가드.
  if (!outcome.ok && outcome.code === EditErrorCode.NotReadFirst) {
    const entry = store.verifyBeforeEdit(file_path);
    if (entry && entry.partialView) {
      const reread = await applyRead(file_path, store); // opts 없음 = 전체 읽기·partialView=false
      if (reread.ok) {
        const retry: EditOutcome = await applyEdit({ file_path, edits }, store);
        if (retry.ok && debug.enabled) {
          debug.log('code-edit.dispatch', 'edit.autorecovered', {
            file_path, editCount: edits.length, firstError: outcome.message,
          });
        }
        outcome = retry; // 성공이면 적용, 실패면 재시도의 에러(예: old_string mismatch)를 보고
      }
    }
  }
  if (!outcome.ok) {
    if (debug.enabled) {
      debug.log('code-edit.dispatch', 'edit.failed', {
        file_path,
        editCount: edits.length,
        message: outcome.message,
      }, { level: 'error' });
    }
    return { output: `Edit failed: ${outcome.message}` };
  }
  if (debug.enabled) {
    debug.log('code-edit.dispatch', 'edit.applied', {
      file_path: outcome.file_path,
      editCount: edits.length,
      linesAdded: outcome.linesAdded,
      linesRemoved: outcome.linesRemoved,
    });
  }
  const summary = `Update(${outcome.file_path}) — +${outcome.linesAdded} / -${outcome.linesRemoved}`;
  return { output: summary, edit: outcome };
}

// ── Write ────────────────────────────────────────────────────────

export function buildWriteTool(): LLMToolSpec {
  return {
    name: 'Write',
    description:
      'Create a new file or overwrite an existing one with the given content.\n\n'
      + 'Usage:\n'
      + '- For existing files, you MUST Read them first (same invariant as Edit). This confirms you know what you are overwriting.\n'
      + '- Prefer Edit for partial changes to existing files; use Write for: brand-new files, OR full rewrites where dozens of small edits would be clearer as one replacement.\n'
      + '- NEVER create documentation files (*.md) or README unless explicitly requested.\n'
      + '- The content should be the COMPLETE file contents, not a diff.\n'
      + '- AU3: A Write that OVERWRITES a non-empty user-authored file is destructive. If the user did not explicitly ask for a rewrite, call AskUserQuestion first and offer: (a) Edit in place, (b) Write new file alongside, (c) Overwrite. Defaulting to overwrite silently is the most common regret.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write.' },
        content: { type: 'string', description: 'Complete file contents.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  };
}

export async function dispatchWrite(
  raw: Record<string, unknown>,
  store: ReadFileStateStore = getCodeEditStore(),
): Promise<CodeEditDispatchResult> {
  const file_path = typeof raw.file_path === 'string' ? raw.file_path : '';
  const content = typeof raw.content === 'string' ? raw.content : '';
  const outcome: EditOutcome = await applyWrite({ file_path, content }, store);
  if (!outcome.ok) {
    if (debug.enabled) {
      debug.log('code-edit.dispatch', 'write.failed', {
        file_path,
        contentLen: content.length,
        message: outcome.message,
      }, { level: 'error' });
    }
    return { output: `Write failed: ${outcome.message}` };
  }
  const verb = outcome.linesRemoved === 0 && outcome.originalContent === '' ? 'Create' : 'Write';
  if (debug.enabled) {
    debug.log('code-edit.dispatch', 'write.applied', {
      file_path: outcome.file_path,
      verb,
      contentLen: content.length,
      linesAdded: outcome.linesAdded,
      linesRemoved: outcome.linesRemoved,
    });
  }
  const summary = `${verb}(${outcome.file_path}) — +${outcome.linesAdded} / -${outcome.linesRemoved}`;
  return { output: summary, edit: outcome };
}
