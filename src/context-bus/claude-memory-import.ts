/**
 * Claude 자동 기억(`~/.claude/projects/<project>/memory/*.md`) → 엘라누스 장기 기억 저장소
 * (MEMORY-IMPORT-CLAUDE · 대표 10-12). 변환은 `long-term-memory.ts` 의 순수 함수가 맡고, 여기는
 * «파일 읽기 ⊕ 저장(name 중복이면 덮어쓰기)» 만 둔다 — 생산 호출자는 `elanous memory import-claude`
 * (`src/cli/memory-cli.ts`) 다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  importClaudeMemories,
  type ClaudeMemoryFile, type ClaudeMemoryImport, type ClaudeMemoryItem, type ClaudeMemoryType,
} from './long-term-memory.js';

/** 저장소에 쓸 레코드 — 큐레이션 기억 파일 하나로 떨어진다. */
export interface ClaudeMemorySaveRecord {
  /** 같은 name 이 이미 있으면 그 id 로 덮어쓴다. */
  id?: string;
  type: ClaudeMemoryType;
  name: string;
  description: string;
  /** 낡음 표시 ⊕ 본문 ⊕ 출처 링크. */
  body: string;
}

export interface ClaudeMemoryStoreDeps {
  /** 저장소의 현재 기억 목록 — name 중복 판정용. */
  list: () => Array<{ id: string; name: string }>;
  /** 장기 기억 쓰기(생산 구현 = `saveMemory`). */
  save: (record: ClaudeMemorySaveRecord) => void;
}

export interface ClaudeMemoryApplyResult extends ClaudeMemoryImport {
  /** 새로 만든 수 */
  saved: number;
  /** 같은 name 을 덮어쓴 수 */
  updated: number;
}

/** 기본 뿌리 — `~/.claude/projects`(프로젝트별 `memory/` 를 훑는다). */
export function claudeMemoryRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** 가져온 레코드 → 저장소 레코드. 낡음 표시가 본문에 남아 화면·주입에서 바로 보인다. */
export function claudeMemoryStoreRecord(item: ClaudeMemoryItem, id?: string): ClaudeMemorySaveRecord {
  return {
    id,
    type: item.type,
    name: item.name,
    description: item.description,
    body: [item.summary, item.body, `source: ${item.source}`, `updated: ${item.updatedAt}`]
      .filter(Boolean).join('\n\n'),
  };
}

/**
 * `root` 아래 Claude 기억 파일을 모두 읽는다. `root` 가 `~/.claude/projects` 여도 되고
 * `.../memory` 디렉터리 자체여도 된다. 색인 파일(`MEMORY.md`)은 기억이 아니므로 뺀다.
 */
export function collectClaudeMemoryFiles(root: string = claudeMemoryRoot()): ClaudeMemoryFile[] {
  if (!existsSync(root)) return [];
  const dirs = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const memoryDir = join(root, entry.name, 'memory');
      if (existsSync(memoryDir)) dirs.add(memoryDir);
    } else if (basename(root) === 'memory' && entry.isFile() && entry.name.endsWith('.md')) {
      dirs.add(root);
    }
  }
  const files: ClaudeMemoryFile[] = [];
  for (const dir of [...dirs].sort()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
      const path = join(dir, entry.name);
      files.push({ path, text: readFileSync(path, 'utf8') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** 파일들 → 장기 기억. 같은 name 이 저장소에 이미 있으면 그 id 로 덮어쓴다(새 파일을 만들지 않는다). */
export function applyClaudeMemoryImport(
  files: readonly ClaudeMemoryFile[],
  options: { asOf: string },
  deps: ClaudeMemoryStoreDeps,
): ClaudeMemoryApplyResult {
  const imported = importClaudeMemories(files, options);
  const existing = new Map(deps.list().map(entry => [entry.name, entry.id]));
  let saved = 0;
  let updated = 0;
  for (const item of imported.items) {
    const id = existing.get(item.name);
    deps.save(claudeMemoryStoreRecord(item, id));
    if (id) updated += 1; else saved += 1;
  }
  return { ...imported, saved, updated };
}
