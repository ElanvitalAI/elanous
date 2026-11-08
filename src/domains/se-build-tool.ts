import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── se_build tool — SE 격리 빌드 관측(대표 2026-07-13·PLAN B2) ────────────────
//
// elanous 자신(과 외부 CLI)이 "지금 SE 격리 빌드 뭐 도나 · 그 빌드 안에서 뭘 하나"를 인지하는
// READ-ONLY 도구. 레지스트리(se_builds.db) + per-build 로그 tail + worktree diff 스냅샷.
// tool 은 req/resp 라 스트림 불가 → 최근 상태 + 로그 tail. 라이브 스트림은 CLI --follow / SSE.
// PLAN: 내부 문서 `PLAN-se-build-observability-stream-2026-07-13`

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runGitCommand } from '../git-fs/runner.js';

import {
  openSeBuildsDb, listBuilds, getBuild, buildLogPath, markBuildStatus, type SeBuildRecord,
} from '../autopilot/se-build-registry.js';

export interface StopBuildResult { ok: boolean; buildId: string; missionId?: string; killedPids?: number[]; error?: string }

/** ★ 빌드 중단(대표 2026-07-13·빌드 컨트롤) — 실행 중 SE 격리 빌드를 멈춘다. 빌드는 미션의
 *  run-mission 프로세스(detached·그룹리더) 자식이라, 그 미션 프로세스 그룹을 SIGTERM 한다
 *  (delegate 자식까지 종료). 빌드=aborted 마킹 + 실행중 페이즈=failed[ABORTED] 로 정합화.
 *  WRITE 액션(관측 아님). 미션은 이후 재구현/재실행으로 재개 가능. fail-soft. */
export function stopBuild(buildId: string): StopBuildResult {
  const db = openSeBuildsDb();
  try {
    const b = getBuild(db, buildId);
    if (!b) return { ok: false, buildId, error: `빌드 없음: ${buildId}` };
    if (b.status !== 'running') return { ok: false, buildId, missionId: b.missionId, error: `이미 종결(${b.status})` };
    // 미션의 run-mission 프로세스(들) 찾기 → 프로세스 그룹 SIGTERM(자식 delegate 포함).
    const killed: number[] = [];
    try {
      const r = spawnSync('pgrep', ['-f', `run-mission.*${b.missionId}`], { encoding: 'utf-8', timeout: 5000 });
      for (const line of (r.stdout ?? '').split('\n')) {
        const pid = Number(line.trim());
        if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
        try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* */ } }
        killed.push(pid);
      }
    } catch { /* fail-soft */ }
    markBuildStatus(db, buildId, 'aborted');
    // 실행중 페이즈를 failed[ABORTED] 로 — stale running 방지(미션 재개 시 이 페이즈부터).
    try {
      const { TaskStore } = require('../task-orchestrator/store.js') as typeof import('../task-orchestrator/store.js');
      const store = new TaskStore();
      try {
        const task = store.getTask(b.phaseId);
        if (task && task.status === 'running') store.saveTask({ ...task, status: 'failed', notes: [...task.notes, `[ABORTED] 사용자 빌드 중단(${buildId})`], updatedAt: Date.now() });
      } finally { store.close(); }
    } catch { /* fail-soft */ }
    return { ok: true, buildId, missionId: b.missionId, ...(killed.length ? { killedPids: killed } : {}) };
  } finally { db.close(); }
}

export interface BuildSnapshot {
  build: SeBuildRecord;
  logTail: string[];       // per-build 로그 마지막 N줄
  worktree: string | null; // 실 worktree 경로(레지스트리 or glob)
  diffStat: string | null; // worktree git diff --stat(현재 변경)
}

/** buildId 'bld_<phaseHex>_<attempt>' → phaseHex 추출(worktree 매칭용). */
function phaseHexOf(buildId: string): string | null {
  const m = /^bld_([a-f0-9]+)_\d+$/.exec(buildId);
  return m ? m[1]! : null;
}

/** 활성 SE worktree 중 phaseHex 로 끝나는 것 탐색(레지스트리 worktree 없을 때 폴백). */
function findWorktreeByPhaseHex(phaseHex: string): string | null {
  try {
    const result = runGitCommand(process.cwd(), ['worktree', 'list', '--porcelain'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status !== 0) return null;
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const p = line.slice('worktree '.length).trim();
      if (/[/\\]se-.*/.test(p) && p.endsWith(phaseHex)) return p;
    }
  } catch { /* fail-soft */ }
  return null;
}

function tailFile(path: string, n: number): string[] {
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

function worktreeDiffStat(worktree: string): string | null {
  try {
    const result = runGitCommand(process.cwd(), ['-C', worktree, 'diff', '--stat'], { encoding: 'utf-8', timeout: 5000 });
    if (result.status !== 0) return null;
    // deps 심링크 노이즈 제외(node_modules·apps/pwa/out).
    return result.stdout.split('\n').filter((l) => l && !/node_modules|apps\/pwa\/out/.test(l)).join('\n') || '(변경 없음)';
  } catch { return null; }
}

/** 빌드 1건 스냅샷 — 레지스트리 레코드 + 로그 tail + worktree diff. */
export function buildSnapshot(buildId: string, opts: { tail?: number } = {}): BuildSnapshot | null {
  const db = openSeBuildsDb();
  try {
    const build = getBuild(db, buildId);
    if (!build) return null;
    const worktree = build.worktree ?? (phaseHexOf(buildId) ? findWorktreeByPhaseHex(phaseHexOf(buildId)!) : null);
    return {
      build,
      logTail: tailFile(build.logPath ?? buildLogPath(buildId), opts.tail ?? 40),
      worktree,
      diffStat: worktree ? worktreeDiffStat(worktree) : null,
    };
  } finally { db.close(); }
}

export const SE_BUILD_SPEC: LLMToolSpec = {
  name: 'se_build',
  description: "⭐ SE 격리 빌드 관측+컨트롤 (코어) — elanous 가 **자기 미션 페이즈가 별도 worktree 에서 자율 구현하는 SE 빌드**를 인지·제어. 'SE 빌드 뭐 도나' '그 빌드 안에서 뭘 하는 중' '어느 파일 고치나' 관측 + **'이 빌드 멈춰/중단해' 컨트롤**. action: list(활성/최근 빌드·READ)·status(buildId 상세 + worktree diff + 로그 tail·READ)·**stop(buildId 지정 실행중 빌드 중단·WRITE — 미션 프로세스 SIGTERM, 재개는 재구현/재실행)**. 라이브 스트림은 CLI `elanous ops build <id> --follow` 또는 SSE /v1/builds/<id>/stream. (미션/페이즈 상태·힐=ops_status/autopilot_missions · 여긴 그 아래 '빌드 안'.)",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list(기본·활성/최근·READ) | status(buildId 상세·READ) | stop(buildId 실행중 빌드 중단·WRITE).' },
      buildId: { type: 'string', description: 'status/stop 대상 빌드 id(bld_<phaseHex>_<attempt>·list 에서 확인).' },
      all: { type: 'boolean', description: 'list 시 종결 포함 전체(기본 활성 running 만).' },
      tail: { type: 'number', description: 'status 로그 tail 줄 수(기본 40).' },
    },
  },
};

/** se_build 디스패치(list/status=관측·READ-ONLY, stop=중단·WRITE). 전 표면 공용(core-tools). */
export async function dispatchSeBuild(args: Record<string, unknown>): Promise<unknown> {
  const action = (args.action as string) ?? 'list';
  if (action === 'status') {
    const buildId = (args.buildId as string) ?? '';
    if (!buildId) return { error: 'buildId 필요(action=status).' };
    const snap = buildSnapshot(buildId, { tail: (args.tail as number) ?? 40 });
    return snap ?? { error: `빌드 없음: ${buildId}` };
  }
  if (action === 'stop') {
    const buildId = (args.buildId as string) ?? '';
    if (!buildId) return { error: 'buildId 필요(action=stop).' };
    const r = stopBuild(buildId);
    return r.ok
      ? { ...r, note: `빌드 중단됨(미션 프로세스 SIGTERM). 재개는 재구현/재실행으로. 관측: elanous ops build ${buildId}` }
      : r;
  }
  // list
  const db = openSeBuildsDb();
  try {
    const builds = listBuilds(db, { all: args.all === true, limit: 30 }).map((b) => ({
      buildId: b.buildId, status: b.status, phase: b.phaseTitle, index: b.index, total: b.total,
      backend: b.backend, attempt: b.attemptSeq, missionId: b.missionId,
      startedAt: b.startedAt, endedAt: b.endedAt, prUrl: b.prUrl,
    }));
    return { builds, note: builds.length ? '활성/최근 SE 빌드. status(buildId) 로 로그 tail+worktree diff.' : '활성 빌드 없음.' };
  } finally { db.close(); }
}
