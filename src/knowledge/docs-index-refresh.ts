// 문서 색인 한 번에 따라잡기 — `elanous docs index` ⊕ 설치(self-update · release-update) 직후 비동기 킥.
//
// 관측(11-25 5497ec9 재측정): `docs search` 는 검색 한 번에 변경 문서 25개까지만 다시 색인한다.
//   새 판이 깔린 직후엔 «index stale — 141 changed doc(s)» 가 뜨고, 처음 몇 번의 검색이 새 문서를
//   놓치며 8~110초씩 걸렸다(색인을 검색이 대신 치렀다).
// 처방: 변경 문서 전부를 상한 없이 한 번에 색인하는 입구(`elanous docs index`)를 두고, 설치가 끝나면
//   그 입구를 분리된 자식으로 띄운다(설치를 기다리게 하지 않는다). 검색 시 25개 증분은 폴백으로 남긴다.
// 세 얼굴: 관측 = docs.index-refresh{files,pending,ms} · docs.index-refresh-kicked / docs.index-refresh-kick-failed{reason}
//   · 인지 = pending>0 이면 임베딩이 죽은 것(다음 검색·다음 킥이 잇는다) · 수복 = 다음 설치·`elanous docs index`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { ingestDocsCorpus, type DocsCorpusCounts, type DocsCorpusOpts } from '../domains/knowledge.js';

/** 변경 문서를 «상한 없이» 한 번에 색인한다(검색 시 증분 상한과 다르다). */
export async function refreshDocsIndex(db: Database, opts: Omit<DocsCorpusOpts, 'maxFiles'> = {}): Promise<DocsCorpusCounts> {
  const started = Date.now();
  const counts = await ingestDocsCorpus(db, opts);
  try {
    debug.log('docs', 'index-refresh', {
      files: counts.files, refreshed: counts.refreshed, unchanged: counts.unchanged,
      pending: counts.pending, roots: counts.roots, ms: Date.now() - started,
    }, { level: counts.pending > 0 ? 'warn' : 'info' });
  } catch { /* 관측 실패가 색인을 막지 않는다 */ }
  return counts;
}

export interface DocsIndexKickDeps {
  exists?: (path: string) => boolean;
  /** 분리 실행 — 자식이 실제로 떴을 때(spawn) resolve, 못 떴을 때(error) reject. 기본은 detached spawn ⊕ unref. */
  spawnDetached?: (command: string, args: string[]) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface DocsIndexKickOutcome { kicked: boolean; reason: string; command?: string }

/** 설치 직후 — 설치 prefix 의 `bin/elanous docs index` 를 분리 자식으로 띄운다. 자식이 «떴다»가 확인돼야 kicked=true.
 *  색인 자체는 기다리지 않는다. 실패는 조용히 사유만 돌려준다(검색 시 증분이 잇는다). */
export async function kickDocsIndexRefresh(prefix: string, deps: DocsIndexKickDeps = {}): Promise<DocsIndexKickOutcome> {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const command = join(prefix, 'bin', 'elanous');
  let outcome: DocsIndexKickOutcome;
  if (!deps.spawnDetached && (env.NODE_ENV === 'test' || Boolean(env.ELANOUS_TEST_HOME?.trim()))) {
    outcome = { kicked: false, reason: 'test guard: no live spawn' };
  } else if (!exists(command)) {
    outcome = { kicked: false, reason: `installed entry missing: ${command}` };
  } else {
    try {
      await (deps.spawnDetached ?? defaultSpawnDetached)(command, ['docs', 'index']);
      outcome = { kicked: true, reason: 'docs index started in background', command };
    } catch (error) {
      outcome = { kicked: false, reason: `spawn failed: ${error instanceof Error ? error.message : String(error)}`, command };
    }
  }
  try {
    if (outcome.kicked) debug.log('docs', 'index-refresh-kicked', { ...outcome });
    else debug.log('docs', 'index-refresh-kick-failed', { ...outcome }, { level: 'warn' });
  } catch { /* 관측 실패가 설치를 막지 않는다 */ }
  return outcome;
}

/** 자식이 실제로 뜨면(spawn) resolve · 비동기 error(ENOENT·EACCES 등)면 그 사유로 reject. */
export function defaultSpawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command, args, { detached: true, stdio: 'ignore' }); }
    catch (error) { reject(error); return; }
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', (error) => reject(error));
  });
}
