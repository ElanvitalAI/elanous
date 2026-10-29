/**
 * 디스크 관리자 — 판정(RFC §2 «워크트리는 캐시다»). 순수 함수 — 입출력 없음.
 *
 * 남기는 것은 셋뿐이다:
 *   (a) 열린 PR(draft 포함) head 를 펼친 트리 — 가지 이름 «또는» HEAD sha 가 열린 PR 의 headRefOid 와 같다
 *       (가지 이름만 보면 detached·이름 바뀐 수확 트리를 놓친다 — 10-28 실측).
 *   (b) 살아 있는 일이 쓰는 트리 — 살아 있는 프로세스의 cwd 가 그 아래 · 소유 런이 살아 있다.
 *   (c) 보호 뿌리 안 — `~/elanous-hq/seats/` · repo.git 자체 등.
 * 나머지는 지운다(대표 «당분간 모르면 지운다»).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ReclaimKind } from './ledger.js';

export interface ReclaimTarget {
  path: string;
  kind: ReclaimKind;
  owner?: string;
  reason?: string;
  requester?: string;
  timestamp?: string;
}

export interface TreeHead {
  branch?: string;
  sha?: string;
}

export interface OpenPrIndex {
  heads: ReadonlySet<string>;
  shas: ReadonlySet<string>;
}

export interface JudgeContext {
  openPrs: OpenPrIndex;
  liveDirectories: readonly string[];
  protectedRoots: readonly string[];
  /** 소유가 살아 있나. 모르면 false(=지움 쪽). */
  isOwnerLive: (owner: string | undefined) => boolean;
  /** 이 경로가 git 트리면 가지·HEAD. 아니면 null. */
  head: TreeHead | null;
}

export type Verdict =
  | { action: 'keep'; reason: 'protected-root'; detail: string }
  | { action: 'keep'; reason: 'open-pr'; detail: string; match: 'branch' | 'sha' }
  | { action: 'keep'; reason: 'live'; detail: string; via: 'cwd' | 'owner' }
  | { action: 'delete'; reason: string };

/** `child` 가 `root` 자신이거나 그 아래인가(접두만 같은 형제는 아니다). */
export function isInside(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function judgeReclaimTarget(target: ReclaimTarget, ctx: JudgeContext): Verdict {
  const path = resolve(target.path);
  for (const root of ctx.protectedRoots) {
    // 보호 뿌리 «안»이거나, 지울 경로가 보호 뿌리를 «품고» 있으면 남긴다.
    if (isInside(path, root) || isInside(root, path)) return { action: 'keep', reason: 'protected-root', detail: root };
  }
  const head = ctx.head;
  if (head?.branch && ctx.openPrs.heads.has(head.branch)) {
    return { action: 'keep', reason: 'open-pr', detail: head.branch, match: 'branch' };
  }
  if (head?.sha && ctx.openPrs.shas.has(head.sha)) {
    return { action: 'keep', reason: 'open-pr', detail: head.sha, match: 'sha' };
  }
  const liveDir = ctx.liveDirectories.find((dir) => isInside(dir, path));
  if (liveDir !== undefined) return { action: 'keep', reason: 'live', detail: liveDir, via: 'cwd' };
  if (ctx.isOwnerLive(target.owner)) return { action: 'keep', reason: 'live', detail: target.owner ?? '', via: 'owner' };
  if (!head) return { action: 'delete', reason: 'not-a-tree' };
  return { action: 'delete', reason: head.branch ? 'no-open-pr' : 'detached-no-open-pr' };
}
