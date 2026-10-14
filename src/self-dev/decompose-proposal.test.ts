import { test, expect, describe } from 'bun:test';
import { pickDecomposeProposals, readDecomposeProposals, orderPiecesTopologically } from './decompose-proposal.js';

const ev = (shardId: string, pieces: unknown[], round?: number) => ({
  event: 'decomposition-shadow-goals',
  shardId,
  data: { pieceCount: pieces.length, pieces, ...(round === undefined ? {} : { round }) },
});
const P = (id: string, feature = `feat ${id}`, dependsOn: string[] = []) => ({ id, feature, dependsOn });

describe('pickDecomposeProposals — 하니스가 낸 「이렇게 쪼개라」를 «값»으로 읽는다', () => {
  test('⭐ 조각별로 제안을 뽑는다', () => {
    const m = pickDecomposeProposals([
      ev('task:a', [P('1'), P('2', 'feat 2', ['1'])]),
      { event: 'run-status', shardId: 'task:a', data: {} },
      ev('task:b', [P('x'), P('y'), P('z')]),
    ]);
    expect([...m.keys()].sort()).toEqual(['task:a', 'task:b']);
    expect(m.get('task:a')!.pieces.map((p) => p.id)).toEqual(['1', '2']);
    expect(m.get('task:a')!.pieces[1]!.dependsOn).toEqual(['1']);
    expect(m.get('task:b')!.pieces.length).toBe(3);
  });

  test('⛔ 조각이 «하나»면 분해가 아니다 — 같은 골을 이름만 바꿔 다시 거는 셈', () => {
    expect(pickDecomposeProposals([ev('task:a', [P('only')])]).size).toBe(0);
  });

  test('⭐ shardId 가 없으면 runId 로 단일 런 제안을 잇는다', () => {
    const m = pickDecomposeProposals([{ event: 'decomposition-shadow-goals', runId: 'run-single', data: { pieces: [P('1'), P('2')] } }]);
    expect(m.get('run-single')!.pieces.map((p) => p.id)).toEqual(['1', '2']);
  });

  test('⭐ shardId 가 있으면 runId 대신 shardId 에 붙인다', () => {
    const m = pickDecomposeProposals([{ event: 'decomposition-shadow-goals', shardId: 'task:a', runId: 'run-single', data: { pieces: [P('1'), P('2')] } }]);
    expect([...m.keys()]).toEqual(['task:a']);
  });

  test('⛔ shardId 와 runId 가 모두 없는 제안은 버린다 — 아무 데나 붙이지 않는다', () => {
    const m = pickDecomposeProposals([{ event: 'decomposition-shadow-goals', data: { pieces: [P('1'), P('2')] } }]);
    expect(m.size).toBe(0);
  });

  test('hotPaths 를 보존하고, 없으면 키를 생략하며, 비문자열 원소는 버린다', () => {
    const m = pickDecomposeProposals([
      ev('task:a', [
        { ...P('1'), hotPaths: ['src/one.ts', 3, null, 'src/two.ts'] },
        P('2'),
        { ...P('3'), hotPaths: ['src/three.ts'] },
      ]),
    ]);
    const pieces = m.get('task:a')!.pieces;
    expect(pieces[0]!.hotPaths).toEqual(['src/one.ts', 'src/two.ts']);
    expect(Object.keys(pieces[1]!)).toEqual(['id', 'feature', 'dependsOn']);
    expect(pieces[2]!.hotPaths).toEqual(['src/three.ts']);
  });

  test('⭐ 늦은 라운드가 이긴다', () => {
    const m = pickDecomposeProposals([
      ev('task:a', [P('old1'), P('old2')], 1),
      ev('task:a', [P('new1'), P('new2'), P('new3')], 3),
    ]);
    expect(m.get('task:a')!.pieces.length).toBe(3);
    expect(m.get('task:a')!.round).toBe(3);
  });

  test('⛔ 이른 라운드가 «뒤에» 와도 늦은 것을 밀어내지 못한다', () => {
    const m = pickDecomposeProposals([
      ev('task:a', [P('new1'), P('new2'), P('new3')], 3),
      ev('task:a', [P('old1'), P('old2')], 1),
    ]);
    expect(m.get('task:a')!.pieces.length).toBe(3);
  });

  test('늦게 정착한 제안(late-settled)도 읽는다', () => {
    const m = pickDecomposeProposals([
      { event: 'decomposition-shadow-late-settled', shardId: 'task:a', data: { pieces: [P('1'), P('2')] } },
    ]);
    expect(m.size).toBe(1);
  });

  test('feature 가 빈 조각은 «세지 않는다»', () => {
    const m = pickDecomposeProposals([ev('task:a', [P('1'), { id: '2', feature: '   ' }, P('3')])]);
    expect(m.get('task:a')!.pieces.map((p) => p.id)).toEqual(['1', '3']);
  });
});

describe('readDecomposeProposals — 원장을 훑는다 (⛔ 「0건」과 「못 읽음」을 다른 값으로)', () => {
  const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

  test('⭐ 관심 조각만 모은다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'],
      dir: '/led',
      list: () => ['r1.jsonl', 'r2.jsonl', 'notes.txt'],
      read: (p) => p.endsWith('r1.jsonl')
        ? lines(ev('task:a', [P('1'), P('2')]))
        : lines(ev('task:zzz', [P('9'), P('8')])),
    });
    expect(scan.scannedFiles).toBe(2);            // .txt 는 안 센다
    expect(scan.proposals.size).toBe(1);
    expect(scan.proposals.has('task:a')).toBe(true);
    expect(scan.unreadableFiles).toBe(0);
    expect(scan.directoryMissing).toBe(false);
  });

  test('⭐ shardId 없는 실제 원장 행은 runIds 로 모아 승격용 key를 만든다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], runIds: ['run-single'], dir: '/led',
      list: () => ['run-single.jsonl', 'other.jsonl'],
      read: (p) => p.endsWith('run-single.jsonl')
        ? lines({ event: 'decomposition-shadow-goals', runId: 'run-single', data: { pieces: [P('1', 'part one'), P('2', 'part two')] } })
        : lines({ event: 'decomposition-shadow-goals', runId: 'run-other', data: { pieces: [P('x'), P('y')] } }),
    });
    expect([...scan.proposals.keys()]).toEqual(['run-single']);
    expect(scan.proposals.get('run-single')!.pieces.map((p) => p.feature)).toEqual(['part one', 'part two']);
  });

  test('⭐ shardId 우선 규칙은 중복 runId 조회에도 shard proposal만 고른다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], runIds: ['run-a', 'run-a'], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines(
        { event: 'decomposition-shadow-goals', shardId: 'task:a', runId: 'run-a', data: { pieces: [P('s1'), P('s2')] } },
        { event: 'decomposition-shadow-goals', runId: 'run-a', data: { pieces: [P('r1'), P('r2')] } },
      ),
    });
    expect([...scan.proposals.keys()].sort()).toEqual(['run-a', 'task:a']);
    expect(scan.proposals.get('task:a')!.pieces.map((p) => p.id)).toEqual(['s1', 's2']);
  });

  test('⛔ 디렉토리가 «없다»는 「제안 0」과 다른 값이다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], dir: '/none',
      list: () => { const e = new Error('nope') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; },
    });
    expect(scan.directoryMissing).toBe(true);
    expect(scan.proposals.size).toBe(0);
    expect(scan.scannedFiles).toBe(0);
  });

  test('⛔ 못 읽은 파일을 «센다» — 조용히 0으로 접지 않는다', () => {
    const scan = readDecomposeProposals({
      shardIds: [], dir: '/led',
      list: () => ['ok.jsonl', 'broken.jsonl'],
      read: (p) => { if (p.endsWith('broken.jsonl')) throw new Error('EACCES'); return lines(ev('task:a', [P('1'), P('2')])); },
    });
    expect(scan.scannedFiles).toBe(2);
    expect(scan.unreadableFiles).toBe(1);
    expect(scan.proposals.size).toBe(1);
  });

  test('깨진 줄은 건너뛰고 나머지를 읽는다', () => {
    const scan = readDecomposeProposals({
      shardIds: [], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => '{ not json\n' + lines(ev('task:a', [P('1'), P('2')])),
    });
    expect(scan.proposals.size).toBe(1);
  });

  test('shardIds 가 비면 «전부» 본다', () => {
    const scan = readDecomposeProposals({
      shardIds: [], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines(ev('task:a', [P('1'), P('2')]), ev('task:b', [P('3'), P('4')])),
    });
    expect(scan.proposals.size).toBe(2);
  });

  test('CONTRACT-CONFLICT 완화 적용 실패는 attempted=1 applied=0 과 이름 있는 실패 사유로 읽힌다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines({ event: 'rework-budget', shardId: 'task:a', data: { verdict: 'CONTRACT-CONFLICT', contractConflictRelaxation: { application: { status: 'failed', detail: 'expected-text-not-found' } } } }),
    });
    expect(scan.goalPlanRevisions.get('task:a')).toEqual({ status: 'read', attempted: 1, applied: 0, failureReasons: ['expected-text-not-found'] });
  });

  test('CONTRACT-CONFLICT 완화가 없으면 성공적으로 읽은 attempted=0 관측이다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines({ event: 'rework-budget', shardId: 'task:a', data: { verdict: 'CONTRACT-CONFLICT' } }),
    });
    expect(scan.goalPlanRevisions.get('task:a')).toEqual({ status: 'read', attempted: 0, applied: 0, failureReasons: [] });
    expect(scan.readFailure).toBeUndefined();
  });

  test('원장 데이터를 읽을 수 없으면 0이 아니라 read-failed 관측이다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], dir: '/led',
      list: () => ['broken.jsonl'],
      read: () => { throw new Error('EACCES'); },
    });
    expect(scan.goalPlanRevisions.has('task:a')).toBe(false);
    expect(scan.readFailure).toEqual({ status: 'read-failed', reason: 'unreadable-files', scannedFiles: 1, unreadableFiles: 1, ledgerDirectory: '/led' });
  });

  test('실패 사유가 «없으면» 사유를 지어내지 않고 미상임을 이름으로 남긴다', () => {
    // ⛔ 'failed' 는 «상태»이지 «사유»가 아니다 — 그것을 failureReasons 에 실으면
    //   「원인을 안다」는 거짓 신호가 된다(UNKNOWN-DEFAULT · 리뷰 지적 2026-08-21).
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines({ event: 'rework-budget', shardId: 'task:a', data: { verdict: 'CONTRACT-CONFLICT', contractConflictRelaxation: { application: 'failed' } } }),
    });
    expect(scan.goalPlanRevisions.get('task:a')).toEqual({ status: 'read', attempted: 1, applied: 0, failureReasons: ['unknown-failure-reason'] });
    expect(scan.goalPlanRevisions.get('task:a')?.failureReasons).not.toContain('failed');
  });

  test('같은 런의 완화 적용 성공은 applied=1 로 읽힌다', () => {
    const scan = readDecomposeProposals({
      shardIds: ['task:a'], runIds: ['run-a'], dir: '/led',
      list: () => ['r.jsonl'],
      read: () => lines({ event: 'rework-budget', runId: 'run-a', data: { verdict: 'CONTRACT-CONFLICT', contractConflictRelaxation: { application: 'applied' } } }),
    });
    expect(scan.goalPlanRevisions.get('run-a')).toEqual({ status: 'read', attempted: 1, applied: 1, failureReasons: [] });
  });
});

import { applyDecomposeProposals } from './decompose-proposal.js';

const G = (feature: string, extra: Record<string, unknown> = {}) => ({ feature, openPr: true, autoMerge: true, base: 'main', ...extra }) as never;
const R = (feature: string, pieces?: Array<{ id: string; feature: string; dependsOn: string[] }>) =>
  ({ taskId: 't:' + feature, feature, status: 'done', stage: 'pr-opened', ...(pieces ? { decomposeProposal: { pieces } } : {}) }) as never;

describe('applyDecomposeProposals — 「쪼개서 다시」의 «집행» (단일 → 연합 승격)', () => {
  test('⭐ 제안이 있는 goal 을 조각으로 «치환»하고 승격 플래그를 물려준다', () => {
    const r = applyDecomposeProposals(
      [G('big'), G('other')],
      [R('big', [{ id: 'p1', feature: 'part 1', dependsOn: [] }, { id: 'p2', feature: 'part 2', dependsOn: ['p1'] }]), R('other')],
    );
    expect(r.decomposed).toEqual(['big']);
    expect(r.goals.map((g) => g.feature)).toEqual(['part 1', 'part 2', 'other']);
    expect(r.goals[1]!.dependsOn).toEqual(['p1']);
    expect(r.goals[0]!.openPr).toBe(true);      // 승격 플래그 상속
    expect(r.goals[0]!.autoMerge).toBe(true);
    expect(r.goals[0]!.base).toBe('main');
  });

  test('⛔ 같은 goal 을 «두 번» 쪼개지 않는다', () => {
    const pieces = [{ id: 'p1', feature: 'part 1', dependsOn: [] }, { id: 'p2', feature: 'part 2', dependsOn: [] }];
    const r = applyDecomposeProposals([G('big')], [R('big', pieces)], { alreadyDecomposed: new Set(['big']) });
    expect(r.decomposed).toEqual([]);
    expect(r.goals.map((g) => g.feature)).toEqual(['big']);
  });

  test('제안이 없으면 goals 가 «그대로»', () => {
    const r = applyDecomposeProposals([G('a'), G('b')], [R('a'), R('b')]);
    expect(r.decomposed).toEqual([]);
    expect(r.goals.map((g) => g.feature)).toEqual(['a', 'b']);
  });

  test('⛔ 상한을 넘기면 «쪼개지 않는다» — 조용히 자르지 않고 원본을 둔다', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, feature: 'part ' + i, dependsOn: [] }));
    const r = applyDecomposeProposals([G('big')], [R('big', many)], { maxGoals: 5 });
    expect(r.decomposed).toEqual([]);
    expect(r.goals.map((g) => g.feature)).toEqual(['big']);
  });

  // ⛔⭐ RUN-T82 (2026-09-06) — `...goal` 이 «부모의» hotPaths 를 조각 전부에 흘리면
  //   `orchestrate.ts:1105` 가 그 겹침으로 ***전부를 한 줄로 직렬화***한다(위상이 아니라 사슬).
  //   ⇒ 조각 자신의 것으로 «덮고», 없으면 «지운다». 이 시험이 그 방향을 문다.
  test('⭐ 조각은 부모의 hotPaths 를 «상속하지 않는다» — 자기 것이 있으면 그것으로 덮는다', () => {
    const r = applyDecomposeProposals(
      [G('big', { hotPaths: ['src/parent.ts'] })],
      [R('big', [
        { id: 'p1', feature: 'part 1', dependsOn: [], hotPaths: ['src/a.ts'] } as never,
        { id: 'p2', feature: 'part 2', dependsOn: [] },
      ])],
    );
    expect(r.goals[0]!.hotPaths).toEqual(['src/a.ts']);
    // ⛔ 부모 것(`src/parent.ts`)이 «새어 오면» 두 조각이 서로 겹쳐 직렬화된다 — 그래서 «없어야» 한다.
    expect(r.goals[1]!.hotPaths).toBeUndefined();
  });

  test('조각이 «하나»인 제안은 무시한다', () => {
    const r = applyDecomposeProposals([G('big')], [R('big', [{ id: 'p1', feature: 'only', dependsOn: [] }])]);
    expect(r.decomposed).toEqual([]);
  });

  // ⭐ DECOMPOSE-PIECE-TARGET-LINE (10-11 부검 run-76941fca) — 조각이 골을 통째로 갈아 끼워
  //   첫 줄 «대상 경로:» 선언이 사라지면 Pod 예비 검사가 대상 경로 0 → 재저작 NOT-GROUNDED 로 exit 1 한다.
  //   ⇒ 조각은 머리줄 선언을 «좁혀서» 물려받는다(원 선언 경로 중 조각 문장에 나오는 것만 · 없으면 전부).
  describe('조각의 «대상 경로:» 머리줄 상속 (DECOMPOSE-PIECE-TARGET-LINE)', () => {
    test('pieces inherit a target-path first line narrowed to the paths they mention', () => {
      const parent = G('대상 경로: src/a.ts · src/b.ts\n보존 계약: 원장 형식은 그대로');
      const r = applyDecomposeProposals(
        [parent],
        [R('대상 경로: src/a.ts · src/b.ts\n보존 계약: 원장 형식은 그대로', [
          { id: 'p1', feature: 'In src/a.ts, add the parser guard', dependsOn: [] },
          { id: 'p2', feature: 'Wire the freeze hook into src/b.ts and src/a.ts', dependsOn: ['p1'] },
        ])],
      );
      expect(r.goals[0]!.feature).toBe('대상 경로: src/a.ts\nIn src/a.ts, add the parser guard');
      expect(r.goals[1]!.feature).toBe('대상 경로: src/a.ts · src/b.ts\nWire the freeze hook into src/b.ts and src/a.ts');
      expect(r.goals[0]!.feature.split('\n')[0]).toBe('대상 경로: src/a.ts');
      expect(r.goals[1]!.feature.split('\n')[0]).toBe('대상 경로: src/a.ts · src/b.ts');
    });

    test('a path prefix is not a mention of the declared file (target and new paths)', () => {
      const feature = '대상 경로: src/a.ts · src/a.tsx\n신설: src/new.ts · src/new.tsx';
      const r = applyDecomposeProposals(
        [G(feature)],
        [R(feature, [
          { id: 'p1', feature: 'Change src/a.tsx and add src/new.tsx', dependsOn: [] },
          { id: 'p2', feature: 'Change src/a.ts and add src/new.ts', dependsOn: [] },
          { id: 'p3', feature: 'Change nested/src/a.ts and add src/new.tsx', dependsOn: [] },
        ])],
      );
      expect(r.goals[0]!.feature).toBe('대상 경로: src/a.tsx\n신설: src/new.tsx\nChange src/a.tsx and add src/new.tsx');
      expect(r.goals[1]!.feature).toBe('대상 경로: src/a.ts\n신설: src/new.ts\nChange src/a.ts and add src/new.ts');
      expect(r.goals[2]!.feature).toBe('대상 경로: src/a.ts · src/a.tsx\n신설: src/new.tsx\nChange nested/src/a.ts and add src/new.tsx');
      expect(r.goals.map((g) => g.feature.split('\n')[0])).toEqual([
        '대상 경로: src/a.tsx',
        '대상 경로: src/a.ts',
        '대상 경로: src/a.ts · src/a.tsx',
      ]);
    });

    test('a piece that names no declared path inherits all declared paths', () => {
      const parent = G('대상 경로: src/one.ts · src/two.ts\n현재 계약: bun test → 0 fail');
      const r = applyDecomposeProposals(
        [parent],
        [R('대상 경로: src/one.ts · src/two.ts\n현재 계약: bun test → 0 fail', [
          { id: 'p1', feature: 'Refactor the shared types', dependsOn: [] },
          { id: 'p2', feature: 'Split the orchestration seam', dependsOn: [] },
        ])],
      );
      expect(r.goals[0]!.feature.split('\n')[0]).toBe('대상 경로: src/one.ts · src/two.ts');
      expect(r.goals[1]!.feature.split('\n')[0]).toBe('대상 경로: src/one.ts · src/two.ts');
    });

    test('a parent without a target-path line leaves pieces unchanged', () => {
      const r = applyDecomposeProposals(
        [G('그냥 골 문장\n신설: src/new.ts')],
        [R('그냥 골 문장\n신설: src/new.ts', [
          { id: 'p1', feature: 'part 1', dependsOn: [] },
          { id: 'p2', feature: 'part 2', dependsOn: [] },
        ])],
      );
      expect(r.goals.map((g) => g.feature)).toEqual(['part 1', 'part 2']);
      expect(r.goals.map((g) => g.feature.split('\n')[0])).toEqual(['part 1', 'part 2']);
    });

    test('«신설:» 줄도 같은 규칙으로 물려준다 — 조각이 언급한 새 파일만', () => {
      const parent = G('대상 경로: src/handler.ts\n신설: src/handler.test.ts · src/new-module.ts');
      const r = applyDecomposeProposals(
        [parent],
        [R('대상 경로: src/handler.ts\n신설: src/handler.test.ts · src/new-module.ts', [
          { id: 'p1', feature: 'Add the route in src/handler.ts', dependsOn: [] },
          { id: 'p2', feature: 'Cover it with src/handler.test.ts cases', dependsOn: ['p1'] },
        ])],
      );
      // p1 은 신설 경로를 «하나도» 언급 안 한다 → 규칙대로 원 신설 선언 «전부»를 물려받는다.
      expect(r.goals[0]!.feature).toBe('대상 경로: src/handler.ts\n신설: src/handler.test.ts · src/new-module.ts\nAdd the route in src/handler.ts');
      expect(r.goals[1]!.feature).toBe('대상 경로: src/handler.ts\n신설: src/handler.test.ts\nCover it with src/handler.test.ts cases');
    });
  });
});

describe('orderPiecesTopologically — 「의존 0」이 아니라 「DAG 인가」 (RUN-T82 · 2026-09-06)', () => {
  const Q = (id: string, dependsOn: string[] = [], hotPaths?: string[]) => ({
    id, feature: `feat ${id}`, dependsOn, ...(hotPaths ? { hotPaths } : {}),
  });

  // ⛔ 이 입력이 «옛 관문과 새 관문을 가르는» 입력이다 — 옛 관문은 의존이 하나라도 있으면 거부했다.
  test('⭐ 의존이 있는 조각을 «거부하지 않고» 순서를 바꿔 세운다', () => {
    const r = orderPiecesTopologically([Q('b', ['a']), Q('a'), Q('c', ['b'])]);
    expect(r.ordered?.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(r.dependsOnEdges).toBe(2);
    expect(r.hotPathEdges).toBe(0);
    expect(r.cycle).toBeUndefined();
  });

  test('hotPaths 가 겹치면 «앞선 조각 먼저»로 간선이 생긴다 (연합 경로의 기존 결정과 같은 규칙)', () => {
    const r = orderPiecesTopologically([Q('a', [], ['src/x.ts']), Q('b', [], ['src/x.ts'])]);
    expect(r.ordered?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(r.hotPathEdges).toBe(1);
    expect(r.dependsOnEdges).toBe(0);
  });

  test('hotPaths 가 «안 겹치면» 간선이 안 생긴다 — 「간선 0」은 결함이 아니라 독립이다', () => {
    const r = orderPiecesTopologically([Q('a', [], ['src/x.ts']), Q('b', [], ['src/y.ts'])]);
    expect(r.hotPathEdges).toBe(0);
    expect(r.ordered?.map((p) => p.id)).toEqual(['a', 'b']);
  });

  // ⛔⭐ 이것이 이 함수의 «가장 미끄러운» 자리다: 두 축이 방향을 다른 근거로 정한다.
  //   dependsOn 은 「b 가 a 뒤」, hotPaths 는 「배열 앞(b) 이 먼저」 ⇒ 순진하게 걸면 b→a ⊕ a→b = 가짜 순환.
  //   가드가 없으면 이 시험은 cycle 을 받아 «승격 전체가 막힌다»(= 옛 관문으로의 조용한 회귀).
  test('⭐⭐ dependsOn 과 hotPaths 가 «반대 방향»을 가리켜도 가짜 순환을 만들지 않는다', () => {
    const r = orderPiecesTopologically([Q('b', ['a'], ['src/x.ts']), Q('a', [], ['src/x.ts'])]);
    expect(r.cycle).toBeUndefined();
    expect(r.ordered?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(r.dependsOnEdges).toBe(1);
    expect(r.hotPathEdges).toBe(0);   // 반대 방향으로 이미 길이 있어 «건너뛴» 것이지 못 본 것이 아니다
  });

  test('진짜 순환은 «이름으로» 낸다 — ordered 는 undefined 이지 빈 배열이 아니다', () => {
    const r = orderPiecesTopologically([Q('a', ['b']), Q('b', ['a'])]);
    expect(r.ordered).toBeUndefined();
    expect(r.cycle?.sort()).toEqual(['a', 'b']);
  });

  test('매달린 dependsOn 은 «버리고 센다» — 승격 전체를 막지 않는다', () => {
    const r = orderPiecesTopologically([Q('a', ['nope']), Q('b')]);
    expect(r.ordered?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(r.danglingDependsOn).toBe(1);
    expect(r.dependsOnEdges).toBe(0);
  });

  test('같은 입력이면 같은 출력 — 동률은 «원래 순서»로 깬다', () => {
    const pieces = [Q('z'), Q('y'), Q('x')];
    expect(orderPiecesTopologically(pieces).ordered?.map((p) => p.id)).toEqual(['z', 'y', 'x']);
  });
});
