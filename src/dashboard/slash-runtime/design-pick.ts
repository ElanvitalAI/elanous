import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDesignDirection } from '../../design/apply-direction.js';
import { listAllDesignDirections, parseDeclaredDirection } from '../../design/design-directions.js';
import { debug } from '../../debug/log.js';
import { resolveRepositoryRoot } from '../../self-implement/repo-provision.js';
import { getSessionCwd } from '../../session/working-dir.js';

interface DesignPickDeps {
  list: typeof listAllDesignDirections;
  apply: typeof applyDesignDirection;
  repositoryRoot: (cwd: string) => string | undefined;
  cwd: () => string;
  readDocument: (path: string) => string;
}

const liveDeps: DesignPickDeps = {
  list: listAllDesignDirections,
  apply: applyDesignDirection,
  repositoryRoot: resolveRepositoryRoot,
  cwd: getSessionCwd,
  readDocument: (path) => readFileSync(path, 'utf8'),
};

/** Numbering and selection share one ordered snapshot of the canonical direction list. */
export function handleDesignPick(
  args: readonly string[],
  ctx: { chatLines: string[]; setChatScrollOffset: (offset: number) => void },
  overrides: Partial<DesignPickDeps> = {},
): void {
  const deps = { ...liveDeps, ...overrides };
  const reply = (line: string) => {
    ctx.chatLines.push(line);
    ctx.setChatScrollOffset(-1);
  };
  const requested = args[0];
  const root = deps.repositoryRoot(deps.cwd());
  if (requested !== undefined && !root) {
    debug.log('design.pick', 'refused', { id: requested, reason: 'no-repository' });
    reply('디자인 방향을 적용할 수 없습니다 — 현재 작업 디렉터리가 git 저장소가 아닙니다.');
    return;
  }

  const available = deps.list();
  const ordered = [
    ...available.filter((d) => d.source === 'design-system'),
    ...available.filter((d) => d.source !== 'design-system'),
  ];
  if (requested === undefined) {
    let declared: string | null = null;
    if (root) {
      try {
        declared = parseDeclaredDirection(deps.readDocument(join(root, 'DESIGN.md')), ordered).declared;
      } catch {
        // A missing DESIGN.md does not hide the available choices.
      }
    }
    for (const [index, direction] of ordered.entries()) {
      reply(`${index + 1}. ${direction.id} · ${direction.label} · ${direction.mood} · ${direction.isDark ? '어두움' : '밝음'} / ${direction.isPastel ? '파스텔' : '비파스텔'}${declared === direction.id ? ' · 지금 선언' : ''}`);
    }
    reply('적용: /design pick <번호|id>');
    return;
  }

  const direction = /^\d+$/.test(requested)
    ? ordered[Number(requested) - 1]
    : ordered.find((item) => item.id === requested);
  const id = direction?.id ?? requested;
  if (!direction || args.length !== 1) {
    debug.log('design.pick', 'refused', { id, reason: 'unknown-direction' });
    reply(`디자인 방향을 찾을 수 없습니다: ${requested} — /design pick 으로 목록을 확인하세요.`);
    return;
  }

  const result = deps.apply(join(root!, 'DESIGN.md'), id);
  if (result.ok) {
    debug.log('design.pick', 'applied', { id });
    reply(`✅ ${id} 적용 — ${result.documentPath}`);
    return;
  }
  debug.log('design.pick', 'refused', { id, reason: result.reason });
  switch (result.reason) {
    case 'conflicting-system-file':
      reply(`적용 거부: design/system/ 을 사람이 고쳤다 — 덮지 않는다 · ${result.path ?? result.documentPath}`);
      break;
    case 'unknown-direction':
      reply(`적용 거부: 알 수 없는 디자인 방향 ${id} — /design pick 으로 목록을 확인하세요.`);
      break;
    case 'cannot-read':
      reply(`적용 거부: DESIGN.md 를 읽을 수 없습니다 · ${result.documentPath}`);
      break;
    case 'cannot-write':
      reply(`적용 거부: DESIGN.md 를 쓸 수 없습니다 · ${result.documentPath}`);
      break;
  }
}
