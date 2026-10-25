/**
 * DEFAULT-HANDS-PERSONA-STAGE — 사람별 표본 여덟(마케터·현장·교육·경영 각 2)이 «과제 담당»으로 손 0 종결하는지
 * 생산 진입점(`handTask` → `recordTaskAgentShadowMove` → `executeNextAction` → `completion-evidence`)을 그대로 지나 잰다.
 *
 * 무대 이름: «격리 임시 무대 — 임시 git 작업 트리 ⊕ 대상 폴더 ⊕ :memory: 스케줄 DB ⊕ 임시 결정 원장».
 *   - HOME/상태 파일은 `mkdtempSync` 아래에만 쓰고, 스케줄 DB 는 `:memory:`, 결정 원장은 임시 stateDir 다.
 *   - 실행부 명령(`deps.command`)은 부르면 던진다 — 손 0 종결이면 코드 PR·하니스 명령이 하나도 없어야 한다.
 *   - 기본 손이 «개발»로 남아 있으면 이 무대는 종결에 이르지 못한다(카드의 종결 종류가 «조합 없음»으로 막힌다).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { openSchedulesDb } from '../domains/schedule-registry.js';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';
import { recordTaskAgentShadowMove, type TaskAgentShadowDeps } from './shadow.js';
import { DEFAULT_HANDS, defaultHandOf, handTask, readTaskCard, type CompletionKind, type TaskCard } from './task-hand.js';

const roots: string[] = [];
const temp = (name: string) => { const root = mkdtempSync(join(tmpdir(), `default-hands-${name}-`)); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Stage {
  worktree: string;
  target: string;
  statePath: string;
  schedulesDb: Database;
  ledger: DecisionLedger;
}

function stage(persona: string): Stage {
  const root = temp(persona);
  const worktree = join(root, 'worktree');
  const target = join(root, 'target');
  mkdirSync(worktree);
  mkdirSync(target);
  execFileSync('git', ['init', '-q', worktree]);
  return {
    worktree,
    target,
    statePath: join(root, 'task-agent-actions.json'),
    schedulesDb: openSchedulesDb(':memory:'),
    ledger: new DecisionLedger({ stateDir: join(root, 'ledger'), resolveVersion: () => ({ released: null, dev: null, codename: null }) }),
  };
}

/** 표본이 런 뒤에 남기는 «확인 증거» 재료 — 종류별 규칙(`completion-evidence.ts`)이 요구하는 것만 만든다. */
interface Produced { worktree: string; target: string; cardId: string; schedulesDb: Database; ledger: DecisionLedger }

interface PersonaSample {
  persona: '마케터' | '현장' | '교육' | '경영';
  /** 표본이 «기본 손»으로 넘기는 일 — 마케터·현장·교사·C 레벨의 실제 하루에서 온다. */
  ask: string;
  completion: CompletionKind;
  /** 종결 종류 중 «전달»로 닫히는 무리(research-report·artifact·content)만 실행부가 파일을 복사한다. */
  mode: 'live' | 'shadow';
  /** 이 표본 카드가 기본으로 받아야 하는 조합 파일(«실행·조사» 손). */
  composition: string;
  /** 런이 남긴 재료 — 카드 id 로 기록된다(카드 id = 그 과제의 기록 id). */
  produce: (produced: Produced) => void;
}

const report = [
  '# 경쟁사·트렌드 조사',
  '출처 https://a.example/trend https://b.example/market',
  '## 반대 근거',
  '반대 해석도 있다 — 성장률은 채널 편중 때문일 수 있다.',
].join('\n');

const PERSONA_SAMPLES: readonly PersonaSample[] = [
  {
    persona: '마케터', ask: '경쟁사·트렌드 조사 보고 한 장', completion: 'research-report', mode: 'live',
    composition: 'graphs/work/research-report.yaml',
    produce: ({ worktree }) => writeFileSync(join(worktree, 'report.md'), report),
  },
  {
    persona: '마케터', ask: '캠페인 콘텐츠 초안 쓰기', completion: 'content', mode: 'live',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ worktree }) => writeFileSync(join(worktree, 'draft.md'), '# 캠페인 초안\n\n첫 문단\n'),
  },
  {
    persona: '현장', ask: '작업 점검표 산출', completion: 'artifact', mode: 'live',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ worktree }) => writeFileSync(join(worktree, 'checklist.md'), '# 점검표\n\n- 밸브\n'),
  },
  {
    persona: '현장', ask: '이상 알림 발송하고 보낸 것을 다시 읽기', completion: 'ops-action', mode: 'shadow',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ target, cardId }) => writeFileSync(join(target, 'execution.jsonl'),
      [`{"id":"${cardId}","type":"execution"}`, `{"id":"${cardId}","type":"readback"}`].join('\n') + '\n'),
  },
  {
    persona: '교육', ask: '수업 자료 산출', completion: 'artifact', mode: 'live',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ worktree }) => writeFileSync(join(worktree, 'handout.md'), '# 수업 자료\n\n- 문제 1\n'),
  },
  {
    persona: '교육', ask: '교육과정 동향 조사 보고', completion: 'research-report', mode: 'live',
    composition: 'graphs/work/research-report.yaml',
    produce: ({ worktree }) => writeFileSync(join(worktree, 'report.md'), report),
  },
  {
    persona: '경영', ask: '아침 브리핑 일정 등록과 도착 확인', completion: 'watch-brief', mode: 'shadow',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ cardId, schedulesDb }) => schedulesDb.run(
      `INSERT INTO schedule_registry (id, name, source, category, last_status) VALUES (?, 'brief', 'test', 'report', 'ok')`, [cardId]),
  },
  {
    persona: '경영', ask: '선택지·권고가 붙은 결정 카드 올리기', completion: 'decision-support', mode: 'shadow',
    composition: 'graphs/work/run-research.yaml',
    produce: ({ cardId, ledger }) => {
      ledger.raise({ title: '결정 카드', category: 'other', scqa: { s: '상황', c: '복잡' },
        options: [{ key: 'a', label: 'A', consequence: 'A' }, { key: 'b', label: 'B', consequence: 'B' }],
        recommendation: { option: 'a', why: '근거' }, raisedBy: { agent: 'test' }, refs: [cardId] });
    },
  },
];

const job = (over: Partial<SupervisorJobResult>) => ({ taskId: 't', feature: 'feature ask', status: 'done', ...over }) as SupervisorJobResult;

describe('DEFAULT-HANDS — 사람별 표본 여덟이 과제 담당으로 손 0 종결', () => {
  test('기본 손은 «개발»이 아니라 «실행·조사» — 종결 다섯 ⊕ 콘텐츠가 그 손으로 간다', () => {
    expect(defaultHandOf('code-pr')).toBe('develop');
    for (const kind of ['research-report', 'artifact', 'content', 'ops-action', 'watch-brief', 'decision-support'] as const) {
      expect(defaultHandOf(kind)).toBe('run-research');
      expect(DEFAULT_HANDS[kind].codeHarness).toBe(false);
      expect(DEFAULT_HANDS[kind].evidence).toBeTruthy();
    }
    // 코드 하니스는 개발자 팩 — code-pr 만 자식 구현 런·PR 착지를 쓴다.
    expect(DEFAULT_HANDS['code-pr'].codeHarness).toBe(true);
    expect(DEFAULT_HANDS['code-pr'].hand).toBe('develop');
  });

  test('표본 여덟이 생산 진입점을 지나 손 0 으로 종결된다 — 코드 PR 0 · 하니스 명령 0', async () => {
    const closed: Array<{ persona: string; completion: CompletionKind; cardId: string; move: string; evidence: string }> = [];
    for (const sample of PERSONA_SAMPLES) {
      const s = stage(sample.persona);
      try {
        const handed = await handTask({ text: sample.ask, completion: sample.completion,
          project: { id: sample.persona, target: s.target }, statePath: s.statePath });
        // 기본 손이 «실행·조사»면 종류별 조합이 없어도 그 손의 조합으로 카드가 서고, 코드 하니스로 발사되지 않는다.
        expect({ completion: handed.card.completion, composition: handed.card.composition?.file, status: handed.card.status })
          .toEqual({ completion: sample.completion, composition: sample.composition, status: 'handed' });
        expect(handed.move.command?.[0]).not.toBe('harness');
        expect(handed.card.pr).toBeUndefined();

        sample.produce({ ...s, cardId: handed.card.id });

        const commands: string[][] = [];
        const deps: TaskAgentShadowDeps = {
          readCard: () => readTaskCard(handed.card.id, s.statePath),
          env: {},
          log: () => {},
          mode: sample.mode,
          liveMoves: new Set(),
          evidence: { schedulesDb: s.schedulesDb, ledger: s.ledger },
          command: async (args) => { commands.push([...args]); throw new Error('손 0 종결인데 실행부 명령이 불렸다'); },
        };
        const out = await recordTaskAgentShadowMove({ runId: `run-${handed.card.id}`, stopReason: 'converged',
          results: [job({ taskId: handed.card.id, feature: sample.ask, ok: true, worktreePath: s.worktree })] }, deps);

        expect({ persona: sample.persona, completion: sample.completion, move: out.move, pr: out.pr, commands: commands.length })
          .toEqual({ persona: sample.persona, completion: sample.completion, move: 'propose-green', pr: null, commands: 0 });
        expect(readTaskCard(handed.card.id, s.statePath)?.pr).toBeUndefined();
        if (sample.mode === 'live') {
          // 전달 손 — 산출물이 대상 폴더 `elanous-out/<카드>/` 에 실제로 복사됐다(미리보기까지 같은 자리).
          expect(existsSync(join(s.target, 'elanous-out', handed.card.id))).toBe(true);
        } else {
          expect(out.executorResult).toBe('shadow');
        }
        closed.push({ persona: sample.persona, completion: sample.completion, cardId: handed.card.id, move: out.move, evidence: out.reason });
      } finally { s.schedulesDb.close(); }
    }
    // 여덟 표본 전부 — 사람 손 0. 종결 종류가 다섯 갈래(조사·산출물·콘텐츠·실행·감시·결정)로 흩어져 있다.
    expect(closed).toHaveLength(8);
    expect(new Set(closed.map((item) => item.completion)))
      .toEqual(new Set<CompletionKind>(['research-report', 'artifact', 'content', 'ops-action', 'watch-brief', 'decision-support']));
    for (const persona of ['마케터', '현장', '교육', '경영'] as const) {
      expect(closed.filter((item) => item.persona === persona)).toHaveLength(2);
    }
    expect(closed.every((item) => item.move === 'propose-green')).toBe(true);
    // 근거는 종류별 «확인 증거» 규칙에서 온다 — 근거 ref 는 그 표본의 카드 id(= 그 과제의 기록 id)다.
    for (const item of closed) expect(item.evidence).toContain(item.cardId);
  });

  test('저장소 증거가 덜 차면 종결이 아니라 재발사다 — 증거 규칙이 실제로 「재는」 중이라는 뜻', async () => {
    const s = stage('ops');
    try {
      const handed = await handTask({ text: '이상 알림 발송', completion: 'ops-action',
        project: { id: 'ops', target: s.target }, statePath: s.statePath });
      // 실행 기록만 있고 «되읽기»가 없다 — 종결 종류 규칙(`completion-evidence.ts`)이 이걸 통과시키면 안 된다.
      writeFileSync(join(s.target, 'execution.jsonl'), `{"id":"${handed.card.id}","type":"execution"}\n`);
      const out = await recordTaskAgentShadowMove({ runId: 'run-ops', stopReason: 'converged',
        results: [job({ taskId: handed.card.id, feature: '이상 알림 발송', ok: true, worktreePath: s.worktree })] },
        { readCard: () => readTaskCard(handed.card.id, s.statePath), env: {}, log: () => {}, liveMoves: new Set(),
          evidence: { schedulesDb: s.schedulesDb, ledger: s.ledger }, command: async () => { throw new Error('no commands'); } });
      expect(out.move).toBe('narrow-relaunch');
      expect(out.reason).toContain(`확인 증거 미충족(${handed.card.id})`);
    } finally { s.schedulesDb.close(); }
  });

  test('개발자 팩 — code-pr 카드는 종전대로 PR 병합이 종결이고 코드 하니스를 쓴다', async () => {
    expect(DEFAULT_HANDS['code-pr']).toMatchObject({ hand: 'develop', codeHarness: true });
    const s = stage('dev');
    try {
      const card: TaskCard = { id: 'ta-code-pr', text: 'ship code', completion: 'code-pr',
        project: { id: 'dev', target: s.worktree }, createdAt: '', status: 'launched', history: [] };
      const { writeTaskCards } = await import('./task-hand.js');
      writeTaskCards(s.statePath, [card]);
      const out = await recordTaskAgentShadowMove({ runId: 'run-code', stopReason: 'converged',
        results: [job({ taskId: card.id, ok: true, worktreePath: s.worktree, prNumber: 9, merged: true })] },
        { readCard: () => card, env: {}, log: () => {}, liveMoves: new Set(),
          prFiles: async () => ['src/feature.ts'], command: async () => { throw new Error('no commands'); } });
      expect(out).toMatchObject({ move: 'propose-green', pr: 9 });
    } finally { s.schedulesDb.close(); }
  });
});
