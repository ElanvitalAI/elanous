// P2b P-a′ — 소유권 상실 판정 seam. 종전 boolean 이 {상실}∪{확인 불가} 를 뭉치던 것을 3-값으로 가른다.
import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { classifyControlStance, probeControlStance, reportProbeError, stanceBlocksWrite } from './pty-control-stance.js';

describe('classifyControlStance (순수 매핑)', () => {
  test('조회 성공 — 소유하면 owned · 아니면 lost', () => {
    expect(classifyControlStance({ ok: true, owned: true })).toBe('owned');
    expect(classifyControlStance({ ok: true, owned: false })).toBe('lost');
  });

  test('⭐ 조회 실패는 lost 가 아니라 unknown — 이 구분이 이 seam 의 존재 이유다', () => {
    // 뭉쳐 두면 뒤에 올 `defer` 가 "뺏은 사람이 없는데 돌려주기를 기다리는" 영구 대기에 빠지고,
    // 통보축이 붙으면 "사람이 뺏었다" 는 거짓 사실까지 발행한다.
    // ⊕ 실패 variant 는 `{ok:false}` 뿐이다 — 원인은 `onProbeError` 가 원본 그대로 받으므로
    //   probe 에 복제해 두지 않는다(읽는 곳이 없으면 dead field 다).
    expect(classifyControlStance({ ok: false })).toBe('unknown');
  });
});

describe('stanceBlocksWrite (무회귀 경계)', () => {
  test('owned 만 통과 — 종전 `!canWrite(actor)` 와 1:1 동치', () => {
    expect(stanceBlocksWrite('owned')).toBe(false);
    expect(stanceBlocksWrite('lost')).toBe(true);
    expect(stanceBlocksWrite('unknown')).toBe(true);   // ⚠️ fail-closed 유지 — 확인 불가는 쓰지 않는다
  });
});

describe('probeControlStance (I/O 어댑터)', () => {
  test('handle 에 물어본 결과를 3-값으로 옮긴다', () => {
    expect(probeControlStance({ canWrite: () => true })).toBe('owned');
    expect(probeControlStance({ canWrite: () => false })).toBe('lost');
  });

  test('기본 actor 는 agent — 자율 소유 판정이 이 seam 의 용도다', () => {
    const seen: string[] = [];
    probeControlStance({ canWrite: (a) => { seen.push(a); return true; } });
    probeControlStance({ canWrite: (a) => { seen.push(a); return true; } }, 'human');
    expect(seen).toEqual(['agent', 'human']);
  });

  test('⭐ 예외를 삼켜 unknown 으로 접는다 — throw 가 호출부로 새지 않는다(종전 safeHasControl 규율)', () => {
    const errors: unknown[] = [];
    const stance = probeControlStance(
      { canWrite: () => { throw new Error('registry gone'); } },
      'agent',
      (e) => errors.push(e),
    );
    expect(stance).toBe('unknown');
    expect(stanceBlocksWrite(stance)).toBe(true);          // 미확인 상태에서 write 허용 금지
    expect((errors[0] as Error).message).toBe('registry gone');
  });

  test('관측 훅이 없어도 예외가 새지 않는다(훅은 선택)', () => {
    expect(() => probeControlStance({ canWrite: () => { throw new Error('x'); } })).not.toThrow();
    expect(probeControlStance({ canWrite: () => { throw new Error('x'); } })).toBe('unknown');
  });
});

// ⭐ 회귀 가드 — seam 을 만들어도 **새 코드가 다시 각자 판정하면** 원래 결함이 돌아온다(RFC §1a).
//    "판정은 한 곳" 을 구조로 고정한다. 이 목록은 RFC §1a 의 A·B·C 세 소비자다.
//    ⚠️ 초판은 정확한 문자열 `canWrite('agent')` 만 막아 **쌍따옴표·공백·actor 변수**를 놓쳤고,
//    seam 사용도 *import 만으로* 통과했다(Goodhart). 아래는 그 셋을 다 막는다.
//    ⊕ **주 회귀 가드는 위의 행위 테스트**(네 경로에서 stance·원인이 관측에 남는지)다. 이 소스 가드는
//      *"새 코드가 다시 각자 판정하는 것"*(RFC §1a 의 재발 형태)만 막는 보조다 — 세 파일에 소유권과
//      무관한 `.canWrite()` 가 정당하게 필요해지면 **이 가드가 아니라 그 사용을 검토**한다.
describe('세 소비자가 소유권을 직접 판정하지 않는다 (구조 가드)', () => {
  const CONSUMERS = [
    'src/agent-mission/driver.ts',                      // A
    'src/autopilot/pty-control-loop.ts',                // B
    'src/self-implement/headless-elanous-driver.ts',      // C
  ];

  /** 주석·문자열 설명은 뺀 실행 코드만. 설명문에 심볼 이름이 나오는 것은 정상이다. */
  function executableCode(source: string): string {
    return source
      .split('\n')
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  }

  test.each(CONSUMERS)('%s — `.canWrite(` 호출이 아예 없다(actor 무관)', async (path) => {
    const code = executableCode(await Bun.file(path).text());
    // ⚠️ actor 리터럴을 보지 않는다 — `canWrite("agent")`·`canWrite( 'agent' )`·`canWrite(actor)` 를
    //   전부 잡으려면 **호출 자체**를 금지하는 게 유일하게 견고하다.
    expect(code).not.toMatch(/\.canWrite\s*\(/);
  });

  test.each(CONSUMERS)('%s — probe 에 **관측 훅을 넘긴다**(원인 유실 방지)', async (path) => {
    // #21723 added ownership checks in the mission/PTY consumers. Inspect real calls rather than
    // splitting source at the first nested `)` (e.g. canWrite() inside the first argument).
    const source = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'probeControlStance') {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.arguments).toHaveLength(3); // target, actor, observation hook
      const hook = call.arguments[2];
      expect(hook && (ts.isArrowFunction(hook) || (ts.isIdentifier(hook) && hook.text === 'onProbeError'))).toBe(true);
    }
  });

  test.each(CONSUMERS)('%s — seam 을 import 만 하지 않고 실제로 호출한다', async (path) => {
    const code = executableCode(await Bun.file(path).text());
    const imports = code.split('\n').filter((l) => l.trimStart().startsWith('import')).join('\n');
    const body = code.split('\n').filter((l) => !l.trimStart().startsWith('import')).join('\n');
    expect(imports).toContain('pty-control-stance');
    // import 줄을 제외한 본문에서 **호출 형태**로 나타나야 한다(이름만 스치는 것으로는 통과 못 한다).
    expect(body).toMatch(/probeControlStance\s*\(/);
  });

  test('⚠️ 3-인자 가드는 중첩 괄호를 통과하고 훅 없는 호출은 잡는다', () => {
    const calls = (code: string): ts.CallExpression[] => {
      const source = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true);
      const found: ts.CallExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'probeControlStance') found.push(node);
        ts.forEachChild(node, visit);
      };
      visit(source);
      return found;
    };
    expect(calls("probeControlStance({ canWrite: () => hasControl() }, 'agent', onProbeError)")[0]?.arguments).toHaveLength(3);
    expect(calls("probeControlStance(handle, 'agent')")[0]?.arguments).toHaveLength(2);
  });

  test('⚠️ 가드 자신이 도는지 — 위반 코드를 넣으면 실제로 잡힌다', () => {
    const violating = "const ok = h.canWrite('agent');";
    expect(violating).toMatch(/\.canWrite\s*\(/);
    expect('const ok = h.canWrite("agent");').toMatch(/\.canWrite\s*\(/);
    expect('const ok = h.canWrite( actor );').toMatch(/\.canWrite\s*\(/);
    // seam 호출이 없는 코드는 두 번째 단언에 걸린다
    expect("import { probeControlStance } from 'x';").not.toMatch(/probeControlStance\s*\(/);
  });
});

// ⭐ 이중 probe 회귀 — `controlStance` 를 boolean 으로 접은 뒤 다시 probe 하면 조회 실패가 `lost` 로
//   **오분류**된다(리뷰 must-fix 로 잡힌 실제 결함).
//   ⚠️ 초판 테스트는 `cancelled` 만 봤는데 그건 **오분류해도 통과**한다(Goodhart · 리뷰가 잡았다).
//   ⇒ 관측 레코드의 `stance` 와 **probe 호출 횟수**를 직접 본다.
describe('루프가 unknown 을 lost 로 접지 않는다 (이중 probe 회귀)', () => {
  async function captureYield(deps: Record<string, unknown>): Promise<{
    logs: Record<string, unknown>[]; termination: string;
  }> {
    const { debug } = await import('../debug/log.js');
    const { runPtyControlLoop } = await import('../autopilot/pty-control-loop.js');
    const logs: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'stance-test-capture',
      emit: (rec) => { if (rec.category === 'autopilot.control' && rec.event === 'yield') logs.push({ ...(rec.data as object) }); },
    });
    try {
      const r = await runPtyControlLoop(
        { decide: () => ({ action: 'wait' as const }) },
        { observe: () => 'screen', inject: () => true, sleep: async () => {}, ...deps } as never,
        { maxSteps: 2 },
      );
      return { logs, termination: r.termination.kind };
    } finally { off(); }
  }

  test('⭐ 조회 실패는 관측에 `stance:"unknown"` 으로 남는다 — `lost` 로 접히면 이 단언이 깨진다', async () => {
    const { logs, termination } = await captureYield({ controlStance: () => { throw new Error('registry gone'); } });
    expect(termination).toBe('cancelled');                  // 집행은 종전과 같다(fail-closed 무회귀)
    expect(logs.length).toBeGreaterThan(0);                 // 관측이 실제로 남았는지 먼저 확인
    expect(logs[0]!.stance).toBe('unknown');                // ⚠️ 여기가 오분류를 잡는 단언
  });

  test('확인된 상실은 `stance:"lost"` — 둘이 관측에서 갈린다', async () => {
    const { logs } = await captureYield({ controlStance: () => 'lost' as const });
    expect(logs[0]!.stance).toBe('lost');
  });

  test('⭐ 실 어댑터 경유에서도 unknown 이 보존된다 — 접힘 지점이 없다', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    let probes = 0;
    const handle = {
      canWrite: () => { probes += 1; throw new Error('boom'); },
      renderScreen: () => 'x', isAlive: () => true, write: () => {},
    } as never;
    const deps = controlDepsForHandle(handle);
    expect('hasControl' in deps).toBe(false);               // boolean 창구가 아예 없다
    expect(deps.controlStance?.()).toBe('unknown');
    expect(probes).toBe(1);                                 // ⚠️ 이중 probe 면 2 가 된다
    const { logs } = await captureYield({ controlStance: deps.controlStance });
    expect(logs[0]!.stance).toBe('unknown');                // 어댑터→루프 전 구간 보존
  });
});

// SF 반영 — 구조화 필드와 설명문이 어긋나면 진단이 엉뚱한 곳을 판다.
describe('yield 사유가 stance 와 모순되지 않는다', () => {
  test('unknown 은 "사람 takeover" 라 단정하지 않는다', async () => {
    const { debug } = await import('../debug/log.js');
    const { runPtyControlLoop } = await import('../autopilot/pty-control-loop.js');
    const rows: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'stance-reason-capture',
      emit: (rec) => { if (rec.event === 'yield') rows.push({ ...(rec.data as object) }); },
    });
    try {
      for (const stance of ['unknown', 'lost'] as const) {
        await runPtyControlLoop(
          { decide: () => ({ action: 'wait' as const }) },
          { observe: () => 'screen', inject: () => true, sleep: async () => {}, controlStance: () => stance } as never,
          { maxSteps: 1 },
        );
      }
    } finally { off(); }
    const unknownRow = rows.find((r) => r.stance === 'unknown');
    const lostRow = rows.find((r) => r.stance === 'lost');
    // ⚠️ 단어 'takeover' 자체를 금지하면 안 된다 — unknown 사유는 *"takeover 여부를 단정할 수 없다"* 라
    //   그 단어를 정당하게 쓴다. 금지할 것은 **단정하는 형태**(`사람 takeover`)다.
    expect(String(unknownRow?.reason)).not.toContain('사람 takeover');
    expect(String(unknownRow?.reason)).toContain('unverifiable');
    expect(String(lostRow?.reason)).toContain('사람 takeover');      // 확인된 상실은 그대로 단정
  });
});

// ⚠️ 위 테스트들은 전부 **스텝 최초 게이트**에서 끝나 watcher·inject 경로를 안 태운다(리뷰 must-fix).
//    두 경로를 실제로 실행시켜 stance 가 거기서도 살아남는지 본다.
describe('watcher·inject 경로에서도 unknown 이 보존된다', () => {
  async function capture(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const { debug } = await import('../debug/log.js');
    const rows: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'stance-path-capture',
      emit: (rec) => { if (rec.category === 'autopilot.control') rows.push({ event: rec.event, ...(rec.data as object) }); },
    });
    try { await fn(); } finally { off(); }
    return rows;
  }

  test('⭐ decide 중 watcher 가 잡은 stance 가 그대로 관측에 실린다', async () => {
    const { runPtyControlLoop } = await import('../autopilot/pty-control-loop.js');
    let calls = 0;
    const rows = await capture(() => runPtyControlLoop(
      // decide 가 느려야 watcher(250ms 틱)가 뜬다. 첫 게이트는 통과시키고 그 뒤에 상실시킨다.
      { decide: () => new Promise((r) => setTimeout(() => r({ action: 'wait' as const }), 900)) },
      {
        observe: () => 'screen', inject: () => true, sleep: async () => {},
        controlStance: () => { calls += 1; return calls === 1 ? 'owned' : 'unknown'; },
      } as never,
      { maxSteps: 1 },
    ));
    const yields = rows.filter((r) => r.event === 'yield');
    expect(yields.length).toBeGreaterThan(0);
    expect(yields[0]!.stance).toBe('unknown');                       // watcher 가 보존했다
    expect(String(yields[0]!.reason)).toContain('during-decide');    // 어느 지점인지도 남는다
    expect(String(yields[0]!.reason)).not.toContain('사람 takeover'); // unknown 을 단정하지 않는다
  }, 10_000);

  test('⭐ inject 시점 조회 실패도 관측에 남는다 — 종전엔 lost 와 같은 false 였고 로그가 없었다', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    let probes = 0;
    const deps = controlDepsForHandle({
      id: 'pty_test', renderScreen: () => 'x', isAlive: () => true, write: () => {},
      canWrite: () => { probes += 1; throw new Error('registry gone'); },
    } as never);
    const rows = await capture(async () => { expect(deps.inject!('hello')).toBe(false); });
    expect(probes).toBe(1);
    expect(rows.some((r) => r.event === 'hascontrol-error' && r.at === 'inject')).toBe(true);
    const blocked = rows.find((r) => r.event === 'inject-blocked');
    expect(blocked?.stance).toBe('unknown');   // ⚠️ 접혔다면 여기서 lost 이거나 로그 자체가 없다
  });

  test('키·마우스·크기 조절 조회 오류도 쓰기 차단과 관측을 함께 유지한다', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    const writes: string[] = [];
    const deps = controlDepsForHandle({
      id: 'pty_error', renderScreen: () => 'x', isAlive: () => true,
      write: (text: string) => writes.push(text), resize: () => writes.push('resize'),
      canWrite: () => { throw new Error('registry gone'); },
    } as never);
    const rows = await capture(async () => {
      expect(deps.injectKey!('Enter')).toBe(false);
      expect(deps.injectMouse!({ button: 0, col: 1, row: 1, kind: 'press' } as never)).toBe(false);
      expect(deps.resize!(80, 24)).toBe(false);
    });
    expect(writes).toEqual([]);
    expect(rows.filter((r) => r.event === 'hascontrol-error').map((r) => r.at)).toEqual([
      'inject-key', 'inject-mouse', 'resize',
    ]);
    expect(rows.filter((r) => r.event === 'hascontrol-error').every((r) => r.error === 'registry gone' && r.ptyId === 'pty_error')).toBe(true);
  });

  test('inject 가 확인된 상실이면 lost 로 남고 write 는 안 불린다', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    const writes: string[] = [];
    const deps = controlDepsForHandle({
      id: 'pty_test', renderScreen: () => 'x', isAlive: () => true,
      write: (t: string) => writes.push(t), canWrite: () => false,
    } as never);
    const rows = await capture(async () => { expect(deps.inject!('hello')).toBe(false); });
    expect(rows.find((r) => r.event === 'inject-blocked')?.stance).toBe('lost');
    expect(writes).toEqual([]);
  });
});

// MF3 — post-decide 경로(결정 직후 재검사)와 어댑터 오류 관측은 위 케이스가 안 태운다.
describe('post-decide 경로 · 어댑터 오류 관측', () => {
  async function rows(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const { debug } = await import('../debug/log.js');
    const out: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'stance-post-capture',
      emit: (rec) => { if (rec.category === 'autopilot.control') out.push({ event: rec.event, ...(rec.data as object) }); },
    });
    try { await fn(); } finally { off(); }
    return out;
  }

  test('⭐ 결정 직후 재검사에서 잡힌 unknown 이 `post-decide` 로 남는다', async () => {
    const { runPtyControlLoop } = await import('../autopilot/pty-control-loop.js');
    let n = 0;
    // 스텝 게이트(1회)·watcher(즉시 resolve 라 안 뜸) 통과 후 post-decide(2회차)에서 상실시킨다.
    const out = await rows(() => runPtyControlLoop(
      { decide: () => ({ action: 'wait' as const }) },
      {
        observe: () => 'screen', inject: () => true, sleep: async () => {},
        controlStance: () => { n += 1; return n === 1 ? 'owned' : 'unknown'; },
      } as never,
      { maxSteps: 1 },
    ));
    const y = out.find((r) => r.event === 'yield');
    expect(y?.stance).toBe('unknown');
    expect(String(y?.reason)).toContain('post-decide');           // ⚠️ 어느 지점인지 남는다
    expect(String(y?.reason)).not.toContain('사람 takeover');
  });

  test('⭐ 실 어댑터의 stance 조회 실패가 `hascontrol-error{at:"stance"}` 로 남는다', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    const deps = controlDepsForHandle({
      id: 'pty_x', renderScreen: () => 'x', isAlive: () => true, write: () => {},
      canWrite: () => { throw new Error('registry gone'); },
    } as never);
    const out = await rows(async () => { expect(deps.controlStance!()).toBe('unknown'); });
    const err = out.find((r) => r.event === 'hascontrol-error' && r.at === 'stance');
    expect(err).toBeDefined();          // ⚠️ 훅을 안 넘기면 stance 는 unknown 인데 **원인이 사라진다**
    expect(err?.error).toBe('registry gone');
    expect(err?.ptyId).toBe('pty_x');
  });

  test('non-Error throw 도 unknown 이고 관측에 문자열로 남는다(SF)', async () => {
    const { controlDepsForHandle } = await import('../autopilot/pty-control-loop.js');
    const deps = controlDepsForHandle({
      id: 'pty_y', renderScreen: () => 'x', isAlive: () => true, write: () => {},
      canWrite: () => { throw 'plain string throw'; },
    } as never);
    const out = await rows(async () => { expect(deps.controlStance!()).toBe('unknown'); });
    expect(out.find((r) => r.event === 'hascontrol-error')?.error).toBe('plain string throw');
  });
});

// MF — 관측 훅이 판정을 바꾸면 안 된다. non-Error throw 에서 훅 자신이 던지면 fail-closed(`cancelled`)가
//      `error` 종료로 **회귀**한다. `hasControl` 폴백 경로(주입 boolean)를 태워 고정한다.
describe('관측 훅이 판정을 바꾸지 않는다 (non-Error throw)', () => {
  test.each([
    ['문자열', () => { throw 'plain string'; }, 'plain string'],
    ['null', () => { throw null; }, 'null'],
    ['undefined', () => { throw undefined; }, 'undefined'],
  ])('%s throw → cancelled 유지 ⊕ 원인이 관측에 남는다', async (_label, thrower, expected) => {
    const { debug } = await import('../debug/log.js');
    const { runPtyControlLoop } = await import('../autopilot/pty-control-loop.js');
    const out: Record<string, unknown>[] = [];
    const off = debug.registerSink({
      name: 'stance-nonerror-capture',
      emit: (rec) => { if (rec.category === 'autopilot.control') out.push({ event: rec.event, ...(rec.data as object) }); },
    });
    let r: Awaited<ReturnType<typeof runPtyControlLoop>>;
    try {
      r = await runPtyControlLoop(
        { decide: () => ({ action: 'wait' as const }) },
        { observe: () => 'screen', inject: () => true, sleep: async () => {}, hasControl: thrower } as never,
        { maxSteps: 1 },
      );
    } finally { off(); }
    expect(r!.termination.kind).toBe('cancelled');   // ⚠️ 'error' 면 fail-closed 가 무너진 것이다
    expect(out.find((x) => x.event === 'hascontrol-error')?.error).toBe(expected);
  });
});

// MF — 관측 훅 자신이 던져도 판정이 깨지면 안 된다(훅은 관측이지 판정이 아니다).
describe('onProbeError 예외는 판정을 깨지 않는다', () => {
  test('reportProbeError — 훅이 던져도 삼킨다(격리의 단일 정의)', () => {
    expect(() => reportProbeError(() => { throw new Error('sink exploded'); }, new Error('probe fail'))).not.toThrow();
    expect(() => reportProbeError(undefined, new Error('probe fail'))).not.toThrow();
    const seen: unknown[] = [];
    reportProbeError((e) => seen.push(e), 'raw cause');
    expect(seen).toEqual(['raw cause']);   // 원인은 **원본 그대로** 넘어간다(probe 에 복제하지 않는 이유)
  });

  test('훅이 던져도 unknown 을 돌려주고 예외가 밖으로 안 나간다', () => {
    let stance: string | undefined;
    expect(() => {
      stance = probeControlStance(
        { canWrite: () => { throw new Error('probe fail'); } },
        'agent',
        () => { throw new Error('sink exploded'); },
      );
    }).not.toThrow();
    expect(stance).toBe('unknown');
  });
});
