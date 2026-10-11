/**
 * BENCH-ISOLATED-ARMS — 같은 골을 모델만 바꿔 여러 «팔»로 쏘는 벤치를 기준선과 떼어 놓는다.
 *
 * S: 벤치는 손 스크립트가 base sha 를 `bench/base-night-<sha12>` 로 push 하고 `harness ask --base` 로 쏜다.
 * C: 그 벤치 가지로 다른 PR 이 squash 병합돼 기준선이 오염됐고(#26022), 팔 PR 이 PR 직전 main 동기화에서
 *    merge-conflict 로 «실패»로 셈돼 판정이 흐려졌다.
 * A: 기준선 가지 이름을 `bench/<id>/base` 하나로 고정하고, 그 이름 «자체»를 벤치 표지로 쓴다 —
 *    호스트 → self orchestrate → Pod → 안쪽 harness ask 까지 `--base` 가 이미 흐르므로 새 배관이 없다.
 *    - 팔 가지 = `bench/<id>/<arm>` (arm = 자식 모델에서 파생 ⊕ 런 접미 — 같은 모델 n 팔이 안 겹친다)
 *    - PR base = `bench/<id>/base` · 라벨 `elanous:bench`
 *    - PR 직전 main 동기화는 건너뛴다(관측 `bench`/`main-sync-skipped`) — 판정은 base 위 게이트·시험·리뷰
 *    - 원장 = `<config dir>/bench/<id>.jsonl` · 읽기 = `elanous bench ls <id>`
 *    ⛔ base 는 «자식 작업 가지의 출발점»(⊕ PR base)으로만 쓰인다 — 부모 cwd 를 base 트리로 옮기지 않는다.
 *      부모·Pod 발사 코드는 지금 도는 코드다(원장 `parentCodeCommit` 이 그 커밋을 base sha 와 따로 적는다).
 * ⛔ 착지 막기는 여기 몫이 아니다(LAND-BASE-MAIN-GUARD · base≠main 재사용 PR 거부).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BENCH_LABEL = 'elanous:bench';
export const BENCH_LOG_CATEGORY = 'bench';

const BENCH_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA = /^[0-9a-f]{7,40}$/i;

export interface BenchSpec { readonly id: string; readonly sha?: string }

/** `--bench <id>[:<base-sha>]` 를 푼다. ⛔ 모르는 꼴은 «거부»한다 — 조용히 고치면 다른 기준선으로 돈다. */
export function parseBenchSpec(spec: string): BenchSpec {
  const raw = spec.trim();
  const colon = raw.indexOf(':');
  const id = colon < 0 ? raw : raw.slice(0, colon);
  const sha = colon < 0 ? undefined : raw.slice(colon + 1);
  if (!BENCH_ID.test(id) || id === 'base') {
    throw new Error(`--bench id 가 잘못됐다: ${JSON.stringify(id)} — 영숫자로 시작하는 [A-Za-z0-9._-] 64자 이내(슬래시 금지 · 'base' 금지)`);
  }
  if (sha !== undefined && !SHA.test(sha)) {
    throw new Error(`--bench base sha 가 잘못됐다: ${JSON.stringify(sha)} — 16진 7~40자`);
  }
  return { id, ...(sha !== undefined ? { sha: sha.toLowerCase() } : {}) };
}

export function benchBaseBranch(id: string): string { return `bench/${id}/base`; }

function stripRef(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '');
}

/** `bench/<id>/base` 면 id, 아니면 null. `origin/`·`refs/heads/` 접두는 벗긴다. */
export function benchIdFromBase(ref: string | undefined | null): string | null {
  if (!ref) return null;
  const m = /^bench\/([^/]+)\/base$/.exec(stripRef(ref));
  return m && BENCH_ID.test(m[1]!) ? m[1]! : null;
}

/** `bench/<id>/<arm>`(arm ≠ base) 면 {id, arm}, 아니면 null. */
export function parseBenchArmBranch(ref: string | undefined | null): { id: string; arm: string } | null {
  if (!ref) return null;
  const m = /^bench\/([^/]+)\/([^/]+)$/.exec(stripRef(ref));
  if (!m || m[2] === 'base' || !BENCH_ID.test(m[1]!)) return null;
  return { id: m[1]!, arm: m[2]! };
}

/** 팔 이름 — 자식 모델의 마지막 토막(`openrouter/z-ai/glm-5.3-flash` → `glm-5.3-flash`) ⊕ 런 접미 6자.
 *  ⭐ 접미가 있어야 같은 모델 n 팔(sonnet1~3)이 같은 가지로 겹쳐 서로의 PR 을 덮지 않는다. */
export function benchArmName(childModel: string | undefined, runId: string | undefined): string {
  const last = childModel?.trim().split('/').filter(Boolean).at(-1) ?? '';
  const slug = last.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'default';
  const suffix = (runId ?? '').toLowerCase().replace(/^run-/, '').replace(/[^a-z0-9]/g, '').slice(0, 6);
  return suffix ? `${slug}-${suffix}` : slug;
}

/** 벤치 base 위의 런이면 팔 가지 이름, 아니면 undefined(동작 불변). */
export function benchArmBranchForBase(base: string | undefined, childModel: string | undefined, runId: string | undefined): string | undefined {
  const id = benchIdFromBase(base);
  return id ? `bench/${id}/${benchArmName(childModel, runId)}` : undefined;
}

export type BenchGitRun = (args: readonly string[]) => { status: number | null; stdout: string; stderr: string };

export function defaultBenchGitRun(cwd: string): BenchGitRun {
  return (args) => {
    const r = spawnSync('git', [...args], { cwd, encoding: 'utf8', timeout: 120_000 });
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  };
}

export interface BenchBase { readonly id: string; readonly branch: string; readonly sha: string; readonly created: boolean }

/**
 * 기준선 가지를 고정한다 — 없으면 만들고, 있으면 sha 일치를 확인한다(불일치 = 거부).
 * sha 생략: 가지가 «없으면» 발사 시점 origin/main 으로 만들고, «있으면» 그 가지의 sha 를 그대로 쓴다
 * (첫 팔이 정한 기준선을 뒤 팔이 따라간다 — main 이 그 사이 움직여도 팔끼리 같은 땅).
 */
export function ensureBenchBase(spec: BenchSpec, run: BenchGitRun): BenchBase {
  const branch = benchBaseBranch(spec.id);
  const must = (args: readonly string[], what: string) => {
    const r = run(args);
    if (r.status !== 0) throw new Error(`bench: ${what} 실패 (git ${args.join(' ')} rc=${r.status ?? 'signal'}): ${r.stderr.trim().split('\n')[0] ?? ''}`);
    return r.stdout.trim();
  };
  const trackingFetch = ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`] as const;
  const remote = run(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
  if (remote.status !== 0 && remote.status !== 2) {
    throw new Error(`bench: origin 의 ${branch} 를 못 읽었다 (rc=${remote.status ?? 'signal'}) — 「없다」로 읽지 않는다: ${remote.stderr.trim().split('\n')[0] ?? ''}`);
  }
  const existing = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0]?.toLowerCase() : undefined;
  if (existing) {
    if (spec.sha && !existing.startsWith(spec.sha)) {
      throw new Error(`bench: ${branch} 가 이미 ${existing.slice(0, 12)} 에 있다 — 요청 ${spec.sha.slice(0, 12)} 와 다르다(거부 · 다른 기준선이면 새 bench id 를 써라)`);
    }
    must(trackingFetch, `${branch} fetch`);
    return { id: spec.id, branch, sha: existing, created: false };
  }
  must(['fetch', '--no-tags', 'origin', 'main'], 'origin main fetch');
  const sha = must(['rev-parse', '--verify', `${spec.sha ?? 'origin/main'}^{commit}`], 'base sha 해석').toLowerCase();
  must(['push', 'origin', `${sha}:refs/heads/${branch}`], `${branch} push`);
  // push 는 원격 추적 ref 를 안 만든다 — 로컬 기질의 worktree 가 `origin/<branch>` 를 찾도록 한 번 당긴다.
  must(trackingFetch, `${branch} fetch`);
  return { id: spec.id, branch, sha, created: true };
}

export interface BenchLedgerRow {
  readonly ts: string;
  readonly event: 'launched' | 'finished';
  readonly benchId: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  /** 부모(발사 프로세스)가 도는 코드 커밋 — base sha 와 따로 적는다(base 는 작업 가지 출발점에만 쓰인다). */
  readonly parentCodeCommit?: string | null;
  /** `harness.imageCommit` (Pod 이미지 pin) — 없으면 null(«못 읽음»과 «없음»을 같은 값으로: 원장엔 설정값만 싣는다). */
  readonly imageCommit: string | null;
  readonly childLlmProvider: string | null;
  readonly childLlmModel: string | null;
  /** 같은 bench id ⊕ 같은 자식 모델의 몇 번째 발사인가(1부터). */
  readonly round: number;
  readonly entrance?: string;
  readonly substrate?: string;
  readonly seat?: string;
  readonly exitCode?: number;
}

export function benchLedgerPath(id: string, configDir: string): string {
  return join(configDir, 'bench', `${id}.jsonl`);
}

export function readBenchLedger(id: string, configDir: string): BenchLedgerRow[] {
  const path = benchLedgerPath(id, configDir);
  if (!existsSync(path)) return [];
  const rows: BenchLedgerRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as BenchLedgerRow); } catch { /* 깨진 줄은 건너뛴다 — 수는 renderBenchLs 가 따로 안 센다 */ }
  }
  return rows;
}

export function nextBenchRound(rows: readonly BenchLedgerRow[], childLlmModel: string | null): number {
  return rows.filter((row) => row.event === 'launched' && (row.childLlmModel ?? null) === childLlmModel).length + 1;
}

export function appendBenchLedger(row: BenchLedgerRow, configDir: string): void {
  const path = benchLedgerPath(row.benchId, configDir);
  mkdirSync(join(configDir, 'bench'), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function renderBenchLs(id: string, rows: readonly BenchLedgerRow[]): string {
  if (rows.length === 0) return `bench ${id}: 원장 줄 0 (기록 없음)`;
  const lines = [`bench ${id}: ${rows.length}줄`];
  for (const row of rows) {
    lines.push([
      row.ts, row.event, `round=${row.round}`, `base=${row.baseSha.slice(0, 12)}`,
      `parent=${row.parentCodeCommit ? row.parentCodeCommit.slice(0, 12) : 'unknown'}`,
      `image=${row.imageCommit ? row.imageCommit.slice(0, 12) : 'none'}`,
      `child=${row.childLlmProvider ?? '-'}/${row.childLlmModel ?? '-'}`,
      ...(row.substrate ? [`substrate=${row.substrate}`] : []),
      ...(row.exitCode !== undefined ? [`rc=${row.exitCode}`] : []),
    ].join(' '));
  }
  return lines.join('\n');
}
