// ── Self-Evolution SE4 · 재사용 NocturnalDeps 팩토리 (2026-07-12) ──────────
//
// se-nocturnal-run.ts 스크립트 안에 인라인으로만 있던 실 seam 배선(createInstance/
// implement/gate/makePr/changedFiles/dispose)을 importable 팩토리로 추출한다. 이제 야간
// 러너 스크립트뿐 아니라 미션 fabric 의 "구현 페이즈 → SE 격리 경로" 브릿지
// (mission-se-bridge)도 동일 배선을 재사용한다(단일 출처·역결합 방지). 동작은 스크립트와
// 동일(백엔드 3종·curated 게이트 스코프·PR 초안·merge HITL 없음).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { runGitCommand } from '../../git-fs/runner.js';
import { join, dirname } from 'node:path';
import { createIsolatedInstance, disposeIsolatedInstance } from './isolated-instance.js';
import { runIntegrityGate, renderGateEvidence } from './integrity-gate.js';
import type { NocturnalDeps } from './nocturnal-runner.js';
import { critiquePhaseWithLLM, renderCritique } from '../mission-critique.js';
import { recordAutonomousActionSafe } from '../../domains/autonomy-log.js';
import { makePrManager, type PrManager } from '../pr-manager.js';
import { getUserConfig } from '../../user-config/reader.js';
import { debug } from '../../debug/log.js';
import { lookupLlmTierSpec } from '../../model-tier/index.js';

export interface NocturnalDepsOptions {
  repoRoot: string;
  /** 코딩 백엔드(arming.build.backend): 'codex' | 'elanous-self[:model]' | 'claude'. */
  backend: string;
  /** 게이트 테스트 스코프(기본 'src/autopilot/' curated·고속). 'full' 이면 전체 bun test. */
  gateScope?: string;
  /** worktree 베이스(기본 'main' — 깨끗한 PR 베이스). */
  base?: string;
  /** built 표시 콜백(기본 no-op). SE 러너=미션 status='done'·브릿지=페이즈 executor 가 처리. */
  markBuilt?: (targetId: string, note: string) => void;
  /** 자율행동 기록(기본 recordAutonomousActionSafe autopilot). */
  record?: (i: { action: string; rationale: string; outcome: string; refs?: Record<string, unknown> }) => void;
  /** 로그(기본 console.log). */
  log?: (s: string) => void;
  /** 테스트 주입용 gate 실행기(기본 runIntegrityGate). */
  runIntegrityGate?: typeof runIntegrityGate;
  /** 테스트 주입용 변경 파일 조회기(기본 worktree porcelain 조회). */
  changedFiles?: (worktreePath: string) => string[];
  /** 테스트 주입용 격리 인스턴스 생성기. */
  createInstance?: NocturnalDeps['createInstance'];
  /** 테스트 주입용 구현기. */
  implement?: NocturnalDeps['implement'];
  /** R1 LLM 비평 주입(대표 2026-07-12) — prompt→응답. 미주입 시 결정론(R0) 비평만. */
  llmReview?: (prompt: string) => Promise<string>;
  /** PR 매니저 주입(대표 2026-07-12·테스트) — 기본 makePrManager()(실 gh/git). upsertPr 로 기존
   *  PR 재활용(force-push 자동 업데이트). */
  prManager?: PrManager;
  /** ★ SE 격리 구현 예산(대표 2026-07-12) — elanous-self 최대 턴 수(기본 40). "지정 가능한
   *  인터페이스"(seam) — 지금은 자기 에스컬레이션(mission-se-bridge)이 실패 시 상향해 주입.
   *  향후 미션/페이즈 커스텀 지정 배선 지점(사용자 노출은 나중). 복잡한 구현이 검증까지 완주하도록. */
  maxTurns?: number;
  /** ★ per-build 스트림 로그(대표 2026-07-13·PLAN B1) — 지정 시 delegate stdout/stderr(빌드
   *  턴)를 이 파일로 보내 빌드 단위로 격리·스트리밍(tool/CLI/SSE 가 follow). 미지정=기존 inherit. */
  buildLogPath?: string;
}

/** 격리 worktree 자율 구현 delegate — 세 백엔드(codex/elanous-self/claude). se-nocturnal-run 에서
 *  이관(단일 출처). elanous-self 튜닝 config(terra·medium·40턴·검증-주도 폐루프) 동일. */
function runDelegate(repoRoot: string, cwd: string, prompt: string, backend: string, gateScope: string, maxTurns = 40, buildLogPath?: string): void {
  // ★ per-build 스트림(PLAN B1) — buildLogPath 지정 시 delegate 턴을 그 파일로(빌드 격리·라이브).
  //   미지정=기존 'inherit'(부모 stdout→미션 로그). fd 실패 시 inherit 폴백(fail-soft).
  let fd: number | undefined;
  let stdio: 'inherit' | ['inherit', number, number] = 'inherit';
  if (buildLogPath) {
    try { mkdirSync(dirname(buildLogPath), { recursive: true }); fd = openSync(buildLogPath, 'a'); stdio = ['inherit', fd, fd]; }
    catch { stdio = 'inherit'; }
  }
  try {
    if (backend === 'codex-app-server' || backend === 'codex') {
      execFileSync('codex', ['exec', '--skip-git-repo-check', prompt], { cwd, stdio, timeout: 900_000 });
    } else if (backend === 'elanous-self' || backend.startsWith('elanous-self:')) {
      // 모델 기본 = codex 사다리 balanced 칸(옛 gpt-5.6-terra 자리 · GPT-6 에는 terra 가 없다). 'elanous-self:opus' 등으로 override.
      const model = backend.includes(':') ? backend.slice(backend.indexOf(':') + 1) : lookupLlmTierSpec('openai-codex', 'balanced').model;
      const verifyCmd = `bun test ${gateScope === 'full' ? '' : gateScope}`.trim();
      // ★ 이식 #2 배선(2026-07-22) — canonical `llm.goalLoop.enabled`(기존 플래그·chat/session 과 동일 출처)
      //   가 켜지면 se build delegate 도 canonical goal-loop 엔진(증거게이트·goal.loop 관측·anti-spin)으로
      //   구동. 별도 플래그 신설 금지(대표 지적 — 과설계). 서브프로세스는 config-dir 미상속이라 부모가
      //   여기서 config 를 읽어 env(ELANOUS_SELF_*) 로 전파(기존 model/effort 패턴 동일). 미설정=커스텀 루프(무회귀).
      const goalLoopOn = (() => { try { return getUserConfig().llm.goalLoop?.enabled === true; } catch { return false; } })();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELANOUS_SELF_MODEL: model,
        ELANOUS_SELF_EFFORT: 'medium',
        ELANOUS_SELF_MAX_TURNS: String(maxTurns),
        ELANOUS_SELF_SYSTEM: 'optimized',
        ELANOUS_SELF_ADAPTIVE: '1',
        ELANOUS_SELF_VERIFY_CMD: verifyCmd,
        ...(goalLoopOn ? { ELANOUS_SELF_GOALLOOP: '1' } : {}),
      };
      execFileSync('bun', [join(repoRoot, 'scripts/se-elanous-self-impl.ts'), prompt], { cwd, stdio, timeout: 1_800_000, env });
    } else {
      execFileSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], { cwd, stdio, timeout: 900_000 });
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* noop */ } }
  }
}

/** 격리 cwd 의 변경+신규 파일 목록(porcelain). 불변 코어 게이트가 신규 코어 파일도 봐야 함. */
function porcelainFiles(worktreePath: string): string[] {
  try {
    const result = runGitCommand(worktreePath, ['status', '--porcelain'], { encoding: 'utf-8' });
    if (result.status !== 0) return [];
    return result.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  } catch { return []; }
}

/** ★ 게이트 오탐 수정(대표 지시 2026-07-12) — 무결성 게이트 테스트 스코프를 **변경 파일 기준**
 *  으로 유도한다. 이전엔 gateScope 'src/autopilot/' 고정이라, 변경 파일이 src/domains·
 *  src/knowledge 여도 그쪽 테스트를 실행하지 않아 실제 bun test 실패를 pass 로 오보고했다
 *  (2026-07-12 dogfood: #3853·3854·3855 실제 fail 인데 게이트 green). 변경된 src/·test/ 파일의
 *  디렉토리를 스코프에 union 해 대응 테스트를 강제 실행 + base(브릿지 자체) 항상 포함. 순수함수. */
/** 격리 worktree 의 deps 심링크 노이즈(node_modules·apps/pwa/out)인가(대표 2026-07-12·순수).
 *  ensureWorktreeDeps 가 심은 심링크는 gitignore 가 못 잡아 untracked 로 뜬다. 이걸 "구현 변경"
 *  으로 세면 빈 구현이 통과(dogfood: P3 done 인데 실체 0). makePr 도 같은 경로를 add 제외. */
export function isDepsNoise(f: string): boolean {
  return /^(node_modules|apps\/pwa\/out)(\/|$)/.test(f);
}

/** deps 노이즈를 뺀 실제 변경 파일(순수) — 구현 여부 판정의 진짜 신호. */
export function realChangedFiles(files: string[]): string[] {
  return files.filter((f) => !isDepsNoise(f));
}

/** ★ worktree 전체 diff(대표 2026-07-13·캡처 배선 결함 수정) — `git diff HEAD` 는 **tracked 변경만**
 *  보고 untracked(새 파일)의 본문을 누락한다. 새 파일을 만드는 페이즈(조사 문서·신규 소스)는 changedFiles
 *  목록엔 잡히지만(porcelain) diff 본문이 비어, 비평이 "변경 파일은 있으나 diff 본문 없음 → 검증 불가
 *  FAIL" 오탐 → 무한 재시도·opus 소진(price-guard 페이즈0 dogfood). tracked diff + untracked 파일
 *  본문(git diff --no-index)을 합쳐 새 파일도 비평에 실린다. deps 노이즈(node_modules·apps/pwa/out)는
 *  realChangedFiles 와 동일 기준 제외. read-only(staging 등 부작용 0). */
export function worktreeDiffWithUntracked(worktreePath: string): string {
  const run = (args: string[]): string => {
    const result = runGitCommand(worktreePath, args, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
    // git diff --no-index 는 차이가 있으면 exit 1 로 종료하지만 stdout 에 유효한 diff 가 담긴다.
    return result.stdout;
  };
  const tracked = run(['diff', 'HEAD']);
  const untrackedFiles = realChangedFiles(
    run(['ls-files', '--others', '--exclude-standard']).split('\n').map((l) => l.trim()).filter(Boolean),
  );
  const untracked = untrackedFiles.map((f) => run(['diff', '--no-index', '--', '/dev/null', f])).join('');
  return untracked ? `${tracked}\n${untracked}` : tracked;
}

/** bun test 로그에서 실패 테스트 식별자 추출(순수·failClass 관측용) — "(fail) <path> > <it>" 라인.
 *  base-preexisting vs regression 을 사람이 대조할 목록(핸드오프 3근본: 실패 test 목록 각인). 없으면 []. */
export function extractFailingTests(log: string): string[] {
  const out: string[] = [];
  for (const l of log.split('\n')) {
    const m = l.match(/^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/** ★ delegate 실패 "왜" 추출(순수·관측 보강·2026-07-22 dogfood) — 종전 delegate 실패는 execFileSync 의
 *  "Command failed: bun se-elanous-self-impl.ts" 만 미션에 도달하고, goal-loop 의 실제 stopReason·에이전트가
 *  기록한 blocked 사유·내부 verify 결과는 buildLog 에만 남아 유실됐다(실증: no_progress·contract 충돌
 *  blocked 인데 미션엔 "missing-capability" 로만 표기). buildLog tail 에서 진짜 사유를 뽑아 진단/logs 에
 *  실어 조회 가능하게(분류 무변경·순수 관측). tail 없으면 ''. */
export function extractDelegateFailureReason(logTail: string): string {
  if (!logTail.trim()) return '';
  const parts: string[] = [];
  const stop = logTail.match(/goal-loop\s+stopReason=(\S+)(?:\s*·\s*iterations=(\d+))?(?:\s*·\s*toolCalls=(\d+))?/i);
  if (stop) parts.push(`stopReason=${stop[1]}${stop[2] ? ` iter=${stop[2]}` : ''}${stop[3] ? ` tools=${stop[3]}` : ''}`);
  const verify = logTail.match(/verify\([^)]*\)\s*→\s*(PASS|FAIL)|Verification (passed|failed)/i);
  if (verify) parts.push(`verify=${/pass/i.test(verify[0]) ? 'PASS' : 'FAIL'}`);
  if (/blocked|승인.{0,6}(대기|필요|전)|IMPLEMENTATION_STATUS:\s*SKIPPED_BLOCKED|CONTRACT_STATUS:\s*BLOCKED/i.test(logTail)) parts.push('blocked(HITL 승인 필요 추정)');
  const lastNarrative = logTail.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^\[tool #|^\[elanous-self\]|^\[\?/.test(l))
    .slice(-1)[0];
  if (lastNarrative) parts.push(`마지막: ${lastNarrative.slice(0, 200)}`);
  return parts.join(' · ');
}

/** bun test 로그에서 총 실패 수 추출(대표 2026-07-12·순수·테스트) — baseline 제외 비교용.
 *  "N fail" 패턴들의 합(스코프 여러 개면 여러 요약이 나올 수 있음). 없으면 0. */
export function extractFailCount(log: string): number {
  let total = 0;
  for (const m of log.matchAll(/(\d+)\s+fail\b/g)) total += Number.parseInt(m[1]!, 10);
  return total;
}

export function deriveGateScopes(changedFiles: string[], baseScope = 'src/autopilot/'): string[] {
  const dirs = new Set<string>([baseScope]);
  for (const f of changedFiles) {
    // ★ 커버리지 근본(대표 2026-07-13) — 이전 정규식 /^(src|test)\//는 tests/(복수)를 놓쳐,
    //   tests/ 아래 deliverable 테스트가 게이트에서 실행조차 안 됐다(price-guard sub8: 깨진 router
    //   테스트가 게이트 미실행으로 [done] 통과 → main에서 FAIL). 이건 "staleness"가 아니라 게이트가
    //   페이즈의 산출 테스트를 안 돌린 것. tests? = test 또는 tests 둘 다 인식 → tests/ 디렉토리가
    //   scope 에 들어가 `bun test tests/` 로 그 산출 테스트가 실제 실행된다(false-pass 차단).
    if (!/^(src|tests?)\//.test(f)) continue;
    const parts = f.split('/');
    if (parts.length < 2) continue;
    dirs.add(`${parts.slice(0, parts.length - 1).join('/')}/`); // 파일 상위 디렉토리
  }
  return [...dirs];
}

/** 실 seam 배선된 NocturnalDeps 를 구성(단일 출처·se-nocturnal-run·se-bridge 공유). */
export function makeNocturnalDeps(opts: NocturnalDepsOptions): NocturnalDeps {
  const { repoRoot, backend } = opts;
  const gateScope = opts.gateScope ?? 'src/autopilot/';
  const base = opts.base ?? 'main';
  const log = opts.log ?? ((s: string) => console.log(s));
  const record = opts.record ?? ((i) => { recordAutonomousActionSafe({ loop: 'autopilot', ...i }); });
  const runGate = opts.runIntegrityGate ?? runIntegrityGate;
  const changedFiles = opts.changedFiles ?? porcelainFiles;
  // ⛔⭐ 수명 계약(무인 리뷰 should-fix · 2026-08-04): 이 맵은 «이 deps 인스턴스의 메모리»에만 산다.
  //   ⇒ `makeNocturnalDeps` 를 다시 부르면 기준이 없는 «첫 라운드»로 취급된다(감소 판정이 안 걸린다).
  //   그래도 첫 라운드는 원래 비교 대상이 아니므로 «거짓 실패»는 안 난다 — 놓치는 쪽으로 안전하다.
  //   ⚠️ 프로세스를 넘겨 기준을 잇고 싶으면 저장소가 필요하고, 그 비용은 아직 재지 않았다.
  const previousPassCounts = new Map<string, number>();
  const scopeKey = (args: string[] | undefined): string => args ? [...new Set(args)].sort().join('\u0000') : 'full';

  return {
    createInstance: async (slug) => {
      if (opts.createInstance) return opts.createInstance(slug);
      const plan = createIsolatedInstance(repoRoot, slug, base);
      // ★ 구조정합 — LLM 지능형 충돌 해결(대표 2026-07-21·INCIDENT). base 가 se 스택이면 «해석된 기본 브랜치»(머지된
      //   PR)를 worktree 에 반영하되, walker 산출물과 충돌 시 LLM 이 양쪽을 종합 해결(기계적 theirs/abort 아님).
      if (base && base.startsWith('origin/se/')) {
        try {
          // ⛔⭐ 이 호출부는 종전에 대상을 «주지 않았다** — 병합 대상이 그 층에 박혀 있었기 때문이다.
          //   그 상수를 걷어내며 여기가 «남겨졌고**, 타입검사가 그것을 잡았다(리뷰 should-fix).
          //   ⚠️ 런타임에는 조용했다 — 인자가 undefined 로 흘러 아래 fail-soft 가 삼켰을 것이다.
          //   ⇒ 다른 두 호출부와 «같은 해석기»를 쓴다. 못 풀면 병합하지 않고 그 사실을 이름으로 남긴다.
          const { defaultBranchRef } = await import('../../self-implement/seams.js');
          let mergeTarget: string | null = null;
          let resolveError: string | undefined;
          try { mergeTarget = defaultBranchRef(plan.worktreePath); }
          catch (e) { resolveError = String((e as Error)?.message ?? e).slice(0, 200); }
          if (mergeTarget === null) {
            log(`[isolated] 기본 브랜치 해석 실패 — 정합 건너뜀(base 유지)${resolveError ? `: ${resolveError}` : ''}`);
            try { const { debug } = await import('../../debug/log.js'); debug.log('mission.exec.resume-merge', 'default-branch-unresolved', { slug, base, defaultBranchResolved: false, ...(resolveError === undefined ? {} : { resolveError }) }); } catch { /* fail-soft */ }
            return plan;
          }
          const { mergeMainIntoWorktreeWithLlm, formatLlmMergeOutcome } = await import('./llm-conflict-merge.js');
          const outcome = await mergeMainIntoWorktreeWithLlm(plan.worktreePath, mergeTarget);
          log(`[isolated] ${mergeTarget} 정합 — ${formatLlmMergeOutcome(outcome)}`);
          try { const { debug } = await import('../../debug/log.js'); debug.log('mission.exec.resume-merge', outcome.status, { slug, base, mergeTarget, defaultBranchResolved: true, resolvedFiles: outcome.resolvedFiles ?? [], sizeChange: outcome.sizeChange }); } catch { /* fail-soft */ }
        } catch { /* fail-soft — 정합 실패는 base 유지(종전 동작) */ }
      }
      return plan;
    },
    implement: async (plan, target) => {
      if (opts.implement) return opts.implement(plan, target);
      const planBody = existsSync(target.planPath) ? readFileSync(target.planPath, 'utf-8') : target.title;
      const prompt = [
        planBody, '', '---', '',
        '위 플랜을 이 worktree 에서 구현하라. 규칙:',
        '- ★★검증 우선(예산 관리·최우선): 파일 탐색(읽기)은 꼭 필요한 최소로만. 큰 구현을 한 번에',
        `  몰아서 하지 말고, 작은 단위로 [구현 → 즉시 \`${gateScope === 'full' ? 'bun test' : `bun test ${gateScope}`}\` 실행 → 통과 확인] 을 반복하라.`,
        '  탐색·구현에 예산을 다 쓰고 마지막에 검증하려 하면 예산이 소진돼 무결성 게이트에서 폐기된다',
        '  (실측 반복 실패 원인). 항상 green 상태를 유지하며 자주 검증하라 — 검증은 미루지 마라.',
        '- ★범위 준수: 이 플랜(페이즈)이 지목한 파일/모듈만 수정하라. 플랜에 없는 무관한 파일',
        '  (특히 mission-engine·autopilot 코어·다른 도메인)은 절대 건드리지 마라 — 범위 초과는',
        '  리뷰에서 반려된다. 테스트 통과를 위해서라도 무관 파일 변경 금지(테스트를 페이즈 범위에 맞춰라).',
        '- 작은 순수 함수 + 단위테스트(bun test) 위주. bun test 가 반드시 통과해야 한다.',
        '- 매매(trade-*)·arming·safety·재부팅·mandate 등 불변 코어는 절대 수정 금지.',
        '- 커밋하지 마라(변경만 남겨라). 완료되면 무엇을 했는지 한 줄 요약.',
      ].join('\n');
      log(`  [implement] ${backend} 격리 구현 시작 (cwd=worktree · maxTurns=${opts.maxTurns ?? 40})...`);
      // ★ 계측(제1원칙·2026-07-22 대표 지적) — SE delegate 실행 경계를 미션 logs.db 로. 종전 delegate
      //   결과(에러/산출0)가 run.log(console)+record 에만 가 `elanous logs` 조회 불가 = 관측 안 한 것.
      //   `elanous logs --category mission.se.build` 로 walker 실패 근본(에러메시지·산출수)을 즉시 조회.
      const seDbg = async (event: string, data: Record<string, unknown>) => {
        try { const { debug } = await import('../../debug/log.js'); debug.log('mission.se.build', event, { slug: target.slug, backend, maxTurns: opts.maxTurns ?? 40, ...data }); } catch { /* fail-soft */ }
      };
      await seDbg('delegate-start', {});
      try { runDelegate(repoRoot, plan.worktreePath, prompt, backend, gateScope, opts.maxTurns, opts.buildLogPath); }
      catch (e) {
        const base = `delegate 오류: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        // ★ 관측 보강(2026-07-22 dogfood) — execFileSync 의 "Command failed" 만으론 goal-loop 의 실제
        //   stopReason·에이전트 blocked 사유가 유실(buildLog 에만). tail 에서 진짜 "왜"를 뽑아 진단/logs 에 실음.
        let reason = '';
        if (opts.buildLogPath) { try { reason = extractDelegateFailureReason(readFileSync(opts.buildLogPath, 'utf8').slice(-2500)); } catch { /* fail-soft */ } }
        const msg = reason ? `${base} | ${reason}`.slice(0, 400) : base;
        await seDbg('delegate-error', { error: msg, buildLog: opts.buildLogPath ?? null, ...(reason ? { reason } : {}) });
        return { changed: false, error: true, summary: msg };
      }
      // ★ 실제 변경 판정(대표 2026-07-12) — deps 심링크 노이즈(node_modules·apps/pwa/out) 제외.
      //   그간 이 노이즈를 "변경" 으로 세어 빈 구현이 통과 → 껍데기 done + 가짜 PR. 이제 실제 src/
      //   test 변경만 카운트. 0 이면 no-op(이미 구현됨/변경 불필요)로 정직 보고.
      const files = realChangedFiles(porcelainFiles(plan.worktreePath));
      await seDbg('delegate-done', { changedFiles: files.length, files: files.slice(0, 8), buildLog: opts.buildLogPath ?? null });
      return { changed: files.length > 0, summary: files.length ? `${files.length} 파일 변경` : '실제 코드 변경 없음(no-op)' };
    },
    changedFiles: (plan) => changedFiles(plan.worktreePath),
    gate: async (plan) => {
      // ★ 변경 파일 기준 동적 스코프(오탐 방지) — 변경된 디렉토리 테스트를 실제 실행. 'full' 은 전체.
      //   ⚠️ C2 제외(대표 결정 2026-07-22) — ③(B) changedFileTypecheck tsc 게이트는 **baseline 제외 부재**로
      //   base-broken 파일 편집 시 기존 tsc 에러를 신규로 오판해 게이트 오탐(회귀 리스크). 재도입은 test 경로처럼
      //   worktree-vs-base tsc 대조 정합 후. ③(A) walker 스코프지침·failClass 관측·test baseline 제외는 유지.
      const args = gateScope === 'full' ? undefined : deriveGateScopes(changedFiles(plan.worktreePath), gateScope);
      const key = scopeKey(args);
      const previousPassCount = previousPassCounts.get(key);
      const result = await runGate(plan.worktreePath, {
        steps: ['test'],
        ...(args ? { testArgs: args } : {}),
        ...(previousPassCount === undefined ? {} : { previousPassCount }),
      });
      if (result.passed && result.testPassCount !== undefined) previousPassCounts.set(key, result.testPassCount);
      if (result.passed || !args) return result;
      // ⛔⭐⭐⭐ 통과 수 «감소» 실패는 baseline 흡수 대상이 «아니다»(무인 리뷰 must-fix · 2026-08-04).
      //   아래 흡수는 「base 가 이미 깨져 있으면 그 죄를 SE 변경에 씌우지 않는다」는 규칙인데,
      //   ***「통과 수가 줄었다」는 base 상태와 무관한 회귀***라 같은 저울에 올리면 안 된다.
      //   실측 형태: worktree 3 fail · base 5 fail 이면 `wtFails <= baseFails` 로 PASS 가 되어
      //   pass 5→4 감소가 조용히 삼켜진다.
      if (result.testPassCountRegressed) {
        log('  [gate] 통과 수 감소 — baseline 흡수 제외(base 상태와 무관한 회귀).');
        try { debug.log('mission.exec.gate', 'pass-count-regression', { slug: plan.slug, testPassCount: result.testPassCount }); } catch { /* fail-soft */ }
        return result;
      }
      // ★ baseline 제외(대표 2026-07-12) — 게이트 실패 시 base(main·repoRoot)에서 같은 스코프를
      //   돌려 기존 실패와 비교. 새 실패가 없으면(worktree fail ≤ baseline fail) pass 로 간주.
      //   그간 게이트가 스코프 내 무관한 baseline 실패(예: src/domains/ 5 fail)를 SE 변경 죄로
      //   뒤집어씌워 정직한 구현을 억울하게 죽였다(dogfood: P3 gate-failed·실제 회귀 아님).
      try {
        const baseline = await runGate(repoRoot, { steps: ['test'], testArgs: args });
        const wtFails = extractFailCount(result.log);
        const baseFails = extractFailCount(baseline.log);
        // ★ failClass 관측(근본·2026-07-22·핸드오프 3근본 #3) — 종전 baseline 제외는 "PASS 로 뒤집기"만
        //   하고 이 판정(base 기존실패 vs 회귀) 신호를 버렸다(failClass=unknown 근원). 여기서 각인:
        //   base-preexisting(회귀 아님) 이면 실패 test 목록까지 남겨 사람이 대조·재현. ★조회: elanous logs
        //   --category mission.exec.gate.
        const worktreeFailing = extractFailingTests(result.log);
        const baseFailing = new Set(extractFailingTests(baseline.log));
        const newFailing = worktreeFailing.filter((t) => !baseFailing.has(t));
        if (wtFails > 0 && wtFails <= baseFails) {
          log(`  [gate] baseline 제외 — worktree ${wtFails} fail ≤ base ${baseFails} fail(기존). 새 실패 없음 → PASS.`);
          try { debug.log('mission.exec.gate', 'base-preexisting', { slug: plan.slug, wtFails, baseFails, newFailing: newFailing.slice(0, 20), failing: worktreeFailing.slice(0, 20) }); } catch { /* fail-soft */ }
          return { ...result, passed: true };
        }
        // 진짜 회귀(worktree fail > base fail) — 새로 깨진 test 를 각인(재시도 근거·사람 대조).
        try { debug.log('mission.exec.gate', 'regression', { slug: plan.slug, wtFails, baseFails, newFailing: newFailing.slice(0, 20) }); } catch { /* fail-soft */ }
      } catch { /* fail-soft — baseline 실패는 원 결과 유지(보수적) */ }
      return result;
    },
    critique: async (plan, target) => {
      // ★ R0 결정론 + R1 LLM 비평(대표 2026-07-12) — 범위밖·Goodhart(+LLM 심층) flag.
      //   planBody=페이즈 PLAN·diff=git diff. opts.llmReview 주입 시 LLM 병합(미주입=결정론만).
      //   ★비평 오탐 수정(대표 2026-07-12): changedFiles 에서 deps 심링크 노이즈(node_modules·
      //   apps/pwa/out) 제외. makePr 는 이걸 커밋 제외라 PR 엔 없는데, 비평이 porcelain(untracked
      //   심링크 포함)을 보고 "범위밖" 오탐 → 모든 페이즈 FAIL 폭탄. 실제 변경만 비평 대상.
      const planBody = existsSync(target.planPath) ? readFileSync(target.planPath, 'utf-8') : target.title;
      // ★ untracked(새 파일) 본문 포함(2026-07-13 캡처 배선 수정) — 새 파일만 만드는 페이즈의 빈 diff FAIL 방지.
      const diff = worktreeDiffWithUntracked(plan.worktreePath);
      return critiquePhaseWithLLM({ planBody, changedFiles: realChangedFiles(porcelainFiles(plan.worktreePath)), diff }, opts.llmReview);
    },
    makePr: (plan, target, evidence, critique) => {
      // ★ 기존 PR 재활용(대표 2026-07-12) — pr-manager.upsertPr: 같은 브랜치 force-push 로 기존 PR
      //   자동 업데이트(닫고 새로 안 만듦·리뷰 히스토리 보존). 없으면 새로 생성. node_modules·
      //   apps/pwa/out 심링크 노이즈 add 제외. 비평 findings 는 R4 코멘트(재사용/신규 공통).
      const critiqueBlock = critique ? `\n\n## 🤖 자동 비평(R0)\n${renderCritique(critique)}` : '';
      const body = `Self-Evolution SE6 자율 구현 초안 · elanous 가 격리 worktree 에서 자율 구현 · 대표 리뷰 후 merge(HITL).${critiqueBlock}\n\n${renderGateEvidence(evidence)}\n\n🤖 Self-Evolution nocturnal runner`;
      const pm = opts.prManager ?? makePrManager();
      const outcome = pm.upsertPr({
        branch: plan.branch, worktreePath: plan.worktreePath,
        title: `[SE] ${target.title}`, body,
        commitMessage: `feat(self-evolution): SE6 자율 구현 — ${target.title}\n\n격리 worktree 자율 구현(merge HITL).\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`,
        excludePaths: ['node_modules', 'apps/pwa/out'],
        reuseComment: `🔄 재구현 반영(비평 지적 해소) — 같은 PR 업데이트(force-push·이전 구현 교체).${critiqueBlock}\n\n${renderGateEvidence(evidence)}`,
      });
      // ★ 관측 관문(대표 2026-07-21·제1원칙) — makePr 결과를 logs.db 에 각인. 종전엔 bare null 이라
      //   triage 가 실패 사유를 못 읽고 "인증·네트워크"로 환각했다. noop/failed(단계·detail)를 남긴다.
      const obsMakePr = (event: string, data: Record<string, unknown>) => {
        try { void import('../../debug/log.js').then(({ debug }) => debug.log('mission.exec.makePr', event, { slug: plan.branch, ...data })).catch(() => {}); } catch { /* fail-soft */ }
      };
      if (!outcome.ok) {
        // ★ noop(nothing to commit) = 실패가 아니라 이미 반영된 no-op(대표 2026-07-21·705308 근본). gate 는
        //   이미 통과했으므로 호출부(nocturnal-runner)가 pr-failed 가 아니라 no-change PASS 로 정직 처리한다.
        if (outcome.reason === 'noop') {
          log('  makePr no-op(nothing-to-commit) — 이미 반영됨·정직 PASS');
          obsMakePr('noop', { detail: outcome.detail });
          return { noop: true };
        }
        log(`  makePr 실패(${outcome.reason}): ${outcome.detail}`);
        obsMakePr('failed', { reason: outcome.reason, detail: outcome.detail });
        return null;
      }
      log(`  makePr ${outcome.reused ? '기존 PR 재사용(업데이트)' : '새 PR 생성'}: ${outcome.url}`);
      obsMakePr('built', { url: outcome.url, reused: outcome.reused });
      // ★ R4 비평 코멘트(대표 2026-07-12) — findings(warn/fail)를 별도 코멘트로. 재사용/신규 공통.
      if (critique && critique.findings.length && critique.verdict !== 'pass') {
        try {
          execFileSync('gh', ['pr', 'comment', outcome.url, '--body',
            `## 🤖 자동 비평 ${critique.verdict.toUpperCase()}\n${critique.findings.map((f) => `- ${f}`).join('\n')}\n\n> merge 전 확인 필요(대표 HITL). 재구현하려면 텔레그램 [🔧재구현] 버튼.`],
            { cwd: plan.worktreePath, stdio: 'ignore' });
        } catch { /* fail-soft */ }
      }
      return { url: outcome.url };
    },
    dispose: (plan) => {
      try { disposeIsolatedInstance(repoRoot, plan); } catch { /* */ }
      try { runGitCommand(repoRoot, ['branch', '-D', plan.branch], { stdio: 'ignore' }); } catch { /* */ }
    },
    ...(opts.markBuilt ? { markBuilt: opts.markBuilt } : {}),
    record,
  };
}
