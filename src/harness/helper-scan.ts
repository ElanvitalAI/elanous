import { execFileSync } from 'node:child_process';
import { debug } from '../debug/log.js';

export type StoppedPrCategory = 'review-budget' | 'no-progress' | 'environment-gap' | 'memo-not-reflected' | 'review-oscillation' | 'goal-revision' | 'report-deficit' | 'unknown';
export type StoppedPrClassification = {
  category: StoppedPrCategory;
  signals: string[];
  firstAction: string;
  blockers: string[];
  blockerCount: number;
  hasPublicExportLeak: boolean;
};

function section(body: string, title: string): string {
  const heading = `## ${title}`;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function field(text: string, key: string): string {
  const line = text.split(/\r?\n/).find((entry) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*[:：]\\s*`, 'i').test(entry));
  return line?.replace(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*[:：]\\s*`, 'i'), '').trim().replace(/^`|`$/g, '') ?? '';
}

export function classifyStoppedPr({ body, comments }: { body: string; comments: readonly (string | { body: string })[] }): StoppedPrClassification {
  const stop = section(body, '중단 사유');
  const classification = section(body, '중단 원인 분류');
  const gate = section(body, 'Gate');
  const reason = field(stop, 'reason');
  const verdict = field(stop, 'verdict');
  const label = field(classification, 'classification');
  const basis = field(classification, 'classificationBasis');
  const commentText = comments.map((comment) => typeof comment === 'string' ? comment : comment.body);
  const signals = [reason, verdict, label, basis].filter(Boolean);
  const allBlockers = gate.split(/\r?\n/).filter((line) => /^\s*(?:✗\s+|\[test\]\s+FAIL\b)/i.test(line));
  const blockers = allBlockers.slice(0, 5);
  const publicExportLeak = allBlockers.find((line) => /^\s*✗\s+public-export-leak\b/i.test(line));
  if (publicExportLeak && !blockers.includes(publicExportLeak)) signals.push(publicExportLeak);
  const failedTests = allBlockers.filter((line) => /^\s*\[test\]\s+FAIL\b.*[—–-](?:\s*\d+\s+(?:pass|fail|skip|errors?)\b\s*[,|])*\s*[1-9]\d*\s+errors?\b/i.test(line));
  const failedPwaTest = failedTests.find((line) => /\bapps\/pwa\/[^\s]*\.test\.tsx?\b/i.test(line));
  if (failedPwaTest) signals.push(failedPwaTest);
  const hostRetest = /(?:^|;\s*)host=[^;\n]+;\s*cause=(?:missing (?:node_modules|dependency|environment variable)|호스트 의존성 없음)[^;\n]*;\s*retest=PASS bun test (\S+\.test\.tsx?)(?:\s*(?:;|$))/i.exec(basis);
  // A code error in the Gate outranks any written basis: a basis string alone never turns a code failure into an environment gap.
  const codeErrorInGate = /\b(?:TypeError|ReferenceError|SyntaxError|RangeError)\b|expect\(received\)/.test(gate);
  const hostFailureConfirmed = !codeErrorInGate && Boolean(hostRetest && failedTests.some((line) => {
    const failedPath = /^\s*\[test\]\s+FAIL\s+bun test (\S+\.test\.tsx?)\s+[—–-]/i.exec(line)?.[1];
    return failedPath === hostRetest?.[1];
  }));
  const reviews = commentText.flatMap((text) => {
    const round = Number(/<!--\s*elanous-pr-comment v1 role=reviewer round=(\d+)\b/.exec(text)?.[1] ?? /\bRound\s+(\d+):\s*reviewer requested\b/i.exec(text)?.[1] ?? -1);
    const mustFix = /\bRound\s+\d+:\s*reviewer requested\s+(\d+)\s+must-fix change\(s\)/i.exec(text);
    return mustFix ? [{ round, count: Number(mustFix[1]), evidence: mustFix[0] }] : [];
  }).sort((a, b) => b.round - a.round);
  const latest = reviews[0];
  if (latest) signals.push(latest.evidence);

  const stopEvidence = `${reason}\n${verdict}\n${label}\n${basis}\n${body.match(/정지\((?:needs-human|no-progress)\)/g)?.join('\n') ?? ''}`;
  let category: StoppedPrCategory = 'unknown';
  let action = '하지 않음 — 정지 원인 근거 부족';
  if (hostFailureConfirmed && failedTests.length > 0 && (/(?:자식\s*무관|environment(?:-gap|al)?|환경\s*결손)/i.test(`${label}\n${basis}`) || failedPwaTest)) {
    category = 'environment-gap';
    action = '그래프 인스턴스 성형 — 호스트에서 실패 시험만 재측; 원 Gate 보존';
  } else if (/(?:메모\s*미반영|memo[- ]not[- ]reflected)/i.test(`${label}\n${basis}\n${reason}`)) {
    category = 'memo-not-reflected';
    action = '안내 메모 — 동일 칸의 살아 있는 런과 다음 산출 대조; 대상 불명이면 하지 않음';
  } else if (/(?:리뷰\s*진동|설계\s*역행|review[- ]oscillation)/i.test(`${label}\n${basis}\n${reason}`)) {
    category = 'review-oscillation';
    action = latest?.count ? '헬퍼 자식 spawn — 기존 시험 설계 보존 후 한 라운드' : '하지 않음 — 구체적인 must-fix 없음';
  } else if (label === 'goal-unconvergeable-candidate' || basis === 'supervisor-unconvergeable-goal-candidate') {
    category = 'goal-revision';
    signals.push(label === 'goal-unconvergeable-candidate'
      ? `classification=${label} → goal-revision`
      : `classificationBasis=${basis} → goal-revision`);
    action = '골 개정 — 골 문면(판정 신호·경계)을 고쳐 재발사; 구현 자식 붙이지 않음';
  } else if (label === 'report-deficit') {
    category = 'report-deficit';
    signals.push(`classification=${label} → report-deficit`);
    action = '증거 재측 — 인용된 판정 명령을 호스트에서 다시 돌려 결과를 PR 에 남김; 코드 수정 아님';
  } else if (/review-budget/i.test(stopEvidence) || basis === 'must-fix-reported') {
    // Real supervisor bodies (UNCONVERGEABLE · implementation-deficit) carry `classificationBasis: must-fix-reported` instead of the RFC word.
    if (basis === 'must-fix-reported') signals.push('classificationBasis=must-fix-reported → review-budget');
    category = 'review-budget';
    action = latest?.count ? '헬퍼 자식 spawn — must-fix 원문과 기존 시험 설계로 한 라운드' : '하지 않음 — must-fix 0 또는 미관측; 수리 자식 대상 아님';
  } else if (/no-progress/i.test(stopEvidence) || basis === 'no-must-fix-without-clean-worktree-or-completed-without-changes') {
    if (basis === 'no-must-fix-without-clean-worktree-or-completed-without-changes') signals.push(`classificationBasis=${basis} → no-progress`);
    category = 'no-progress';
    const green = /\[test\]\s+PASS\b/.test(gate) && !/\[test\]\s+FAIL\b/.test(gate);
    const documentGoal = /(?:문서\s*(?:골|목표)|docs?\/|RFC)/i.test(`${reason}\n${basis}\n${body.split(/\r?\n/)[0] ?? ''}`);
    action = green && latest?.count === 0 && documentGoal
      ? '중간 착지 ⊕ 연결 골 — must-fix 0 · 시험 초록 · 문서 골이면 잔여 확인; 잔여 0이면 연결 골 하지 않음'
      : '중간 착지 ⊕ 연결 골 — 녹색 조각만 확인; 불가분 골·실패 Gate 착지 하지 않음';
  }
  return {
    category, signals,
    firstAction: allBlockers.length
      ? `Gate 차단 먼저${publicExportLeak ? ' (✗ public-export-leak 확인)' : category === 'environment-gap' ? ' (그래프 인스턴스 성형으로 호스트 실패 시험 재측)' : ''}`
      : action,
    blockers, blockerCount: allBlockers.length, hasPublicExportLeak: Boolean(publicExportLeak),
  };
}

/** Stopped means the supervisor wrote a stop verdict or reason into the `## 중단 사유` section — a quoted heading or stop wording elsewhere in the body (goal text, templates) does not count. */
export function isStoppedPrBody(body: string): boolean {
  const stop = section(body, '중단 사유');
  return Boolean(field(stop, 'verdict') || field(stop, 'reason'));
}

export type ScannedStoppedPr = StoppedPrClassification & { pr: number; headRefName: string; isDraft: boolean };
export type RunGh = (args: readonly string[]) => string | Promise<string>;

export async function scanStoppedPrs({ runGh }: { runGh: RunGh }): Promise<ScannedStoppedPr[]> {
  const prs = JSON.parse(await runGh(['pr', 'list', '--state', 'open', '--limit', '100000', '--json', 'number,headRefName,isDraft,body'])) as Array<{ number: number; headRefName: string; isDraft: boolean; body: string }>;
  const results: ScannedStoppedPr[] = [];
  for (const pr of prs) {
    if (!pr.headRefName.startsWith('self-impl/') || !isStoppedPrBody(pr.body)) continue;
    const data = JSON.parse(await runGh(['pr', 'view', String(pr.number), '--json', 'comments'])) as { comments: Array<{ body: string }> };
    const result = classifyStoppedPr({ body: pr.body, comments: data.comments });
    debug.log('harness.helper', 'classified', { pr: pr.number, category: result.category, firstAction: result.firstAction, blockers: result.blockers, blockerCount: result.blockerCount, hasPublicExportLeak: result.hasPublicExportLeak });
    results.push({ pr: pr.number, headRefName: pr.headRefName, isDraft: pr.isDraft, ...result });
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const recordShadows = args.includes('--record-shadows');
  if (args.some((arg) => arg !== '--json' && arg !== '--record-shadows') || (json && recordShadows) || args.length > 1) {
    console.error('사용법: bun src/harness/helper-scan.ts [--json | --record-shadows]');
    process.exitCode = 1;
  } else {
    // 열린 PR 본문 전체는 기본 버퍼(1MB)를 넘는다(10-05 운영 ENOBUFS) — 넉넉히 준다.
    const runGh = (args: readonly string[]) => execFileSync('gh', [...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const rows = await scanStoppedPrs({ runGh });
    if (recordShadows) {
      // 명시적 그림자 기록에서만 추가 PR 조회와 헬퍼 원장 쓰기를 수행한다(발사 0).
      const { recordRepairShadows } = await import('./helper-repair.js');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      const { getUserConfig } = await import('../user-config.js');
      const root = effectiveInstanceRoot();
      const config = getUserConfig();
      const live = config.harness?.helper?.repair === 'live';
      const shadows = await recordRepairShadows(rows, {
        runGh, root, config,
        // live 만 대기열에 넣는다. 실제 발사는 기존 대기열 틱이 한다(새 발사 경로 0).
        ...(live ? { enqueue: async (input) => {
          const { addHarnessQueue } = await import('./harness-queue.js');
          return addHarnessQueue(input, { root });
        } } : {}),
      });
      if (shadows.length) console.log(live ? `수리 골 ${shadows.length}건 → helper/repairs.jsonl` : `수리 골 그림자 ${shadows.length}건 → helper/repairs.jsonl`);
    }
    if (json) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) {
      const gate = row.blockerCount ? ` · Gate 차단 ${row.blockerCount}(${row.hasPublicExportLeak ? row.blockers.find((line) => /public-export-leak/i.test(line))?.trim() ?? '✗ public-export-leak (6번째 이후)' : row.blockers[0]!.trim()})` : '';
      console.log(`#${row.pr} ${row.category}${gate} → ${row.firstAction}`);
    }
  }
}
