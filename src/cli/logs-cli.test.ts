/**
 * elanous logs CLI — 파서/포맷 계약 (통합 로그 패브릭 LF3 · 2026-07-13).
 * DB/네트워크 미접촉 — 순수 함수만.
 */
import { setDefaultTimeout, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import * as nodeOs from 'node:os';
import { join } from 'node:path';

import {
  aggregateListEvents, buildQuery, collectObservedEventNames, effectiveLogLimit, eventCategoryWarning, eventNameDistance, eventNameHint, eventNameVerdict, EVENT_NAME_HINT_SHOWN, EVENT_NAME_HINT_WINDOW_MS, formatLogInstance, formatLogLine, formatRemoteLogLine, grepPhraseWarning, isNameLikeEvent, limitReachedHint, limitReachedJsonMeta, limitReachedStderrSignal, matchesReworkRecurrenceDisagreement, multiSurfaceDuplicateJsonMeta, otherInstanceHint, otherInstanceMajorityWarning, rankNearbyEventNames, renderLogJsonLine, renderRemoteLogJsonLine,
  probeOtherInstanceMatches, quoteShellArg, resolveLogTargets, resolveLogsRemoteFlag, renderAxisExplanation, renderLogAxisDiscovery, runCoverageHint, UNCLASSIFIED_PREVIEW, renderGatedHint, runLogsCli, nonCurrentScopeNames, zeroResultFilterRelaxationWarning, type LogTarget,
  liveFetchRemoteLogs, podObservationGapNotice,
  runLogsLevel,
} from './logs-cli.js';
import { LogStore, type LogQuery, type LogStoreRow } from '../mss/logging/log-store.js';
import type { LogInstanceView } from '../mss/logging/instance-registry.js';
import { RemotesStore } from './remotes.js';
import { setElanousConfigDir, getElanousConfigDirOverride, resetElanousConfigDir } from '../elanous-config-dir.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';
import { program } from '../index.js';
import { HARNESS_SPACE_KINDS } from '../harness/harness-space.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

describe('logs --top-failures', () => {
  it('uses the selected store and time window; default mode still renders individual lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-top-failures-'));
    const dbPath = join(dir, 'logs.db');
    const store = new LogStore(dbPath, { instance: 'test:top' });
    const now = Date.now();
    try {
      store.insertBatch([
        ...Array.from({ length: 25 }, (_, i) => ({
          surface: 'pwa', rec: { ts: new Date(now - 60_000 + i * 100).toISOString(), category: 'webterm.acp.close',
            event: 'close', data: { reason: 'socket closed: 1008: auth_failed', sessionId: `session-${i}` } },
        })),
        { surface: 'pwa', rec: { ts: new Date(now - 7200_000).toISOString(), category: 'webterm.acp.close',
          event: 'close', data: { reason: 'socket closed: 1008: auth_failed' } } },
      ]);
      const targets = () => ({ targets: [{ name: 'test:top', dbPath }] });
      const lines: string[] = [];
      const output: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
      const stdoutWrite = process.stdout.write;
      try {
        process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
          output.push(String(chunk));
          callback?.();
          return true;
        }) as typeof process.stdout.write;
        expect(await runLogsCli({ topFailures: true, since: '10m', threshold: '20', json: true }, { resolveTargets: targets })).toBe(0);
        const groups = JSON.parse(lines.join('\n')).groups;
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ area: 'webterm.acp', count: 25 });
        expect(groups[0].explanation).toContain('소유자 토큰');
        lines.length = 0;
        expect(await runLogsCli({ topFailures: true, since: '10m', threshold: '20' }, { resolveTargets: targets })).toBe(0);
        expect(lines.join('\n')).toContain('25  webterm.acp  socket closed: #: auth_failed');
        expect(lines.join('\n')).toContain('소유자 토큰');
        lines.length = 0;
        expect(await runLogsCli({ topFailures: true, since: '10m', category: 'unrelated', threshold: '20', json: true }, { resolveTargets: targets })).toBe(0);
        expect(JSON.parse(lines.join('\n')).groups).toEqual([]);
        lines.length = 0;
        expect(await runLogsCli({ since: '10m', limit: '1' }, { resolveTargets: targets })).toBe(0);
        expect(lines.join('\n')).toContain('--before 25');
        expect(output.join('')).toContain('webterm.acp.close close');
        expect(output.join('')).not.toContain('개수  영역  사유');
      } finally { process.stdout.write = stdoutWrite; spy.mockRestore(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('aggregates a large window without treating a healthy store as unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-top-failures-large-'));
    const dbPath = join(dir, 'logs.db');
    const store = new LogStore(dbPath, { instance: 'test:large' });
    const now = Date.now();
    try {
      for (let batch = 0; batch < 7; batch++) {
        store.insertBatch(Array.from({ length: 20_000 }, (_, i) => ({
          surface: 'pwa', rec: { ts: new Date(now - 30_000 + batch * 100 + i % 100).toISOString(),
            category: 'webterm.acp.close', event: 'close', data: { reason: 'socket closed: 1008: auth_failed' } },
        })));
      }
      const lines: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
      try {
        expect(await runLogsCli({ topFailures: true, since: '10m', json: true },
          { resolveTargets: () => ({ targets: [{ name: 'test:large', dbPath }] }) })).toBe(0);
        const result = JSON.parse(lines.join('\n'));
        expect(result.unreadable).toEqual([]);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].count).toBe(140_000);
      } finally { spy.mockRestore(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects invalid thresholds and follow without opening a store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-top-failures-invalid-'));
    const dbPath = join(dir, 'logs.db');
    try {
      new LogStore(dbPath).close();
      const targets = () => ({ targets: [{ name: 'fixture', dbPath }] });
      const errors: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
      try {
        expect(await runLogsCli({ topFailures: true, threshold: '0' }, { resolveTargets: targets })).toBe(1);
        expect(errors.join('\n')).toContain('--threshold');
        errors.length = 0;
        expect(await runLogsCli({ topFailures: true, follow: true }, { resolveTargets: targets })).toBe(1);
        expect(errors.join('\n')).toContain('--follow');
      } finally { spy.mockRestore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('0건 이벤트 이름 안내 — 이미 찍힌 기록에서만', () => {
  it('이름 모양 규칙은 토큰은 남기고 주소·식별자·문장은 버린다', () => {
    expect(isNameLikeEvent('plan-sizing')).toBeTrue();
    expect(isNameLikeEvent('lifecycle.bridge-attached')).toBeTrue();
    expect(isNameLikeEvent('headless.progress')).toBeTrue();
    expect(isNameLikeEvent('https://example.com/path')).toBeFalse();
    expect(isNameLikeEvent('/tmp/logs.db')).toBeFalse();
    expect(isNameLikeEvent('this is a sentence')).toBeFalse();
    expect(isNameLikeEvent('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeFalse();
    expect(isNameLikeEvent('deadbeefdeadbeefdeadbeefdeadbeef')).toBeFalse();
  });

  it('가까운 이름은 Levenshtein 거리순이고 상한을 넘기지 않는다', () => {
    expect(eventNameDistance('plan-sizin', 'plan-sizing')).toBe(1);
    const nearby = rankNearbyEventNames(
      ['plan-sizin'],
      ['plan-sizing', 'plan', 'https://example.com', 'zzzz-unrelated', 'ledger', 'decomposed', 'adversarial-sound', 'this is a sentence'],
    );
    expect(nearby[0]).toBe('plan-sizing');
    expect(nearby).toHaveLength(EVENT_NAME_HINT_SHOWN);
    expect(nearby).not.toContain('https://example.com');
    expect(nearby).not.toContain('this is a sentence');
  });

  it('후보가 있으면 범위 내 미관측과 가까운 관측 이름을 말하고 저장소 부재를 단정하지 않는다', () => {
    const hint = eventNameHint(['plan-sizin'], ['plan-sizing', 'ledger']);
    expect(hint).toContain('이 조회 범위에서 본 적 없다');
    expect(hint).toContain("'plan-sizing'");
    expect(hint).not.toContain('이 저장소에 없다');
    expect(hint).not.toContain('없는 이름');
  });

  it('후보가 없으면 안내 불가를 명시하고 빈 목록만 남기지 않는다', () => {
    expect(eventNameHint(['zzz-no-such-event-xyz'], [])).toBe(
      "안내: 이벤트 이름 'zzz-no-such-event-xyz' 은(는) 이 조회 범위에서 본 적 없다. 가까운 관측 이름을 안내할 수 없다.",
    );
    expect(eventNameHint(['zzz-no-such-event-xyz'], ['https://example.com', 'this is a sentence']))
      .toContain('가까운 관측 이름을 안내할 수 없다');
  });

  it('후보 수집은 사용자 since가 아니라 고정 24시간 창을 쓰고 events 축은 뺀다', () => {
    const calls: Array<Record<string, unknown>> = [];
    const nowMs = Date.UTC(2026, 7, 27, 12, 0, 0);
    const names = collectObservedEventNames([{
      events: (q) => {
        calls.push(q as Record<string, unknown>);
        return ['plan-sizing'];
      },
    }], { events: ['plan-sizin'], sinceMs: nowMs - 5 * 60_000, minLevel: 'warn' }, nowMs);
    expect(names).toEqual(['plan-sizing']);
    expect(calls).toEqual([{
      minLevel: 'warn',
      sinceMs: nowMs - EVENT_NAME_HINT_WINDOW_MS,
      untilMs: nowMs,
    }]);
    expect(calls[0]).not.toHaveProperty('events');
  });

  it('스토어 실패는 fail-soft로 빈 후보가 되고 안내 불가로 읽힌다', () => {
    const names = collectObservedEventNames([{
      events: () => { throw new Error('unreadable'); },
    }], { events: ['absent'] });
    expect(names).toEqual([]);
    expect(eventNameHint(['absent'], names)).toContain('가까운 관측 이름을 안내할 수 없다');
  });
});

describe('eventNameVerdict — 정적 목록은 하한이지 완전한 부재 증거가 아니다', () => {
  it('목록에 있는 이름은 이 저장소가 낸다고 말하고 조회 범위 부재만 가른다', () => {
    const verdict = eventNameVerdict('plan-sizing');
    expect(verdict).toContain('이 저장소가 냅니다');
    expect(verdict).toContain("'plan-sizing'");
    expect(verdict).not.toContain('내지 않');
  });

  it('목록에 없는 이름은 정적 목록 부재와 한계만 말하고 내지 않는다고 단정하지 않는다', () => {
    const verdict = eventNameVerdict('zzz-no-such-event-xyz');
    expect(verdict).toContain('정적');
    expect(verdict).toContain('못 봅니다');
    expect(verdict).not.toContain('내지 않');
    expect(verdict).not.toContain('내지 않는');
  });

  it('쉼표가 든 값과 빈 값은 이름을 하나로 특정하지 못해 null 이다', () => {
    expect(eventNameVerdict('plan-sizing,ledger')).toBeNull();
    expect(eventNameVerdict('')).toBeNull();
    expect(eventNameVerdict(undefined)).toBeNull();
    expect(eventNameVerdict('  ,  ')).toBeNull();
    expect(eventNameVerdict('plan-sizing,')).toBeNull();
    expect(eventNameVerdict(',plan-sizing')).toBeNull();
    expect(eventNameVerdict('plan-sizing,,other')).toBeNull();
    expect(eventNameVerdict('plan-sizing, ,ledger')).toBeNull();
    expect(eventNameVerdict(',')).toBeNull();
    expect(eventNameVerdict(',,')).toBeNull();
  });

  it('유효한 단일 이름은 판정하고 쉼표·빈 토큰 입력만 안내하지 않는다', () => {
    expect(eventNameVerdict('plan-sizing')).toContain('이 저장소가 냅니다');
    expect(eventNameVerdict('plan-sizing,')).toBeNull();
    expect(eventNameVerdict(',plan-sizing')).toBeNull();
    expect(eventNameVerdict('plan-sizing,,other')).toBeNull();
    expect(eventNameVerdict('plan-sizing, ,ledger')).toBeNull();
  });

  it('목록 머리말은 하한이며 못 보는 producer 가 있음을 말한다', () => {
    const header = readFileSync(join(import.meta.dir, 'log-event-names.ts'), 'utf8').slice(0, 600);
    expect(header).toContain('lower bound');
    expect(header).toMatch(/aliases|wrappers|dynamic producers/);
    expect(header).toContain('not a complete producer inventory');
  });
});

describe('0건 필터 완화 진단', () => {
  it('걸린 축만 하나씩 빼서 비대칭 건수를 나란히 보이고, 각 축을 한 번만 센다', () => {
    const calls: LogQuery[] = [];
    const warning = zeroResultFilterRelaxationWarning(
      { categories: ['present'], events: ['absent'] },
      (candidate) => {
        calls.push(candidate);
        return candidate.events === undefined ? 7 : 0;
      },
    );

    expect(warning).toBe('안내: 적용 필터를 하나씩 제외한 일치 수: --category 제외 0건 · --event 제외 7건.');
    expect(calls).toEqual([
      { events: ['absent'] },
      { categories: ['present'] },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.some((candidate) => candidate.events === undefined)).toBeTrue();
  });

  it('--surface와 --space를 실제 구성대로 독립 축으로 세고 space의 파생 grep을 함께 뺀다', () => {
    const { query } = buildQuery({ surface: 'nexus', space: 'run-123' });
    const calls: LogQuery[] = [];
    const warning = zeroResultFilterRelaxationWarning(query, (candidate) => {
      calls.push(candidate);
      return candidate.surfaces === undefined && candidate.grep === undefined ? 5 : 0;
    }, { surface: 'nexus', space: 'run-123' });

    // --space wins during query construction, so only the applied space axis is counted.
    expect(warning).toBe('안내: 적용 필터를 하나씩 제외한 일치 수: --space 제외 5건.');
    expect(calls).toEqual([{ surfaces: undefined, grep: undefined }]);
  });

  it('--surface 단독은 한 번만 재질의하고 --space를 중복 안내하지 않는다', () => {
    const { query } = buildQuery({ surface: 'nexus' });
    const calls: LogQuery[] = [];
    const warning = zeroResultFilterRelaxationWarning(query, (candidate) => {
      calls.push(candidate);
      return 3;
    }, { surface: 'nexus' });

    expect(warning).toBe('안내: 적용 필터를 하나씩 제외한 일치 수: --surface 제외 3건.');
    expect(calls).toEqual([{ surfaces: undefined }]);
  });

  it('무필터 0건은 뺄 축이 없음을 명시하고 세지 않는다', () => {
    let calls = 0;
    expect(zeroResultFilterRelaxationWarning({}, () => { calls += 1; return 1; }))
      .toBe('안내: 적용된 필터가 없어 뺄 축이 없습니다.');
    expect(calls).toBe(0);
  });
});

describe('log axes — read-side exact category expansion', () => {
  it('dev 축은 다섯 카테고리를 exactCategories로 펼치고 기존 category는 보존한다', () => {
    const { query, error } = buildQuery({ axis: 'dev', category: 'dev-pipeline' });
    expect(error).toBeUndefined();
    expect(query.categories).toEqual(['dev-pipeline']);
    // ⛔ 상수를 기대값으로 재사용하면 **원소가 빠져도 통과**한다(동어반복 · 무인 리뷰 지적).
    //    ⇒ 다섯을 리터럴로 못박는다 — 매핑이 줄면 여기서 깨진다.
    expect(query.exactCategories).toEqual([
      'dev-pipeline', 'self-implement', 'harness.frontdoor', 'harness.membrane', 'harness.sequencer',
    ]);
  });

  it('pty 축은 접두 밖 nexus와 pane-spawner 네 카테고리를 포함한다', () => {
    const { query, error } = buildQuery({ axis: 'pty' });
    expect(error).toBeUndefined();
    expect(query.categories).toBeUndefined();
    // ⛔ 동어반복 금지(위와 같은 이유) — 열 개를 리터럴로. ⭐ 뒤 넷이 이 기능의 존재 이유다.
    expect(query.exactCategories).toEqual([
      'pty.takeover', 'pty.arbiter', 'pty.spawn', 'pty.drive', 'pty.special-key', 'pty.shell-send',
      'nexus.pty.write.error', 'nexus.pty.resize.error', 'nexus.pty.kill.error', 'pane-spawner.pty.start',
    ]);
    expect(query.exactCategories).toEqual(expect.arrayContaining([
      'nexus.pty.write.error',
      'nexus.pty.resize.error',
      'nexus.pty.kill.error',
      'pane-spawner.pty.start',
    ]));
  });

  it('모르는 축은 알려진 축 이름과 함께 거부한다', () => {
    expect(buildQuery({ axis: 'nope' }).error).toBe("--axis 는 dev|pty 중 하나 (받은 값: 'nope')");
  });

  it('--exact-category 가 값 없는 구분자뿐이면 필터를 안 건다', () => {
    // ⚠️ 종전엔 빈 배열이 설정됐다. --axis 도입으로 "원소가 있을 때만 설정" 으로 바뀌었고
    //    그 편이 옳다(빈 필터는 아무 뜻이 없다). ⇒ 의도된 변경임을 여기서 고정한다.
    expect(buildQuery({ exactCategory: ',' }).query.exactCategories).toBeUndefined();
    expect(buildQuery({ exactCategory: 'a,,b' }).query.exactCategories).toEqual(['a', 'b']);
  });

  it('빈 문자열·공백 축은 미지정이 아니라 거부다 (fail-closed)', () => {
    // ⛔ `if (opts.axis)` 였을 때 빈 문자열이 **무필터로 통과**했다 — 미지정과 미지원은 다르다.
    for (const bad of ['', '   ']) {
      const { query, error } = buildQuery({ axis: bad });
      expect(error).toContain('--axis 는');
      expect(query.exactCategories).toBeUndefined();
    }
  });

  it('프로토타입 이름도 미지 축으로 거부한다 (실크래시 회귀)', () => {
    // ⛔ 일반 객체 인덱싱이라 `toString` 이 Function.prototype 값을 돌려주고 push(...)에서 터졌다.
    for (const proto of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const { query, error } = buildQuery({ axis: proto });
      expect(error).toContain('--axis 는');
      expect(query.exactCategories).toBeUndefined();
    }
  });

  it('미분류가 상한을 넘으면 표본만 보이고 절단 사실을 밝힌다', () => {
    // ⛔ 조용한 절단이 이 저장소에서 반복해 오판을 낳았다 ⇒ 개수와 "외 N개" 를 반드시 낸다.
    const many = Array.from({ length: UNCLASSIFIED_PREVIEW + 7 }, (_, i) => `zz.unmapped.${i}`);
    const out = renderAxisExplanation('dev', many);
    expect(out).toContain(`미분류 ${many.length}개:`);
    expect(out).toContain('외 7개');
    expect(out).toContain('zz.unmapped.0');
    expect(out).not.toContain(`zz.unmapped.${UNCLASSIFIED_PREVIEW}`);   // 상한 밖은 안 나온다
  });

  it('explain은 매핑됨·미분류·매핑됐는데 발화 0 세 칸을 낸다', () => {
    expect(renderAxisExplanation('dev', ['dev-pipeline', 'dispatch.continuation.scheduler'])).toBe(
      '매핑됨 (dev) 5개: dev-pipeline, self-implement, harness.frontdoor, harness.membrane, harness.sequencer\n'
      + '미분류 1개: dispatch.continuation.scheduler\n'
      + '매핑됐는데 발화 0 (4개): self-implement, harness.frontdoor, harness.membrane, harness.sequencer',
    );
  });

  it('축을 모를 때 explain은 모든 축과 기존 정확 카테고리를 발견시킨다', () => {
    expect(buildQuery({ explain: true }).error).toBeUndefined();
    expect(renderLogAxisDiscovery()).toBe(
      '알려진 로그 축 2개:\n'
      + 'dev (5개): dev-pipeline, self-implement, harness.frontdoor, harness.membrane, harness.sequencer\n'
      + 'pty (10개): pty.takeover, pty.arbiter, pty.spawn, pty.drive, pty.special-key, pty.shell-send, nexus.pty.write.error, nexus.pty.resize.error, nexus.pty.kill.error, pane-spawner.pty.start\n'
      + '축을 고른 뒤: elanous logs --axis <name> --explain',
    );
  });
});

describe('renderGatedHint — 렌더 게이팅 빈결과 넛지', () => {
  it('surface tui 요청 → 힌트', () => {
    expect(renderGatedHint({ surface: 'tui' })).toContain('렌더 로그');
  });
  it('렌더 카테고리(key./mouse./dashboard.) → 힌트', () => {
    expect(renderGatedHint({ category: 'key.press' })).not.toBeNull();
    expect(renderGatedHint({ category: 'mouse.route' })).not.toBeNull();
    expect(renderGatedHint({ category: 'dashboard.chat.stream' })).not.toBeNull();
  });
  it('--exact-category 전용 또는 쉼표 목록에 렌더 카테고리가 있으면 힌트', () => {
    expect(renderGatedHint({ exactCategory: 'dashboard.session-runtime-dispatch' })).not.toBeNull();
    expect(renderGatedHint({ exactCategory: 'goal.loop, dashboard.session-runtime-dispatch' })).not.toBeNull();
    expect(renderGatedHint({ category: 'goal.loop', exactCategory: 'mouse.route' })).not.toBeNull();
  });
  it('렌더 무관 카테고리/서피스 → null(오탐 없음)', () => {
    expect(renderGatedHint({ category: 'goal.loop' })).toBeNull();
    expect(renderGatedHint({ surface: 'pwa,telegram' })).toBeNull();
    expect(renderGatedHint({})).toBeNull();
  });
  it('접두 오탐 방지 — keyboard 는 key 아님', () => {
    // 'keyboard' 가 'key.' 로 오매칭되지 않아야(정확 일치 또는 `key.` 접두만).
    expect(renderGatedHint({ category: 'keyboard' })).toBeNull();
  });
  it('비현재 스코프 대상이 있으면 호출자 level.json을 읽거나 빈 결과를 실제 부재라고 단언하지 않는다', () => {
    let readCalls = 0;
    const hint = renderGatedHint(
      { instance: "test:other 'quoted'", category: 'dashboard.chat.stream' },
      () => { readCalls += 1; return true; },
      ["test:other 'quoted'"],
    );
    expect(readCalls).toBe(0);
    expect(hint).toContain("대상 인스턴스 'test:other '\\''quoted'\\'''의 렌더 억제 상태는 확인하지 못했다");
    // ⛔⭐⭐⭐ 종전엔 여기서 `elanous logs --instance '<이름>' level` 을 «기대»했다.
    //   그런데 ***`logs level` 은 `--instance` 를 안 받는다***(옵션은 `--json`·`--render` 뿐) —
    //   그 명령은 «돌긴 하는데 호출자 자신의 레벨»을 보여 준다(실측). 즉 이 단언은
    //   ***「돌지만 다른 것을 보는 명령」을 계약으로 굳히고 있었다***(#7480 review must-fix).
    //   ⇒ 방향을 뒤집는다: 이 넛지는 명령을 «주지 않는다».
    expect(hint).not.toContain('elanous logs');
    expect(hint).not.toContain('level`');
    expect(hint).not.toContain('빈 결과라면 실제로 이벤트가 없는 것이다');
  });

  it('--all처럼 현재 스코프와 비현재 스코프가 섞여도 호출자 seam을 읽지 않는다', () => {
    let readCalls = 0;
    const hint = renderGatedHint(
      { all: true, category: 'dashboard.chat.stream' },
      () => { readCalls += 1; return true; },
      ['current', 'other'],
    );
    expect(readCalls).toBe(0);
    expect(hint).toContain('조회 대상 인스턴스들의 렌더 억제 상태는 확인하지 못했다');
    // ⭐ 실제 이름을 «값으로» 준다 — 사용자가 채울 자리가 남으면 안 된다(#7475 must-fix).
    expect(hint).toContain('current');
    expect(hint).toContain('other');
    expect(hint).not.toContain('빈 결과라면 실제로 이벤트가 없는 것이다');
  });

  // ⛔⭐⭐ 판별력 — 이 검사가 「플레이스홀더 명령을 다시 넣는 것」을 «문다».
  //   #7475 는 같은 지적을 3라운드 받고 UNCONVERGEABLE 로 죽었는데, 그때 테스트는
  //   플레이스홀더를 «기대»하고 있어서 회귀를 못 막았다(Goodhart). 방향을 뒤집는다.
  it('비현재 스코프 안내에 사용자가 채워야 하는 자리를 남긴 명령이 없다', () => {
    for (const targets of [['only-one'], ['a', 'b'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
      const hint = renderGatedHint(
        { all: true, category: 'dashboard.chat.stream' },
        () => true,
        targets,
      );
      expect(hint).not.toBeNull();
      // `<…>` 로 감싼 자리표시자가 어떤 형태로도 남으면 그 문면은 복사해서 못 쓴다.
      expect(hint!).not.toMatch(/<[^>]+>/);
    }
  });

  // ⭐⭐ 「현재 ⊕ 외부가 «섞인»」 판정 — 순수 함수라 파일시스템도 0건 분기도 안 탄다(결정론).
  //   ⛔ 이 자리를 wiring 검사로 하려다 「실 DB 에 행이 있으면 안 도는 검사」를 만들었다(#7480 재리뷰).
  it('nonCurrentScopeNames — 현재 우주는 빠지고 외부만 이름으로 남는다', () => {
    const targets: LogTarget[] = [
      { name: 'current', dbPath: '/tmp/x/current/logs.db' },
      { name: 'other', dbPath: '/tmp/x/other/logs.db' },
      { name: 'third', dbPath: '/tmp/x/third/logs.db' },
    ];
    expect(nonCurrentScopeNames(targets, '/tmp/x/current/logs.db')).toEqual(['other', 'third']);
    // ⛔ 현재 우주가 «안 빠지면» 우리는 「자기 상태도 모른다」고 말하는 셈이고 그건 거짓이다.
    expect(nonCurrentScopeNames(targets, '/tmp/x/current/logs.db')).not.toContain('current');
    // 전부 외부면 전부 남는다 · 전부 현재면 비어서 넛지가 이 갈래로 안 간다.
    expect(nonCurrentScopeNames(targets, '/tmp/x/none/logs.db')).toHaveLength(3);
    expect(nonCurrentScopeNames([targets[0]!], '/tmp/x/current/logs.db')).toEqual([]);
  });

  it('대상이 많으면 앞의 몇 개만 이름으로 적고 나머지는 개수로 말한다', () => {
    const hint = renderGatedHint(
      { all: true, category: 'dashboard.chat.stream' },
      () => true,
      ['a', 'b', 'c', 'd', 'e', 'f'],
    );
    expect(hint).toContain('외 2개');
    expect(hint).not.toContain('f');
  });
});

describe('0건 인스턴스 · 상한 힌트 — 구조적 판정', () => {
  it('다른 인스턴스의 일치가 있을 때만 같은 필터의 재조회 안내를 렌더한다', () => {
    expect(otherInstanceHint([], { category: 'self-implement', since: '1h' })).toBeNull();
    expect(otherInstanceHint([{ name: 'test:monad-agent', count: 12 }, { name: 'test:foo', count: 3 }], {
      category: 'self-implement', since: '1h', limit: '20',
    })).toBe(
      '  ↳ 다른 인스턴스에는 있다 — test:monad-agent 12건 · test:foo 3건\n'
      + "    전체를 보려면: elanous logs --all --include-test --category 'self-implement' --since '1h' --limit '20'",
    );
  });

  it('POD-OBS: 결과가 0이 아니어도 다른 우주에 더 많으면 경고하고, 적거나 같으면 침묵한다', () => {
    const opts = { event: 'pre-pr-sync', since: '24h' };
    expect(otherInstanceMajorityWarning(0, [{ name: 'test:a', count: 5 }], opts)).toBeNull();
    expect(otherInstanceMajorityWarning(3, [{ name: 'test:a', count: 3 }], opts)).toBeNull();
    expect(otherInstanceMajorityWarning(3, [], opts)).toBeNull();
    const warning = otherInstanceMajorityWarning(1, [
      { name: 'test:a', count: 2 }, { name: 'test:b', count: 200 }, { name: 'test:c', count: 70 }, { name: 'test:d', count: 4 },
    ], opts);
    expect(warning).toContain('여기 1건 · 다른 우주에 276건이 더 있다 — test:b 200건 · test:c 70건 · test:d 4건 외 1곳');
    expect(warning).toContain("elanous logs --all --include-test --event 'pre-pr-sync' --since '24h'");
  });

  it('재조회 명령은 공백·와일드카드·따옴표가 있는 필터도 POSIX 한 인자로 보존한다', () => {
    expect(quoteShellArg("foo bar * 'single' \"double\"")).toBe("'foo bar * '\\''single'\\'' \"double\"'");
    expect(otherInstanceHint([{ name: 'test:fixture', count: 1 }], { grep: "foo bar * 'single' \"double\"" }))
      .toContain("--grep 'foo bar * '\\''single'\\'' \"double\"'");
  });

  it('공백 또는 OR가 있는 --grep은 연속 문자열 검색 경고를 만들고 단일 토큰은 경고하지 않는다', () => {
    expect(grepPhraseWarning('headless progress')).toContain('OR 검색이 아니라 단일 연속 문자열 검색');
    expect(grepPhraseWarning('headless OR progress')).toContain('0건이면 이 해석 때문일 수 있습니다');
    expect(grepPhraseWarning('headless.progress')).toBeNull();
  });

  it('파이프·이스케이프 파이프·쉼표·OR·공백 다중 --grep 경고는 분리 토큰을 보여 준다', () => {
    const cases: Array<[string, string[]]> = [
      ['a\\|b', ["'a\\'", "'b'"]],
      ['a|b', ["'a'", "'b'"]],
      ['a,b', ["'a'", "'b'"]],
      ['a OR b', ["'a'", "'b'"]],
      ['a b', ["'a'", "'b'"]],
    ];
    for (const [grep, tokens] of cases) {
      const warning = grepPhraseWarning(grep);
      expect(warning).toContain('OR 검색이 아니라 단일 연속 문자열 검색');
      expect(warning).toContain(`분리 토큰: ${tokens.join(', ')}`);
    }
    expect(grepPhraseWarning('run-43b657de')).toBeNull();
  });

  it('--event에 알려진 카테고리를 주면 --category 사용을 안내하고 이벤트는 그대로 허용한다', () => {
    expect(eventCategoryWarning('dev-pipeline')).toContain('--category');
    expect(eventCategoryWarning('dev-pipeline')).toContain('카테고리와 이벤트를 혼동했을 수 있습니다');
    expect(eventCategoryWarning('plan')).toBeNull();
  });

  it('read-only 탐침은 비타겟 등록 스토어의 같은 필터만 세고 완전 연합은 건너뛴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-log-probe-'));
    const dbPath = join(dir, 'logs.db');
    const writer = new LogStore(dbPath, { instance: 'test:fixture' });
    writer.insertBatch([
      { rec: { ts: new Date().toISOString(), category: 'self-implement.run', event: 'done' }, surface: 'nexus' },
      { rec: { ts: new Date().toISOString(), category: 'other.run', event: 'done' }, surface: 'nexus' },
    ]);
    writer.close();
    const instance: LogInstanceView = {
      name: 'test:fixture', stateDir: dir, stateDirCount: 1, ambiguous: false,
      kind: 'test', configDir: dir, pid: 0, startedAt: '', alive: false, liveness: 'dead', dbExists: true, dbPath,
    };
    const { query } = buildQuery({ category: 'self-implement' });
    expect(probeOtherInstanceMatches({}, query, ['/target/logs.db'], [instance])).toEqual([{ name: 'test:fixture', count: 1 }]);
    expect(probeOtherInstanceMatches({ all: true, includeTest: true }, query, ['/target/logs.db'], [instance])).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('탐침의 open·query·close 실패는 모두 fail-soft다', () => {
    const instance: LogInstanceView = {
      name: 'test:broken', stateDir: '/broken', stateDirCount: 1, ambiguous: false,
      kind: 'test', configDir: '/broken', pid: 0, startedAt: '', alive: false, liveness: 'dead', dbExists: true, dbPath: '/broken/logs.db',
    };
    const { query } = buildQuery({});
    expect(probeOtherInstanceMatches({}, query, [], [instance], () => { throw new Error('open'); })).toEqual([]);
    expect(probeOtherInstanceMatches({}, query, [], [instance], () => ({
      countMatching: () => { throw new Error('query'); },
      close: () => { throw new Error('close'); },
    } as unknown as LogStore))).toEqual([]);
    expect(probeOtherInstanceMatches({}, query, [], [instance], () => ({
      countMatching: () => 1,
      close: () => { throw new Error('close'); },
    } as unknown as LogStore))).toEqual([{ name: 'test:broken', count: 1 }]);
  });

  it('출력 행수와 유효 상한이 같을 때만 미지의 오래된 일치 가능성을 알린다', () => {
    expect(effectiveLogLimit()).toBe(100);
    // ⛔⭐ 2026-07-29 — 옛 기대값은 1000 이었다. 그 1000 은 **HTTP `/v1/logs` 응답 보호값**이고
    //   CLI 는 **logs.db 로컬 직독**이라 물려받을 이유가 없었다. 정책은 `log-fabric.ts` 로 옮겼고
    //   여기는 스토어 OOM 백스톱만 공유한다 ⇒ 요청한 만큼 온다(실측: 3000 요청 → 2596건 = 실보유량).
    expect(effectiveLogLimit(5_000)).toBe(5_000);
    expect(limitReachedHint(99, 100)).toBeNull();
    // ⛔⭐ 2026-07-29 — 옛 조언(*"--since 로 창을 좁혀라"*)을 **다음 쪽 안내**로 바꿨다.
    //   그 조언은 **틀렸다**: 정렬이 최근순이라 창을 넓히든 좁히든 **최근 상한만큼**만 온다.
    //   실측으로 `frame-stall` 전수 조회가 12h~168h 어느 창에서도 **정확히 1000행**을 냈고,
    //   두 트랙이 그것을 "7일치" 로 읽어 표본 판정을 잘못했다. ⇒ 커서(`--before`)를 안내한다.
    //   ⚠️ *"있을 수 있다"* 는 그대로 둔다 — 상한에 걸린 것이 더 있다는 **증거는 아니다**.
    expect(limitReachedHint(100, 100)).toBe(
      '↳ 상한 100 도달 — 더 오래된 일치가 있을 수 있다.\n↳ 과거로 가려면 --before <id> 로 페이지를 넘긴다(--json 의 id).',
    );
    expect(limitReachedHint(1000, 1000, 3000)).toBe(
      '↳ 상한 1000 도달 (요청 --limit 3000은 유효 상한 1000으로 제한됨) — 더 오래된 일치가 있을 수 있다.\n↳ 과거로 가려면 --before <id> 로 페이지를 넘긴다(--json 의 id).',
    );
    expect(limitReachedHint(100, 100)).not.toContain('잘렸다');
    expect(limitReachedHint(100, 100)).not.toContain('--limit 을 올리거나');
    expect(limitReachedJsonMeta(100, 100, 100, 42, false)).toEqual({
      _meta: {
        type: 'log-query-limit', limitReached: true, requestedLimit: 100, effectiveLimit: 100,
        nextCursor: 42, pagination: 'before-id',
      },
    });
    expect(limitReachedJsonMeta(100, 100, 100, undefined, { prod: 42, 'test:fixture': 17 })).toEqual({
      _meta: {
        type: 'log-query-limit', limitReached: true, requestedLimit: 100, effectiveLimit: 100,
        nextCursor: null, nextCursors: { prod: 42, 'test:fixture': 17 }, pagination: 'before-id-by-instance',
      },
    });
    expect(limitReachedJsonMeta(99, 100, 100, 42, false)).toBeNull();
  });

  it('JSON stdout 메타를 제거한 소비자도 stderr 신호로 상한 도달과 비도달을 구별한다', () => {
    expect(limitReachedStderrSignal(limitReachedJsonMeta(2, 2, 2, 1))).toBe(
      'elanous logs: result may be truncated (limitReached=true)',
    );
    expect(limitReachedStderrSignal(limitReachedJsonMeta(1, 2, 2, 1))).toBeNull();
  });
});

describe('다중 표면 이중 기록 JSON 메타', () => {
  it('같은 ts·category·event가 여러 표면에서 나온 그룹 수와 표면 종류를 센다', () => {
    const duplicateRows = [
      { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status', surface: 'harness' },
      { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status', surface: 'harness:self-implement' },
      { ts: '2026-08-23T00:00:01.000Z', category: 'self-implement', event: 'run-status', surface: 'harness' },
    ];

    expect(multiSurfaceDuplicateJsonMeta(duplicateRows)).toEqual({
      _meta: {
        type: 'log-query-multi-surface-duplicates',
        duplicateGroupCount: 1,
        surfaceKindCount: 2,
        surfaces: ['harness', 'harness:self-implement'],
        groups: [{
          ts: '2026-08-23T00:00:00.000Z',
          category: 'self-implement',
          event: 'run-status',
          surfaces: ['harness', 'harness:self-implement'],
          rowCount: 2,
        }],
      },
    });
    expect(duplicateRows).toHaveLength(3);
  });

  it('표면이 하나뿐이면 0도 필드로 내고 그룹 필드는 사라지지 않는다', () => {
    expect(multiSurfaceDuplicateJsonMeta([
      { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status', surface: 'harness' },
      { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status', surface: 'harness' },
    ])).toEqual({
      _meta: {
        type: 'log-query-multi-surface-duplicates',
        duplicateGroupCount: 0,
        surfaceKindCount: 0,
        surfaces: [],
        groups: [],
      },
    });
  });
});

describe('런 커버리지 안내', () => {
  const rows = (data: Array<string | null>) => data.map((value) => ({ data: value }));

  it('반환 행의 반복 runId는 한 런으로, 서로 다른 runId는 각각 세며 공백·비문자 식별자는 무시한다', () => {
    expect(runCoverageHint(rows([
      '{"runId":"run-a"}', '{"runId":"run-a"}', '{"runId":"run-b"}',
      '{"runId":"   "}', '{"runId":7}', 'not-json', null,
    ]))).toBe('안내: 반환된 7행은 식별 가능한 런 2개에서 왔습니다 (서로 다른 런이 섞임).');
  });

  it('한 런과 식별자 부재를 다르게 알리고 빈 결과에는 기존 안내를 추가하지 않는다', () => {
    expect(runCoverageHint(rows(['{"runId":"run-only"}', '{"runId":"run-only"}'])))
      .toBe('안내: 반환된 2행은 식별 가능한 런 1개에서 왔습니다 (런 혼합 없음).');
    expect(runCoverageHint(rows(['{}', 'not-json', null, '{"runId":""}'])))
      .toBe('안내: 반환된 4행에는 식별 가능한 런 식별자가 없습니다.');
    expect(runCoverageHint([])).toBeNull();
  });
});

describe('Pod child observation gap', () => {
  it('warns only for a child category or event-only query with Pod runs', () => {
    const notice = podObservationGapNotice({ events: ['pre-pr-sync'] }, 2);
    expect(notice).toContain('Pod 에서 돈 런 2개');
    expect(notice).toContain('elanous self run-ledger <runId>');
    for (const category of ['self-implement', 'self-dev.worker', 'harness.clean']) {
      expect(podObservationGapNotice({ categories: [category] }, 1)).not.toBeNull();
      expect(podObservationGapNotice({ exactCategories: [category] }, 1)).not.toBeNull();
    }
    expect(podObservationGapNotice({ categories: ['nexus'], events: ['pre-pr-sync'] }, 2)).toBeNull();
    expect(podObservationGapNotice({ categories: ['harness'], events: ['pre-pr-sync'] }, 0)).toBeNull();
  });

  it('counts in-window Pod ledgers for text and JSON, not local or stale ledgers; scopes federation and surfaces unreadable ledgers', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-logs-pod-gap-')));
    const stateDir = join(home, '.elanous');
    const testState = join(home, 'test-state');
    const directory = join(stateDir, 'run-ledger');
    const testDirectory = join(testState, 'run-ledger');
    mkdirSync(directory, { recursive: true });
    mkdirSync(testDirectory, { recursive: true });
    new LogStore(join(stateDir, 'logs', 'logs.db')).close();
    new LogStore(join(testState, 'logs', 'logs.db')).close();
    const now = Date.now();
    const start = now - 60_000;
    const stamp = new Date(now - 30_000).toISOString();
    const put = (dir: string, suffix: string, hostname: string, timestamp = stamp) => {
      const runId = `run-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
      const path = join(dir, `${runId}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ runId, timestamp, event: 'run-origin', data: { hostname, platform: 'linux' } })}\n`);
      return path;
    };
    const pod = 'si-task-03814f9f935e-e40e5e5f-trmp5';
    put(directory, '1', pod);
    const overlapping = put(directory, '2', pod, new Date(now - 120_000).toISOString());
    writeFileSync(overlapping, `${readFileSync(overlapping, 'utf8')}${JSON.stringify({
      runId: 'run-00000000-0000-0000-0000-000000000002', timestamp: stamp, event: 'pre-pr-sync', data: {},
    })}\n`);
    put(directory, '3', 'Joosungui-MacBookPro');
    const stale = put(directory, '4', pod);
    utimesSync(stale, new Date(now - 120_000), new Date(now - 120_000));
    put(directory, '7', pod, new Date(now - 120_000).toISOString());
    put(testDirectory, '5', pod);
    writeFileSync(join(directory, 'run-00000000-0000-0000-0000-000000000006.jsonl'), 'broken json\n');
    writeFileSync(join(stateDir, 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:fixture', stateDir: testState, kind: 'test', configDir: testState, pid: 0, startedAt: '',
    }] }));
    // GATE-SPEED ③: in-process(`runLogsInProcess`) — 실물 진입점은 아래 「uses the first run-origin …」 시험(spawn 유지)이 문다.
    const run = (args: string[]) => runLogsInProcess(['--instance', 'prod', '--since', String(start), '--until', String(now), ...args],
      { HOME: home, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir, TZ: 'UTC' });
    try {
      const event = await run(['--event', 'pre-pr-sync']);
      expect(event.status).toBe(0);
      expect(event.stderr).toContain('Pod 에서 돈 런 2개');
      expect(event.stderr).toContain('elanous self run-ledger <runId>');
      expect(event.stderr).toContain('(못 읽은 원장 1)');
      const nexus = await run(['--category', 'nexus']);
      expect(nexus.status).toBe(0);
      expect(nexus.stderr).not.toContain('POD-OBS');
      const json = await run(['--event', 'pre-pr-sync', '--json']);
      expect(json.status).toBe(0);
      const meta = json.stdout.trim().split('\n').map((line) => JSON.parse(line)._meta);
      expect(meta[0]).toMatchObject({ type: 'log-query-opened-stores' });
      expect(meta.find((item) => item?.type === 'log-query-pod-observation-gap'))
        .toEqual({ type: 'log-query-pod-observation-gap', podRuns: 2, unreadableLedgers: 1 });
      expect(meta).toContainEqual({ type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] });
      const all = await runLogsInProcess(['--all', '--include-test', '--since', String(start), '--until', String(now), '--event', 'pre-pr-sync', '--json'],
        { HOME: home, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir, TZ: 'UTC' });
      expect(all.status).toBe(0);
      expect(all.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)._meta)
        .find((item) => item?.type === 'log-query-pod-observation-gap')?.podRuns).toBe(3);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);

  it('--follow --event pre-pr-sync warns after the seed; --json emits the same Pod gap meta', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-logs-pod-follow-')));
    const stateDir = join(home, '.elanous');
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    new LogStore(join(stateDir, 'logs', 'logs.db')).close();
    const now = Date.now();
    for (const suffix of ['1', '2']) {
      const runId = `run-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({
        runId, timestamp: new Date(now - 10_000).toISOString(), event: 'run-origin',
        data: { hostname: 'si-task-03814f9f935e-e40e5e5f-trmp5', platform: 'linux' },
      })}\n`);
    }
    const follow = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      const child = spawn(process.execPath, [
        'bin/elanous.mjs', 'logs', '--instance', 'prod', '--follow', '--since', String(now - 60_000),
        '--event', 'pre-pr-sync', ...args,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`follow banner timeout: ${stderr}`)), 10_000);
          child.stderr.on('data', () => {
            if (stderr.includes('--- following 열린 로그 스토어 1개 (Ctrl-C 종료) ---')) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.once('error', (error) => { clearTimeout(timeout); reject(error); });
          child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`follow exited early: ${code} ${stderr}`)); });
        });
        return { stdout, stderr };
      } finally {
        child.kill('SIGTERM');
        if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    };
    try {
      const text = await follow([]);
      expect(text.stderr).toContain('Pod 에서 돈 런 2개');
      expect(text.stderr).toContain('elanous self run-ledger <runId>');
      expect(text.stderr.match(/Pod 에서 돈 런 2개/g)).toHaveLength(1);
      const json = await follow(['--json']);
      expect(json.stdout.trim().split('\n').map((line) => JSON.parse(line)._meta)).toContainEqual({
        type: 'log-query-pod-observation-gap', podRuns: 2, unreadableLedgers: 0,
      });
      expect(json.stderr).not.toContain('Pod 에서 돈 런 2개');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);

  it('uses the first run-origin even when another event precedes it', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-logs-pod-late-origin-')));
    const stateDir = join(home, '.elanous');
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    new LogStore(join(stateDir, 'logs', 'logs.db')).close();
    const now = Date.now();
    const runId = 'run-00000000-0000-0000-0000-000000000008';
    const timestamp = new Date(now - 10_000).toISOString();
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), [
      { runId, timestamp, event: 'pre-pr-sync', data: {} },
      { runId, timestamp, event: 'run-origin', data: { hostname: 'si-task-03814f9f935e-e40e5e5f-trmp5', platform: 'linux' } },
      { runId, timestamp, event: 'run-origin', data: { hostname: 'Joosungui-MacBookPro', platform: 'darwin' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    try {
      const result = spawnSync(process.execPath, ['bin/elanous.mjs', 'logs', '--instance', 'prod', '--since', String(now - 60_000), '--until', String(now), '--event', 'pre-pr-sync'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: stateDir, ELANOUS_CONFIG_DIR: stateDir },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Pod 에서 돈 런 1개');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);

  it('counts selected registered instance ledgers without a logs.db, including when no store opens', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-logs-pod-no-db-')));
    const prodState = join(home, '.elanous');
    const siblingState = join(home, 'ledger-only');
    const ledgerDir = join(siblingState, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const now = Date.now();
    const runId = 'run-00000000-0000-0000-0000-000000000009';
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${JSON.stringify({
      runId, timestamp: new Date(now - 10_000).toISOString(), event: 'run-origin',
      data: { hostname: 'si-task-03814f9f935e-e40e5e5f-trmp5', platform: 'linux' },
    })}\n`);
    mkdirSync(join(prodState, 'logs'), { recursive: true });
    writeFileSync(join(prodState, 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'ledger-only', stateDir: siblingState, kind: 'prod', configDir: siblingState, pid: 0, startedAt: '',
    }] }));
    const run = (args: string[]) => runLogsInProcess(['--since', String(now - 60_000), '--until', String(now), '--event', 'pre-pr-sync', ...args],
      { HOME: home, ELANOUS_STATE_DIR: prodState, ELANOUS_CONFIG_DIR: prodState });
    try {
      const missing = await run(['--instance', 'ledger-only']);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('열 수 있는 로그 스토어 없음');
      expect(missing.stderr).toContain('Pod 에서 돈 런 1개');
      const missingJson = await run(['--instance', 'ledger-only', '--json']);
      expect(missingJson.status).toBe(1);
      expect(missingJson.stdout.trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([{ _meta: { type: 'log-query-pod-observation-gap', podRuns: 1, unreadableLedgers: 0 } }]);
      new LogStore(join(prodState, 'logs', 'logs.db')).close();
      const federated = await run(['--all', '--json']);
      expect(federated.status).toBe(0);
      expect(federated.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)._meta)
        .find((item) => item?.type === 'log-query-pod-observation-gap'))
        .toEqual({ type: 'log-query-pod-observation-gap', podRuns: 1, unreadableLedgers: 0 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30_000);
});

/** ⭐ GATE-SPEED ③(2026-10-08) — `elanous logs …` 를 «같은 프로세스»에서 commander 의 실제 `logs` 명령으로 돌린다.
 *  초판의 `runLogs` 는 호출마다 `bun bin/elanous.mjs logs …` 를 새로 띄웠다(81회 · 로컬 건당 ≈1~2 s · 게이트 794 s).
 *  여기서는 같은 조건(HOME · TZ=UTC · 시험이 준 env)을 프로세스 전역에 잠깐 세우고, 이미 import 한 `program` 의
 *  `logs` 명령(같은 옵션 정의 · 같은 action → `runLogsCli`)을 `parseAsync` 로 부른 뒤 되돌린다.
 *  stdout/stderr 는 `process.*.write` ⊕ `console.*` 두 채널을 다 받는다(아래 remote describe 의 `captureIo` 와 같은 이유).
 *  ⛔ 실물 진입점(`bin/elanous.mjs` 기동 · 파이프 · follow · remote LIVE)은 이 파일의 다른 spawn 시험과
 *    `runLogsReal` 한 건이 계속 문다 — «배선 PR 은 실물을 한 번 돌린다». */
async function runLogsInProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  const logsCommand = program.commands.find((c) => c.name() === 'logs');
  if (!logsCommand) throw new Error('logs command is not registered');
  const savedEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const originalExit = process.exit;
  const savedExitCode = process.exitCode;
  const sink = (bucket: string[]) => ((chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown) => {
    bucket.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
    return true;
  });
  let status = 0;
  // ⚠️ Bun 의 `os.homedir()` 는 `process.env.HOME` 을 바꿔도 «안 따라온다»(실측) — 레지스트리
  //   (`~/.elanous/logs/instances.json`)가 운영 홈을 읽게 된다. ⇒ HOME 을 준 호출은 homedir 도 같이 돌린다.
  const homeSpy = typeof env.HOME === 'string' ? spyOn(nodeOs, 'homedir').mockReturnValue(env.HOME) : undefined;
  console.log = ((...items: unknown[]) => { stdout.push(`${items.map(String).join(' ')}\n`); }) as typeof console.log;
  console.error = ((...items: unknown[]) => { stderr.push(`${items.map(String).join(' ')}\n`); }) as typeof console.error;
  console.warn = console.error;
  process.stdout.write = sink(stdout) as typeof process.stdout.write;
  process.stderr.write = sink(stderr) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw Object.assign(new Error('process.exit'), { exitCode: code ?? 0 }); }) as typeof process.exit;
  logsCommand.exitOverride();
  try {
    process.exitCode = 0;
    await logsCommand.parseAsync(args, { from: 'user' });
    status = Number(process.exitCode ?? 0);
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    if (typeof exitCode !== 'number') throw error;
    status = exitCode;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exit = originalExit;
    homeSpy?.mockRestore();
    // ⚠️ Bun 은 `process.exitCode = undefined` 로는 안 되돌아간다 — 0 으로 되돌린다.
    process.exitCode = savedExitCode ?? 0;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('runLogsCli — 사람용 출력 wiring', () => {
  function runLogs(args: string[], home: string, env: NodeJS.ProcessEnv = {}) {
    return runLogsInProcess(args, { HOME: home, TZ: 'UTC', ...env });
  }
  /** 실물 진입점 — `bin/elanous.mjs logs` 가 같은 결과를 내는지(배선) 이 describe 에서 한 번 잰다. */
  function runLogsReal(args: string[], home: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['bin/elanous.mjs', 'logs', ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, TZ: 'UTC', ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
    });
  }

  it('기본 조회와 --all --include-test는 등록 스토어 모집단의 안 본 수를 scope·queryStatus로 같은 값으로 말한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-unopened-stores-'));
    const prodState = join(home, '.elanous');
    const siblingState = join(home, 'sibling-state');
    const testState = join(home, 'test-state');
    for (const [stateDir, instance] of [[prodState, 'prod'], [siblingState, 'sibling'], [testState, 'test:fixture']] as const) {
      const store = new LogStore(join(stateDir, 'logs', 'logs.db'), { instance });
      store.insertBatch([{ rec: { ts: '2026-08-22T00:00:00.000Z', category: 'scope', event: instance }, surface: 'nexus' }]);
      store.close();
    }
    writeFileSync(join(prodState, 'logs', 'instances.json'), JSON.stringify({ instances: [
      { name: 'prod', stateDir: prodState, kind: 'prod', configDir: prodState, pid: 0, startedAt: '' },
      { name: 'sibling', stateDir: siblingState, kind: 'prod', configDir: siblingState, pid: 0, startedAt: '' },
      { name: 'test:fixture', stateDir: testState, kind: 'test', configDir: testState, pid: 0, startedAt: '' },
    ] }));
    try {
      const fixtureEnv = { ELANOUS_STATE_DIR: prodState };
      // ⭐ 실물 진입점 한 번 — 아래 in-process 호출들과 같은 계약을 `bin/elanous.mjs` 가 그대로 내는지.
      const defaultResult = runLogsReal(['--limit', '1'], home, fixtureEnv);
      expect(defaultResult.status).toBe(0);
      expect(defaultResult.stdout).toContain('scope');
      expect(defaultResult.stdout).not.toContain('안 본 스토어');
      expect(defaultResult.stderr).toContain('열린 로그 스토어 1개');
      expect(defaultResult.stderr).toContain('안 본 스토어 2개');
      expect(defaultResult.stderr).toContain('scope={"registeredStores":3,"unopenedStores":2}');
      expect(defaultResult.stderr).toContain('queryStatus={"registeredStores":true}');

      const allResult = await runLogs(['--all', '--include-test', '--limit', '1'], home, fixtureEnv);
      expect(allResult.status).toBe(0);
      expect(allResult.stderr).toContain('열린 로그 스토어 3개');
      expect(allResult.stderr).toContain('안 본 스토어 0개');
      expect(allResult.stderr).toContain('scope={"registeredStores":3,"unopenedStores":0}');
      expect(allResult.stderr).toContain('queryStatus={"registeredStores":true}');

      const defaultJson = await runLogs(['--json', '--limit', '1'], home, fixtureEnv);
      const defaultMeta = JSON.parse(defaultJson.stdout.trim().split('\n')[0]!);
      expect(defaultMeta).toEqual({ _meta: {
        type: 'log-query-opened-stores', stores: expect.any(Array),
        scope: { registeredStores: 3, unopenedStores: 2 }, queryStatus: { registeredStores: true },
      } });
      const allJson = await runLogs(['--json', '--all', '--include-test', '--limit', '1'], home, fixtureEnv);
      const allMeta = JSON.parse(allJson.stdout.trim().split('\n')[0]!);
      expect(allMeta).toEqual({ _meta: {
        type: 'log-query-opened-stores', stores: expect.any(Array),
        scope: { registeredStores: 3, unopenedStores: 0 }, queryStatus: { registeredStores: true },
      } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('레지스트리 또는 대상 DB가 없으면 등록·안 본 스토어를 0으로 거짓 보고하지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-no-registered-store-'));
    const stateDir = join(home, '.elanous');
    try {
      const fixtureEnv = { ELANOUS_STATE_DIR: stateDir };
      const missingRegistry = await runLogs(['--limit', '1'], home, fixtureEnv);
      expect(missingRegistry.status).toBe(1);
      expect(missingRegistry.stderr).toContain('열 수 있는 로그 스토어 없음');
      expect(missingRegistry.stderr).toContain('scope={"registeredStores":0,"unopenedStores":0}');
      expect(missingRegistry.stderr).toContain('queryStatus={"registeredStores":true}');

      mkdirSync(join(stateDir, 'logs'), { recursive: true });
      writeFileSync(join(stateDir, 'logs', 'instances.json'), JSON.stringify({ instances: [{
        name: 'prod', stateDir, kind: 'prod', configDir: stateDir, pid: 0, startedAt: '',
      }] }));
      const missingDb = await runLogs(['--limit', '1'], home, fixtureEnv);
      expect(missingDb.status).toBe(1);
      expect(missingDb.stderr).toContain('열 수 있는 로그 스토어 없음');
      expect(missingDb.stderr).toContain('scope={"registeredStores":0,"unopenedStores":0}');
      expect(missingDb.stderr).toContain('queryStatus={"registeredStores":true}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('손상되거나 읽을 수 없는 레지스트리는 등록 스토어 0개로 거짓 보고하지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-malformed-registry-'));
    const stateDir = join(home, '.elanous');
    const dbPath = join(stateDir, 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      const fixtureEnv = { ELANOUS_STATE_DIR: stateDir };
      const registryPath = join(stateDir, 'logs', 'instances.json');
      writeFileSync(registryPath, '{ malformed');
      const malformed = await runLogs(['--limit', '1'], home, fixtureEnv);
      expect(malformed.status).toBe(0);
      expect(malformed.stderr).toContain('안 본 스토어 수 미측정');
      expect(malformed.stderr).toContain('scope={}');
      expect(malformed.stderr).toContain('queryStatus={"registeredStores":false}');
      const malformedJson = JSON.parse((await runLogs(['--json', '--limit', '1'], home, fixtureEnv)).stdout.trim().split('\n')[0]!);
      expect(malformedJson._meta).toMatchObject({ type: 'log-query-opened-stores', scope: {}, queryStatus: { registeredStores: false } });

      writeFileSync(registryPath, JSON.stringify({ instances: [
        { name: 'prod', stateDir, kind: 'prod', configDir: stateDir, pid: 0, startedAt: '' },
        { name: 'invalid-entry' },
      ] }));
      const partial = await runLogs(['--limit', '1'], home, fixtureEnv);
      expect(partial.status).toBe(0);
      expect(partial.stderr).toContain('scope={"registeredStores":1,"unopenedStores":0}');
      expect(partial.stderr).toContain('queryStatus={"registeredStores":true}');

      rmSync(registryPath, { force: true });
      mkdirSync(registryPath);
      const unreadable = await runLogs(['--limit', '1'], home, fixtureEnv);
      expect(unreadable.status).toBe(0);
      expect(unreadable.stderr).toContain('안 본 스토어 수 미측정');
      expect(unreadable.stderr).toContain('scope={}');
      expect(unreadable.stderr).toContain('queryStatus={"registeredStores":false}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--explain만으로 축을 모르더라도 발견 목록을 출력한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-axis-discovery-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      const discovery = await runLogs(['--instance', 'prod', '--explain'], home);
      expect(discovery.status).toBe(0);
      expect(discovery.stdout).toContain('알려진 로그 축 2개:');
      expect(discovery.stdout).toContain('dev (5개): dev-pipeline, self-implement');
      expect(discovery.stdout).toContain('pty (10개): pty.takeover');
      expect(discovery.stdout).toContain('축을 고른 뒤: elanous logs --axis <name> --explain');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--axis pty는 접두 밖 네 카테고리를 exact 조회하고 --explain은 세 칸을 낸다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-axis-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-08-01T00:00:00.000Z', category: 'pty.takeover', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: '2026-08-01T00:00:01.000Z', category: 'nexus.pty.write.error', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: '2026-08-01T00:00:02.000Z', category: 'nexus.pty.resize.error', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: '2026-08-01T00:00:03.000Z', category: 'nexus.pty.kill.error', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: '2026-08-01T00:00:04.000Z', category: 'pane-spawner.pty.start', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: '2026-08-01T00:00:05.000Z', category: 'dispatch.continuation.scheduler', event: 'ok' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const axis = await runLogs(['--instance', 'prod', '--axis', 'pty'], home);
      expect(axis.status).toBe(0);
      expect(axis.stdout).toContain('nexus.pty.write.error');
      expect(axis.stdout).toContain('nexus.pty.resize.error');
      expect(axis.stdout).toContain('nexus.pty.kill.error');
      expect(axis.stdout).toContain('pane-spawner.pty.start');
      expect(axis.stdout).not.toContain('dispatch.continuation.scheduler');
      const explain = await runLogs(['--instance', 'prod', '--axis', 'pty', '--explain'], home);
      expect(explain.status).toBe(0);
      expect(explain.stdout).toContain('매핑됨 (pty) 10개:');
      expect(explain.stdout).toContain('dispatch.continuation.scheduler');
      expect(explain.stdout).toContain('매핑됐는데 발화 0 (');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('연 열린 스토어 수는 항상 안내하고 경로는 일반 조회의 기여 인스턴스만 낸다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-opened-store-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const otherState = join(home, 'other-state');
    const otherDbPath = join(otherState, 'logs', 'logs.db');
    const prodStore = new LogStore(prodDbPath);
    prodStore.insertBatch([{ rec: { ts: '2026-08-10T00:00:00.000Z', category: 'contributing.category', event: 'only-prod' }, surface: 'nexus' }]);
    prodStore.close();
    new LogStore(otherDbPath).close();
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--all', '--category', 'contributing.category'], home);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('only-prod');
      expect(text.stderr).toContain('열린 로그 스토어 2개');
      expect(text.stderr).toContain(`log store: ${prodDbPath} (prod)`);
      expect(text.stderr).not.toContain(`log store: ${otherDbPath} (other)`);
      expect(text.stderr.match(/^log store:/gm)).toHaveLength(1);

      const sameNameState = join(home, 'same-name-state');
      const sameNameDbPath = join(sameNameState, 'logs', 'logs.db');
      new LogStore(sameNameDbPath).close();
      writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [
        { name: 'prod', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '' },
        { name: 'prod', stateDir: sameNameState, kind: 'prod', configDir: sameNameState, pid: 0, startedAt: '' },
      ] }));
      const duplicateName = await runLogs(['--all', '--category', 'contributing.category'], home);
      expect(duplicateName.status).toBe(0);
      expect(duplicateName.stderr).toContain(`log store: ${prodDbPath} (prod)`);
      expect(duplicateName.stderr).not.toContain(`log store: ${otherDbPath} (prod)`);
      expect(duplicateName.stderr).not.toContain(`log store: ${sameNameDbPath} (prod)`);
      expect(duplicateName.stderr.match(/^log store:/gm)).toHaveLength(1);
      writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
        name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
      }] }));

      const zero = await runLogs(['--all', '--category', 'absent.category'], home);
      expect(zero.status).toBe(0);
      expect(zero.stdout).toBe('');
      expect(zero.stderr).toContain('열린 로그 스토어 2개');
      expect(zero.stderr).not.toContain('log store:');
      expect(zero.stderr).toContain('(일치하는 로그 없음)');

      const explain = await runLogs(['--instance', 'prod', '--explain'], home);
      expect(explain.status).toBe(0);
      expect(explain.stderr).toContain('열린 로그 스토어 1개');
      expect(explain.stderr).not.toContain('log store:');

      const json = await runLogs(['--all', '--json', '--category', 'absent.category'], home);
      expect(json.status).toBe(0);
      const rows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows).toEqual([
        { _meta: {
          type: 'log-query-opened-stores', stores: [
            { name: 'prod', path: prodDbPath }, { name: 'other', path: otherDbPath },
          ],
          scope: { registeredStores: 1, unopenedStores: 0 }, queryStatus: { registeredStores: true },
        } },
        { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } },
      ]);
      expect(json.stderr).not.toContain('log store:');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('rework recurrence disagreement 필터는 최근 절단 배치 밖의 오래된 일치 행까지 페이지로 채운다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-rework-recurrence-filter-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    const rows = Array.from({ length: 101_002 }, (_, i) => ({
      rec: {
        ts: new Date(Date.UTC(2026, 7, 23, 0, 0, i)).toISOString(),
        category: 'self-implement',
        event: 'rework-budget',
        data: { recurrenceDisagreement: i < 2 },
      },
      surface: 'nexus',
    }));
    writer.insertBatch(rows);
    writer.close();
    try {
      const result = await runLogs(['--instance', 'prod', '--json', '--event', 'rework-budget', '--rework-recurrence-disagreement', 'true', '--limit', '1'], home);
      expect(result.status).toBe(0);
      const jsonRows = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const payloadRows = jsonRows.filter((row) => row._meta == null);
      expect(payloadRows).toHaveLength(1);
      expect(payloadRows[0]).toMatchObject({ event: 'rework-budget' });
      expect(JSON.parse(payloadRows[0]!.data)).toEqual({ recurrenceDisagreement: true });
      expect(result.stderr).toContain('elanous logs: result may be truncated (limitReached=true)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('반환된 제한 행의 런 커버리지는 stderr에만 내고 빈 결과와 JSON NDJSON은 바꾸지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-run-coverage-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-08-10T00:00:00.000Z', category: 'run-coverage', event: 'first', data: { runId: 'run-a' } }, surface: 'nexus' },
      { rec: { ts: '2026-08-10T00:00:01.000Z', category: 'run-coverage', event: 'second', data: { runId: 'run-a' } }, surface: 'nexus' },
      { rec: { ts: '2026-08-10T00:00:02.000Z', category: 'run-coverage', event: 'third', data: { runId: 'run-b' } }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const text = await runLogs(['--instance', 'prod', '--category', 'run-coverage', '--limit', '2'], home);
      expect(text.status).toBe(0);
      expect(text.stderr).toContain('안내: 반환된 2행은 식별 가능한 런 2개에서 왔습니다 (서로 다른 런이 섞임).');
      expect(text.stdout).not.toContain('식별 가능한 런');
      expect(text.stdout).toContain('↳ 상한 2 도달');

      const json = await runLogs(['--instance', 'prod', '--json', '--category', 'run-coverage', '--limit', '2'], home);
      expect(json.status).toBe(0);
      expect(json.stderr).not.toContain('식별 가능한 런');
      expect(json.stderr).toContain('elanous logs: result may be truncated (limitReached=true)');
      const jsonRows = json.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(jsonRows).toEqual([
        expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }),
        { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } },
        expect.objectContaining({ category: 'run-coverage', event: 'second', data: '{"runId":"run-a"}' }),
        expect.objectContaining({ category: 'run-coverage', event: 'third', data: '{"runId":"run-b"}' }),
        { _meta: { type: 'log-query-limit', limitReached: true, requestedLimit: 2, effectiveLimit: 2, nextCursor: expect.any(Number), pagination: 'before-id' } },
      ]);
      expect(jsonRows.filter((row) => row._meta == null)).toEqual([
        expect.objectContaining({ category: 'run-coverage', event: 'second', data: '{"runId":"run-a"}' }),
        expect.objectContaining({ category: 'run-coverage', event: 'third', data: '{"runId":"run-b"}' }),
      ]);
      const payloadRows = (stdout: string) => stdout.split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { _meta?: { type: string }; category?: string; event?: string })
        .filter((entry) => entry._meta == null);
      const cappedPayload = payloadRows(json.stdout);
      expect(cappedPayload).toHaveLength(2);
      expect(cappedPayload.map((entry) => entry.event)).toEqual(['second', 'third']);
      expect(cappedPayload.every((entry) => entry.category === 'run-coverage')).toBe(true);

      const uncapped = await runLogs(['--instance', 'prod', '--json', '--category', 'run-coverage', '--limit', '4'], home);
      expect(uncapped.status).toBe(0);
      expect(uncapped.stderr).not.toContain('elanous logs: result may be truncated');
      const uncappedPayload = payloadRows(uncapped.stdout);
      expect(uncappedPayload).toHaveLength(3);
      expect(uncappedPayload.map((entry) => entry.event)).toEqual(['first', 'second', 'third']);
      expect(uncappedPayload.every((entry) => entry._meta == null)).toBe(true);

      const empty = await runLogs(['--instance', 'prod', '--category', 'absent-run-coverage'], home);
      expect(empty.status).toBe(0);
      expect(empty.stderr).toContain('(일치하는 로그 없음)');
      expect(empty.stderr).not.toContain('식별 가능한 런');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--json은 같은 ts·category·event의 다중 표면 그룹 메타를 내고 행 자체와 사람용 출력은 접지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-multi-surface-duplicate-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status' }, surface: 'harness' },
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'run-status' }, surface: 'harness:self-implement' },
      { rec: { ts: '2026-08-23T00:00:01.000Z', category: 'self-implement', event: 'single-surface' }, surface: 'harness' },
    ]);
    writer.close();
    try {
      const json = await runLogs(['--instance', 'prod', '--json', '--category', 'self-implement', '--limit', '10'], home);
      expect(json.status).toBe(0);
      const rows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const payloadRows = rows.filter((row) => row._meta == null);
      const duplicateMeta = rows.find((row) => row._meta?.type === 'log-query-multi-surface-duplicates');
      const openedStoresMeta = rows.find((row) => row._meta?.type === 'log-query-opened-stores');
      expect(openedStoresMeta).toEqual(expect.objectContaining({
        _meta: expect.objectContaining({ type: 'log-query-opened-stores' }),
      }));
      expect(duplicateMeta).toEqual({ _meta: {
        type: 'log-query-multi-surface-duplicates',
        duplicateGroupCount: 1,
        surfaceKindCount: 2,
        surfaces: ['harness', 'harness:self-implement'],
        groups: [{
          ts: '2026-08-23T00:00:00.000Z',
          category: 'self-implement',
          event: 'run-status',
          surfaces: ['harness', 'harness:self-implement'],
          rowCount: 2,
        }],
      } });
      expect(payloadRows).toHaveLength(3);
      expect(payloadRows.filter((row) => row.event === 'run-status').map((row) => row.surface).sort())
        .toEqual(['harness', 'harness:self-implement']);

      const singleSurface = await runLogs(['--instance', 'prod', '--json', '--event', 'single-surface', '--limit', '10'], home);
      expect(singleSurface.status).toBe(0);
      const singleRows = singleSurface.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(singleRows.find((row) => row._meta?.type === 'log-query-multi-surface-duplicates')).toEqual({ _meta: {
        type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [],
      } });
      expect(singleRows.filter((row) => row._meta == null)).toHaveLength(1);

      const text = await runLogs(['--instance', 'prod', '--category', 'self-implement', '--limit', '10'], home);
      expect(text.status).toBe(0);
      expect(text.stdout).not.toContain('log-query-multi-surface-duplicates');
      expect(text.stdout).toContain('[harness] self-implement run-status');
      expect(text.stdout).toContain('[harness:self-implement] self-implement run-status');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('follow는 열린 스토어 개수를 배너에서 정확히 한 번만 안내한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-follow-opened-store-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    const child = spawn(process.execPath, ['bin/elanous.mjs', 'logs', '--instance', 'prod', '--follow'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`follow banner timeout: ${stderr}`)), 10_000);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
          if (stderr.includes('--- following 열린 로그 스토어 1개 (Ctrl-C 종료) ---')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('error', reject);
      });
      expect(stderr.match(/열린 로그 스토어 1개/g)).toHaveLength(1);
      expect(stderr).not.toContain('\n열린 로그 스토어 1개\n');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 --event 오타는 찍힌 가까운 이름을 stderr에만 내고 저장소 부재를 단정하지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-name-hint-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: new Date().toISOString(), category: 'goal-author', event: 'plan-sizing' }, surface: 'nexus' },
      { rec: { ts: new Date().toISOString(), category: 'goal-author', event: 'https://example.com/path' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const typo = await runLogs(['--instance', 'prod', '--event', 'plan-sizin'], home);
      expect(typo.status).toBe(0);
      expect(typo.stdout).toBe('');
      expect(typo.stderr).toContain('(일치하는 로그 없음)');
      expect(typo.stderr).toContain('이 조회 범위에서 본 적 없다');
      expect(typo.stderr).toContain("'plan-sizing'");
      expect(typo.stderr).not.toContain('https://example.com/path');
      expect(typo.stderr).not.toContain('이 저장소에 없다');
      expect(typo.stderr).not.toContain('없는 이름');

      const json = await runLogs(['--instance', 'prod', '--json', '--event', 'plan-sizin'], home);
      expect(json.status).toBe(0);
      const jsonRows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(jsonRows).toEqual([
        expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }),
        { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } },
      ]);
      expect(json.stderr).not.toContain('이 조회 범위에서 본 적 없다');

      const present = await runLogs(['--instance', 'prod', '--event', 'plan-sizing'], home);
      expect(present.status).toBe(0);
      expect(present.stdout).toContain('plan-sizing');
      expect(present.stderr).not.toContain('이 조회 범위에서 본 적 없다');
      expect(present.stderr).not.toContain('가까운 관측 이름');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('찍힌 이름이 없는 창의 0건 --event는 안내 불가를 말하고 빈 목록만 남기지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-name-hint-empty-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      const empty = await runLogs(['--instance', 'prod', '--event', 'zzz-no-such-event-xyz'], home);
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe('');
      expect(empty.stderr).toContain('이 조회 범위에서 본 적 없다');
      expect(empty.stderr).toContain('가까운 관측 이름을 안내할 수 없다');
      expect(empty.stderr).not.toContain('이 저장소에 없다');
      expect(empty.stderr).toContain('정적');
      expect(empty.stderr).toContain('못 봅니다');
      expect(empty.stderr).not.toContain('내지 않');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 단일 --event 는 목록에 있는 이름의 판정을 stderr 에 소비한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-verdict-known-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      const known = await runLogs(['--instance', 'prod', '--event', 'plan-sizing'], home);
      expect(known.status).toBe(0);
      expect(known.stderr).toContain('이 저장소가 냅니다');
      expect(known.stderr).toContain("'plan-sizing'");
      expect(known.stderr).not.toContain('내지 않');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 다중 --event 는 판정을 내지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-verdict-multi-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      const multi = await runLogs(['--instance', 'prod', '--event', 'plan-sizing,ledger'], home);
      expect(multi.status).toBe(0);
      expect(multi.stderr).toContain('(일치하는 로그 없음)');
      expect(multi.stderr).not.toContain('이 저장소가 냅니다');
      expect(multi.stderr).not.toContain('정적 목록');
      expect(multi.stderr).not.toContain('내지 않');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 --event 선행·후행 쉼표와 빈 토큰은 판정을 내지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-verdict-comma-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    try {
      for (const event of ['plan-sizing,', ',plan-sizing', 'plan-sizing,,other', 'plan-sizing, ,ledger']) {
        const result = await runLogs(['--instance', 'prod', '--event', event], home);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('(일치하는 로그 없음)');
        expect(result.stderr).not.toContain('이 저장소가 냅니다');
        expect(result.stderr).not.toContain('정적 목록');
        expect(result.stderr).not.toContain('내지 않');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 카테고리 조회는 저장소에 없는 이름만 안내하고 존재하는 이름은 안내하지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-category-candidate-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: new Date().toISOString(), category: 'present.prefix.child', event: 'ok' }, surface: 'nexus' },
      { rec: { ts: new Date().toISOString(), category: 'present.exact', event: 'ok' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const missing = await runLogs(['--instance', 'prod', '--category', 'missing.category', '--event', 'none'], home);
      expect(missing.status).toBe(0);
      expect(missing.stderr).toContain('관측된 적 없습니다');
      expect(missing.stderr).toContain("'missing.category'");

      const present = await runLogs(['--instance', 'prod', '--category', 'present.prefix', '--event', 'none'], home);
      expect(present.status).toBe(0);
      expect(present.stderr).not.toContain('관측된 적 없습니다');

      const independentlyPresent = await runLogs([
        '--instance', 'prod', '--category', 'present.prefix', '--exact-category', 'present.exact', '--event', 'none',
      ], home);
      expect(independentlyPresent.status).toBe(0);
      expect(independentlyPresent.stderr).not.toContain('관측된 적 없습니다');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('0건 prod 조회는 다른 test 인스턴스의 안전하게 인용된 재조회 힌트를 출력하고 JSON은 불변이다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-cli-'));
    const testState = join(home, 'fixture-state');
    const dbPath = join(testState, 'logs', 'logs.db');
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    new LogStore(prodDbPath).close();
    const writer = new LogStore(dbPath, { instance: 'test:fixture' });
    writer.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'wanted', event: "foo bar * 'single' \"double\"" }, surface: 'nexus' }]);
    writer.close();
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:fixture', stateDir: testState, kind: 'test', configDir: testState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--grep', "foo bar * 'single' \"double\""], home);
      expect(text.status).toBe(0);
      expect(text.stdout).toBe('');
      expect(text.stderr).toContain('(일치하는 로그 없음)');
      expect(text.stderr).toContain('test:fixture 1건');
      expect(text.stderr).toContain("--grep 'foo bar * '\\''single'\\'' \"double\"'");
      expect(text.stderr).toContain('OR 검색이 아니라 단일 연속 문자열 검색');
      const json = await runLogs(['--json', '--grep', "foo bar * 'single' \"double\""], home);
      expect(json.status).toBe(0);
      const jsonRows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(jsonRows).toEqual([
        expect.objectContaining({
          _meta: expect.objectContaining({ type: 'log-query-opened-stores' }),
        }),
        { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } },
      ]);
      expect(jsonRows.filter((row) => row._meta == null)).toHaveLength(0);
      expect(json.stderr).not.toContain('(일치하는 로그 없음)');
      expect(json.stderr).not.toContain('OR 검색이 아니라 단일 연속 문자열 검색');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runLogsCli wiring은 비현재 스코프 0건에서 caller seam을 읽지 않고 불확실성 힌트를 stderr에 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-logs-render-gated-wiring-'));
    const dbPath = join(root, 'other', 'logs', 'logs.db');
    new LogStore(dbPath).close();
    const errors: string[] = [];
    const error = console.error;
    let readCalls = 0;
    try {
      console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
      await expect(runLogsCli(
        { all: true, category: 'dashboard.chat.stream' },
        {
          // ⛔⭐ 여기서 실 `logsDbPath()` 를 쓰면 «그 DB 에 매칭 행이 있을 때 0건 분기가 안 돌아»
          //   이 검사가 조용히 아무것도 안 잰다(#7480 재리뷰 must-fix · 내가 한 번 그렇게 만들었다).
          //   ⇒ 이 검사는 «완전 격리»로 둔다. 「현재 ⊕ 외부가 섞인」 판정은 순수 함수
          //     `nonCurrentScopeNames` 검사가 결정론으로 문다(아래).
          resolveTargets: () => ({ targets: [
            { name: 'current', dbPath: join(root, 'current', 'logs', 'logs.db') },
            { name: 'other', dbPath },
          ] }),
          readRender: () => { readCalls += 1; return true; },
        },
      )).resolves.toBe(0);
      const stderr = errors.join('\n');
      expect(readCalls).toBe(0);
      expect(stderr).toContain('렌더 억제 상태는 확인하지 못했다');
      // ⭐ 실제 이름이 값으로 오고, 채울 자리를 남긴 명령은 없다(#7475 must-fix).
      expect(stderr).toContain('other');
      expect(stderr).not.toMatch(/<[^>]+>/);
      expect(stderr).not.toContain('빈 결과라면 실제로 이벤트가 없는 것이다');
      expect(stderr).toMatch(/렌더 억제 상태는 확인하지 못했다/);
    } finally {
      console.error = error;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('JSON 메타는 비-harness 두 표면의 동일 ts·category·event 그룹을 알리고 행은 접지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-multi-surface-any-surface-'));
    const stateDir = join(home, '.elanous');
    const writer = new LogStore(join(stateDir, 'logs', 'logs.db'));
    writer.insertBatch([
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'same-event', event: 'duplicated' }, surface: 'telegram' },
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'same-event', event: 'duplicated' }, surface: 'discord' },
      { rec: { ts: '2026-08-23T00:00:01.000Z', category: 'same-event', event: 'single' }, surface: 'telegram' },
    ]);
    writer.close();
    try {
      const result = await runLogs(['--instance', 'prod', '--json', '--exact-category', 'same-event', '--limit', '10'], home, { ELANOUS_STATE_DIR: stateDir });
      expect(result.status).toBe(0);
      const jsonRows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const duplicateMeta = jsonRows.find((row) => row._meta?.type === 'log-query-multi-surface-duplicates');
      expect(duplicateMeta).toEqual({ _meta: {
        type: 'log-query-multi-surface-duplicates',
        duplicateGroupCount: 1,
        surfaceKindCount: 2,
        surfaces: ['discord', 'telegram'],
        groups: [{
          ts: '2026-08-23T00:00:00.000Z',
          category: 'same-event',
          event: 'duplicated',
          surfaces: ['discord', 'telegram'],
          rowCount: 2,
        }],
      } });
      const payloadRows = jsonRows.filter((row) => row._meta == null);
      expect(payloadRows).toHaveLength(3);
      expect(payloadRows.map((row) => row.surface).sort()).toEqual(['discord', 'telegram', 'telegram']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('JSON 메타는 비-harness 단일 표면 입력에서도 중복 그룹 0을 명시한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-multi-surface-single-non-harness-'));
    const stateDir = join(home, '.elanous');
    const writer = new LogStore(join(stateDir, 'logs', 'logs.db'));
    writer.insertBatch([
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'single-surface', event: 'first' }, surface: 'telegram' },
      { rec: { ts: '2026-08-23T00:00:01.000Z', category: 'single-surface', event: 'second' }, surface: 'telegram' },
    ]);
    writer.close();
    try {
      const result = await runLogs(['--instance', 'prod', '--json', '--exact-category', 'single-surface', '--limit', '10'], home, { ELANOUS_STATE_DIR: stateDir });
      expect(result.status).toBe(0);
      const jsonRows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const duplicateMeta = jsonRows.find((row) => row._meta?.type === 'log-query-multi-surface-duplicates');
      expect(duplicateMeta).toEqual({ _meta: {
        type: 'log-query-multi-surface-duplicates',
        duplicateGroupCount: 0,
        surfaceKindCount: 0,
        surfaces: [],
        groups: [],
      } });
      expect(jsonRows.filter((row) => row._meta == null)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rework recurrence disagreement 필터는 rework-budget data 값으로 단일 조회 표본을 좁힌다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-rework-recurrence-disagreement-'));
    const stateDir = join(home, '.elanous');
    const writer = new LogStore(join(stateDir, 'logs', 'logs.db'));
    writer.insertBatch([
      { rec: { ts: '2026-08-23T00:00:00.000Z', category: 'self-implement', event: 'rework-budget', data: { runId: 'same', recurrenceDisagreement: false, recurrenceDisagreementTerminalUnconvergeable: false } }, surface: 'harness:self-implement' },
      { rec: { ts: '2026-08-23T00:00:01.000Z', category: 'self-implement', event: 'rework-budget', data: { runId: 'split', recurrenceDisagreement: true, recurrenceDisagreementTerminalUnconvergeable: true } }, surface: 'harness:self-implement' },
      { rec: { ts: '2026-08-23T00:00:02.000Z', category: 'self-implement', event: 'other', data: { recurrenceDisagreement: true } }, surface: 'harness:self-implement' },
    ]);
    writer.close();
    try {
      const result = await runLogs(['--exact-category', 'self-implement', '--event', 'rework-budget', '--rework-recurrence-disagreement', 'true', '--json', '--json-data'], home, { ELANOUS_STATE_DIR: stateDir });
      expect(result.status).toBe(0);
      const rows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => row._meta === undefined)).toEqual([
        expect.objectContaining({
          event: 'rework-budget',
          data: expect.objectContaining({ runId: 'split', recurrenceDisagreement: true, recurrenceDisagreementTerminalUnconvergeable: true }),
        }),
      ]);
      expect(result.stdout).not.toContain('"same"');
      expect(result.stderr).not.toContain('(일치하는 로그 없음)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rework recurrence disagreement 필터 helper는 rework-budget 이벤트의 boolean 값만 매칭한다', async () => {
    const base: LogStoreRow = {
      id: 1, ts: '2026-08-23T00:00:00.000Z', ts_ms: 0, level: 'debug', instance: 'test', surface: 'nexus', category: 'self-implement', event: 'rework-budget', session_id: null, trace_id: null, data: '{"recurrenceDisagreement":true}',
    };
    expect(matchesReworkRecurrenceDisagreement(base, true)).toBeTrue();
    expect(matchesReworkRecurrenceDisagreement(base, false)).toBeFalse();
    expect(matchesReworkRecurrenceDisagreement({ ...base, event: 'other' }, true)).toBeFalse();
    expect(matchesReworkRecurrenceDisagreement({ ...base, data: '{"recurrenceDisagreement":null}' }, true)).toBeFalse();
    expect(matchesReworkRecurrenceDisagreement(base, undefined)).toBeTrue();
  });

  it('runLogsCli는 0건 space 조회에서 파생 grep까지 뺀 한 번의 재계수만 하고, 비빈 결과에는 재계수하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-logs-filter-relaxation-wiring-'));
    const emptyDbPath = join(root, 'empty', 'logs', 'logs.db');
    const presentDbPath = join(root, 'present', 'logs', 'logs.db');
    new LogStore(emptyDbPath).close();
    const writer = new LogStore(presentDbPath);
    writer.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'present', event: 'ok' }, surface: 'harness:self-implement' }]);
    writer.close();
    const errors: string[] = [];
    const error = console.error;
    try {
      console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
      const emptyCalls: LogQuery[] = [];
      await expect(runLogsCli({ space: 'run-123' }, {
        resolveTargets: () => ({ targets: [{ name: 'empty', dbPath: emptyDbPath }] }),
        countMatching: (candidate) => { emptyCalls.push(candidate); return 6; },
      })).resolves.toBe(0);
      expect(errors.join('\n')).toContain('--space 제외 6건');
      expect(emptyCalls).toEqual([{ surfaces: undefined, grep: undefined }]);

      errors.length = 0;
      let presentCalls = 0;
      await expect(runLogsCli({ space: 'self-implement' }, {
        resolveTargets: () => ({ targets: [{ name: 'present', dbPath: presentDbPath }] }),
        countMatching: () => { presentCalls += 1; return 0; },
      })).resolves.toBe(0);
      expect(presentCalls).toBe(0);
      expect(errors.join('\n')).not.toContain('적용 필터를 하나씩 제외한 일치 수');
    } finally {
      console.error = error;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('--instance와 --all의 비현재 스코프 0건 조회는 발화 ON 단언 대신 억제 상태 미확인을 출력한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-render-gated-instance-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const otherState = join(home, 'other-state');
    const otherDbPath = join(otherState, 'logs', 'logs.db');
    new LogStore(prodDbPath).close();
    new LogStore(otherDbPath).close();
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
    }] }));
    try {
      for (const args of [
        ['--instance', 'other', '--category', 'dashboard.chat.stream'],
        ['--all', '--category', 'dashboard.chat.stream'],
      ]) {
        const result = await runLogs(args, home);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain('렌더 억제 상태는 확인하지 못했다');
        expect(result.stderr).not.toContain('빈 결과라면 실제로 이벤트가 없는 것이다');
        // ⭐ 실물 CLI 에서도 채울 자리를 남긴 명령이 없어야 한다(#7475 must-fix).
        expect(result.stderr).not.toMatch(/<[^>]+>/);
        expect(result.stderr).toContain('other');
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('실제 연속 문자열과 매치되는 나열형 --grep도 레코드는 stdout, 경고는 stderr에 항상 출력한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-grep-phrase-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([{
      rec: { ts: new Date().toISOString(), category: 'headless', event: 'headless OR progress' }, surface: 'nexus',
    }]);
    writer.close();
    try {
      const result = await runLogs(['--grep', 'headless OR progress'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('headless OR progress');
      expect(result.stderr).toContain('OR 검색이 아니라 단일 연속 문자열 검색');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('긴 데이터 행의 절단은 stdout 형식을 유지한 채 stderr로 한 번만 알리고 JSON은 알리지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-truncation-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    const longData = JSON.stringify({ why: 'x'.repeat(240) });
    writer.insertBatch([
      { rec: { ts: '2026-07-30T00:00:00.000Z', category: 'truncate', event: 'long', data: longData }, surface: 'nexus' },
      { rec: { ts: '2026-07-30T00:00:01.000Z', category: 'truncate', event: 'short', data: 'short' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      // ⛔ `--instance prod` 로 **단일 스토어로 고정**한다(리뷰 must-fix) — `runLogs` 는
      //    `cwd: process.cwd()` 로 CLI 를 띄우므로 실행 트리에 다른 인스턴스가 등록돼 있으면
      //    **연합 조회**가 되어 ①인스턴스 태그가 붙고 ②남의 스토어의 `category=truncate` 레코드가
      //    섞인다. 둘 다 이 테스트를 **실행 환경에 의존하게** 만든다.
      const text = await runLogs(['--instance', 'prod', '--category', 'truncate'], home);
      const storedLongData = JSON.stringify(longData);
      const storedShortData = JSON.stringify('short');
      const truncatedData = ` ${storedLongData}`.slice(0, 200);
      expect(text.status).toBe(0);
      // ⭐ `--instance prod` 로 단일 스토어를 고정했으므로 태그는 붙지 않고 레코드도 이 둘뿐이다.
      //    그래도 **전체 문자열 동등 비교는 쓰지 않는다** — 이 테스트가 고정해야 하는 것은
      //    **절단 형식**(긴 줄이 `…` 로 끝나고 짧은 줄은 안 끝난다)이고, 접두(시각·레벨·태그)까지
      //    묶어 고정하면 무관한 표시 변경이 이 테스트를 깨뜨려 **절단 회귀와 구별되지 않는다**.
      //    ⚠️ 초판은 접두까지 고정했고, 그래서 **다른 트리에서 1 fail** 이 났다(태그 유무).
      const textLines = text.stdout.split('\n').filter((line) => line.length > 0);
      expect(textLines).toHaveLength(2);
      expect(textLines[0]).toContain(`[nexus] truncate long${truncatedData}…`);
      expect(textLines[0]!.endsWith('…')).toBe(true);
      expect(textLines[1]).toContain(`[nexus] truncate short ${storedShortData}`);
      expect(textLines[1]!.endsWith('…')).toBe(false);
      const warning = '경고: 1줄이 잘렸습니다. 전체를 보려면 --json --json-data 를 쓰세요.';
      // ⛔ stderr **전체 동등 비교도** 환경 의존이다 — 같은 조회가 트리에 따라 다른 안내
      //    (다른 test 인스턴스 재조회 힌트 등)를 함께 낸다. 이 테스트가 고정할 것은
      //    **경고가 정확히 한 번 나온다**는 것이므로 그것만 단언한다.
      expect(text.stderr).toContain(warning);
      expect(text.stderr.split(warning).length - 1).toBe(1);

      const json = await runLogs(['--instance', 'prod', '--json', '--json-data', '--category', 'truncate'], home);
      expect(json.status).toBe(0);
      // ⭐ 첫 행만 파싱하면 전체가 순수 NDJSON 인지 보장하지 못한다(리뷰 should-fix).
      const jsonLines = json.stdout.split('\n').filter((line) => line.length > 0);
      const parsed = jsonLines.map((line) => JSON.parse(line) as { data?: unknown; _meta?: unknown });
      expect(parsed).toHaveLength(4);
      expect(parsed[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(parsed[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(parsed[2]!.data).toBe(longData);
      expect(json.stderr).not.toContain('잘렸습니다');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('저장 절단 마커가 있는 긴 데이터는 JSON 복구 안내 대신 비복구 안내를 낸다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-write-truncation-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    const storedData = JSON.stringify({ why: `${'x'.repeat(240)}«+100c»` });
    writer.insertBatch([{
      rec: { ts: '2026-07-30T00:00:00.000Z', category: 'write-truncate', event: 'persisted', data: storedData }, surface: 'nexus',
    }]);
    writer.close();
    try {
      const text = await runLogs(['--instance', 'prod', '--category', 'write-truncate'], home);
      const warning = '경고: 1줄은 저장 전에 잘렸습니다. --json --json-data 로도 원본을 복원할 수 없습니다.';
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('…');
      expect(text.stderr).toContain(warning);
      expect(text.stderr).not.toContain('전체를 보려면 --json --json-data 를 쓰세요.');

      const json = await runLogs(['--instance', 'prod', '--json', '--json-data', '--category', 'write-truncate'], home);
      expect(json.status).toBe(0);
      const jsonRows = json.stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as { data?: unknown; _meta?: unknown });
      expect(jsonRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(jsonRows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(jsonRows[2]!.data).toBe(storedData);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('짧은 데이터만 있으면 절단 경고를 내지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-no-truncation-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'short-data', event: 'ok', data: 'short' }, surface: 'nexus' }]);
    writer.close();
    try {
      // ⛔ 형제 테스트와 같은 이유로 단일 스토어 고정 — 연합이면 다른 인스턴스의
      //    `category=short-data` 장문 레코드가 섞여 "경고 없음" 단언이 깨진다(리뷰 must-fix).
      const result = await runLogs(['--instance', 'prod', '--category', 'short-data'], home);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('잘렸습니다');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--event에 카테고리를 주어 0건이면 힌트는 stderr에만 출력하고 JSON stdout은 비운다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-event-category-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([{
      rec: { ts: new Date().toISOString(), category: 'dev-pipeline', event: 'plan' }, surface: 'nexus',
    }]);
    writer.close();
    try {
      const result = await runLogs(['--event', 'dev-pipeline'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('카테고리와 이벤트를 혼동했을 수 있습니다');
      expect(result.stderr).toContain('--category');

      const json = await runLogs(['--json', '--event', 'dev-pipeline'], home);
      expect(json.status).toBe(0);
      expect(json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }),
        { _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } },
      ]);
      expect(json.stderr).toContain('카테고리와 이벤트를 혼동했을 수 있습니다');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--json 파이프는 느린 소비자에도 파일 출력과 같은 모든 NDJSON 행을 전달한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-json-pipe-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const expectedCount = 200;
    const writer = new LogStore(dbPath);
    writer.insertBatch(Array.from({ length: expectedCount }, (_, index) => ({
      rec: { ts: new Date(Date.now() + index).toISOString(), category: 'pipe', event: String(index), data: { value: 'x'.repeat(512) } },
      surface: 'nexus',
    })));
    writer.close();
    try {
      const file = await runLogs(['--instance', 'prod', '--json', '--category', 'pipe', '--limit', String(expectedCount)], home);
      expect(file.status).toBe(0);
      const fileLines = file.stdout.trim().split('\n').filter(Boolean);
      expect(fileLines).toHaveLength(expectedCount + 3);
      const fileRows = fileLines.map((line) => JSON.parse(line));
      expect(fileRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(fileRows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(fileRows.slice(2, -1).map((row) => row.event)).toHaveLength(expectedCount);
      expect(fileRows.at(-1)).toEqual({
        _meta: {
          type: 'log-query-limit', limitReached: true, requestedLimit: expectedCount, effectiveLimit: expectedCount,
          nextCursor: fileRows[2]!.id, pagination: 'before-id',
        },
      });

      const outputPath = join(home, 'slow-consumer.ndjson');
      const pipeline = spawnSync('sh', ['-c', `${JSON.stringify(process.execPath)} bin/elanous.mjs logs --instance prod --json --category pipe --limit ${expectedCount} | while IFS= read -r line; do printf '%s\\n' "$line"; sleep 0.001; done > ${JSON.stringify(outputPath)}`], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000,
      });
      expect(pipeline.status).toBe(0);
      const pipedLines = readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(pipedLines).toHaveLength(fileLines.length);
      const pipedRows = pipedLines.map((line) => JSON.parse(line));
      expect(pipedRows.slice(0, -1).map((row) => row.event)).toEqual(fileRows.slice(0, -1).map((row) => row.event));
      expect(pipedRows.at(-1)).toEqual(fileRows.at(-1));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--json 상한 메타는 레코드 JSONL과 같은 완료 대기 stdout write에 포함된다', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elanous-logs-json-limit-write-'));
    const dbPath = join(repo, '.elanous-test', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch(Array.from({ length: 2 }, (_, index) => ({
      rec: { ts: new Date(Date.UTC(2026, 6, 30, 0, 0, index)).toISOString(), category: 'write-batch', event: String(index) }, surface: 'nexus',
    })));
    writer.close();
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const writes: string[] = [];
    const cwd = process.cwd();
    try {
      process.chdir(repo);
      process.stdout.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        writes.push(String(chunk));
        callback?.();
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      await expect(runLogsCli({ test: true, json: true, category: 'write-batch', limit: '1' })).resolves.toBe(0);
      expect(writes).toHaveLength(2);
      const openedStoreMeta = writes[0]!.trim().split('\n').map((line) => JSON.parse(line));
      expect(openedStoreMeta).toEqual([expect.objectContaining({
        _meta: expect.objectContaining({ type: 'log-query-opened-stores' }),
      })]);
      const rows = writes[1]!.trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(rows[1]!.category).toBe('write-batch');
      expect(rows[2]).toEqual({
        _meta: {
          type: 'log-query-limit', limitReached: true, requestedLimit: 1, effectiveLimit: 1,
          nextCursor: rows[1]!.id, pagination: 'before-id',
        },
      });
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('--json은 단일·연합 모두 독립 파싱 가능한 같은 레코드 NDJSON을 순서대로 출력한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-json-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const instanceState = join(home, 'instance-state');
    const instanceDbPath = join(instanceState, 'logs', 'logs.db');
    const timestamp = '2026-07-28T09:00:00.000Z';
    const record = { ts: timestamp, category: 'shape', event: 'stable', data: { verdict: 'fixture' } };
    const writeFixture = (dbPath: string, instance: string) => {
      const store = new LogStore(dbPath, { instance });
      store.insertBatch([{ rec: record, surface: 'nexus' }]);
      store.close();
      const db = new Database(dbPath);
      db.query('INSERT INTO logs (ts, ts_ms, level, instance, surface, category, event, session_id, trace_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(timestamp, Date.parse(timestamp), 'info', instance, 'nexus', 'shape', 'plain', null, null, 'not-json');
      db.close();
    };
    writeFixture(prodDbPath, 'prod');
    writeFixture(instanceDbPath, 'test:fixture');
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:fixture', stateDir: instanceState, kind: 'test', configDir: instanceState, pid: 0, startedAt: '',
    }] }));
    try {
      const single = await runLogs(['--json', '--category', 'shape'], home);
      const federated = await runLogs(['--json', '--all', '--include-test', '--category', 'shape'], home);
      const parsedData = await runLogs(['--json', '--json-data', '--category', 'shape'], home);
      expect(single.status).toBe(0);
      expect(federated.status).toBe(0);
      expect(parsedData.status).toBe(0);

      const parseNdjson = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const singleRows = parseNdjson(single.stdout);
      const federatedRows = parseNdjson(federated.stdout);
      const parsedDataRows = parseNdjson(parsedData.stdout);
      const singlePayloadRows = singleRows.filter((row) => row._meta == null);
      const federatedPayloadRows = federatedRows.filter((row) => row._meta == null);
      const parsedDataPayloadRows = parsedDataRows.filter((row) => row._meta == null);
      expect(singleRows).toHaveLength(4);
      expect(federatedRows).toHaveLength(6);
      expect(singleRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(federatedRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(singleRows[1]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-multi-surface-duplicates' }) }));
      expect(federatedRows[1]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-multi-surface-duplicates' }) }));
      expect(singlePayloadRows).toEqual(federatedPayloadRows.filter((row) => row.instance === 'prod'));
      expect(federatedPayloadRows.map((row) => row.instance)).toEqual(['prod', 'test:fixture', 'prod', 'test:fixture']);
      expect(federatedPayloadRows.map((row) => row.event)).toEqual(['stable', 'stable', 'plain', 'plain']);
      expect(federatedPayloadRows.map((row) => row.ts)).toEqual([timestamp, timestamp, timestamp, timestamp]);
      expect(singlePayloadRows[0]!.data).toBe('{"verdict":"fixture"}');
      expect(parsedDataPayloadRows[0]!.data).toEqual({ verdict: 'fixture' });
      expect(parsedDataPayloadRows[0]!.data.verdict).toBe('fixture');
      expect(parsedDataPayloadRows[1]!.data).toBe('not-json');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('손상된 다른 인스턴스 탐침은 빈 결과와 성공 종료코드를 바꾸지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-corrupt-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const corruptState = join(home, 'corrupt-state');
    const corruptDbPath = join(corruptState, 'logs', 'logs.db');
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    mkdirSync(join(corruptState, 'logs'), { recursive: true });
    new LogStore(prodDbPath).close();
    writeFileSync(corruptDbPath, 'not a sqlite database');
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:corrupt', stateDir: corruptState, kind: 'test', configDir: corruptState, pid: 0, startedAt: '',
    }] }));
    try {
      const result = await runLogs(['--instance', 'prod', '--grep', 'absent'], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('(일치하는 로그 없음)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('연합 조회에서 한 인스턴스 읽기가 실패하면 사람·JSON 산출에 이름을 싣고 커서와 같은 종료값 2를 낸다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-unreadable-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const unreadableState = join(home, 'unreadable-state');
    const unreadableDbPath = join(unreadableState, 'logs', 'logs.db');
    const seed = (dbPath: string, instance: string) => {
      const store = new LogStore(dbPath, { instance });
      store.insertBatch([{ rec: { ts: '2026-08-08T00:00:00.000Z', category: 'unreadable', event: instance }, surface: 'nexus' }]);
      store.close();
    };
    seed(prodDbPath, 'prod');
    mkdirSync(join(unreadableState, 'logs'), { recursive: true });
    new Database(unreadableDbPath).close(); // Opens read-only but has no logs table, so query() fails after opening.
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:unreadable', stateDir: unreadableState, kind: 'test', configDir: unreadableState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--all', '--include-test', '--category', 'unreadable'], home);
      expect(text.status).toBe(2);
      expect(text.stdout).toContain('⚠️ 못 읽은 인스턴스 1개: test:unreadable');
      expect(text.stdout).toContain('prod');
      expect(text.stdout).not.toContain('log-query-unreadable-instances');
      expect(text.stdout).not.toContain('"_meta"');

      const json = await runLogs(['--all', '--include-test', '--json', '--category', 'unreadable'], home);
      expect(json.status).toBe(2);
      const rows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(rows[1]).toEqual({
        _meta: { type: 'log-query-unreadable-instances', unreadableInstanceCount: 1, unreadableInstances: ['test:unreadable'] },
      });
      expect(rows[2]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(rows.slice(3)).toEqual([expect.objectContaining({ instance: 'prod', category: 'unreadable' })]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('연합 조회의 모든 인스턴스를 읽으면 실패 머리·JSON 필드 없이 종료값 0을 유지한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-readable-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const instanceState = join(home, 'readable-state');
    const instanceDbPath = join(instanceState, 'logs', 'logs.db');
    const seed = (dbPath: string, instance: string) => {
      const store = new LogStore(dbPath, { instance });
      store.insertBatch([{ rec: { ts: '2026-08-08T00:00:00.000Z', category: 'readable', event: instance }, surface: 'nexus' }]);
      store.close();
    };
    seed(prodDbPath, 'prod');
    seed(instanceDbPath, 'test:readable');
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:readable', stateDir: instanceState, kind: 'test', configDir: instanceState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--all', '--include-test', '--category', 'readable'], home);
      expect(text.status).toBe(0);
      expect(text.stdout).not.toContain('못 읽은 인스턴스');
      expect(text.stdout).toContain('prod');
      expect(text.stdout).toContain('test:readable');

      const json = await runLogs(['--all', '--include-test', '--json', '--category', 'readable'], home);
      expect(json.status).toBe(0);
      const rows = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows).toHaveLength(4);
      expect(rows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(rows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(rows).not.toContainEqual(expect.objectContaining({
        _meta: expect.objectContaining({ type: 'log-query-unreadable-instances' }),
      }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('연합 JSON 커서는 중간에 소진된 인스턴스를 보존하며 3쪽 이상에서 누락·중복·순서 역행 없이 이어진다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-federated-cursor-'));
    const prodDbPath = join(home, '.elanous', 'logs', 'logs.db');
    const instanceState = join(home, 'fixture-state');
    const instanceDbPath = join(instanceState, 'logs', 'logs.db');
    const seed = (dbPath: string, instance: string, count: number, startSecond: number) => {
      const store = new LogStore(dbPath, { instance });
      store.insertBatch(Array.from({ length: count }, (_, index) => ({
        rec: { ts: new Date(Date.UTC(2026, 6, 30, 0, 0, startSecond + index)).toISOString(), category: 'federated-page', event: `${instance}-${index}` }, surface: 'nexus',
      })));
      store.close();
    };
    seed(prodDbPath, 'prod', 9, 0);
    seed(instanceDbPath, 'test:fixture', 2, 9);
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'test:fixture', stateDir: instanceState, kind: 'test', configDir: instanceState, pid: 0, startedAt: '',
    }] }));
    try {
      type JsonLogRow = {
        id: number;
        instance: string;
        ts: string;
        category: string;
        event: string;
        _meta?: { type: string; limitReached: boolean; pagination: string; nextCursors: Record<string, number> };
      };
      const pages: JsonLogRow[][] = [];
      let cursors: Record<string, number> | undefined;
      for (let page = 0; page < 4; page += 1) {
        const result = await runLogs([
          '--all', '--include-test', '--json', '--category', 'federated-page', '--limit', '3',
          ...(cursors ? ['--before', JSON.stringify(cursors)] : []),
        ], home);
        expect(result.status).toBe(0);
        const rows = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonLogRow);
        expect(rows.every((row) => row._meta || row.category === 'federated-page')).toBe(true);
        pages.push(rows);
        const meta = rows.at(-1)?._meta;
        if (!meta) break;
        expect(meta).toMatchObject({ type: 'log-query-limit', limitReached: true, pagination: 'before-id-by-instance' });
        cursors = meta.nextCursors;
        expect(cursors).toEqual({ prod: expect.any(Number), 'test:fixture': expect.any(Number) });
      }

      const records = pages.flatMap((rows) => rows.filter((row) => row.category === 'federated-page'));
      expect(pages).toHaveLength(4);
      expect(records).toHaveLength(11);
      expect(new Set(records.map((row) => `${row.instance}:${row.id}`)).size).toBe(11);
      expect(records.map((row) => row.event).sort()).toEqual([
        'prod-0', 'prod-1', 'prod-2', 'prod-3', 'prod-4', 'prod-5', 'prod-6', 'prod-7', 'prod-8',
        'test:fixture-0', 'test:fixture-1',
      ]);
      const pageRecords = pages.map((rows) => rows.filter((row) => row.category === 'federated-page'));
      expect(pageRecords.every((rows) => rows.every((row, index) => index === 0 || rows[index - 1]!.ts <= row.ts))).toBe(true);
      expect(pageRecords.slice(1).every((rows, index) => rows.at(-1)!.ts < pageRecords[index]![0]!.ts)).toBe(true);
      expect((pages[1]!.at(-1) as { _meta: { nextCursors: Record<string, number> } })._meta.nextCursors['test:fixture'])
        .toBe((pages[0]!.at(-1) as { _meta: { nextCursors: Record<string, number> } })._meta.nextCursors['test:fixture']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('상한 도달은 비-JSON stdout과 JSON 마지막 메타 행에 고지하며 JSON stdout은 순수 NDJSON이다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-limit-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch(Array.from({ length: 1201 }, (_, index) => ({
      rec: { ts: new Date(Date.now() + index).toISOString(), category: 'limit', event: String(index) }, surface: 'nexus',
    })));
    writer.close();
    try {
      // ⛔⭐ 2026-07-29 — 옛 기대는 *"--limit 3000 이 1000 으로 잘린다"* 였다. 그 상한이 사고의
      //   원인이라 걷어냈다(HTTP 경계로 이동). ⇒ 이제 3000 요청은 **1201건 전부**를 주고
      //   상한에 **안 걸리지 않는다**. 상한 안내는 요청량이 실제 보유량보다 작을 때만 나온다.
      const text = await runLogs(['--instance', 'prod', '--category', 'limit', '--limit', '3000'], home);
      expect(text.status).toBe(0);
      expect(text.stdout).not.toContain('상한 1000 도달');
      expect(text.stdout.split('\n').filter((l) => l.includes('[nexus] limit ')).length).toBe(1201);

      // ⭐ 상한에 실제로 닿는 조회(요청 < 보유)에서만 안내가 나오고, **다음 쪽 커서**를 준다.
      // 300·1200처럼 사람이 전수로 오독하기 쉬운 상한도 JSON stdout 메타가 반드시 드러낸다.
      for (const requestedLimit of [300, 1200]) {
        const cappedJson = await runLogs(['--instance', 'prod', '--json', '--category', 'limit', '--limit', String(requestedLimit)], home);
        expect(cappedJson.status).toBe(0);
        expect(cappedJson.stderr).not.toContain(`상한 ${requestedLimit} 도달`);
        const cappedRows = cappedJson.stdout.trim().split('\n').map((line) => JSON.parse(line));
        expect(cappedRows).toHaveLength(requestedLimit + 3);
        expect(cappedRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
        expect(cappedRows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
        expect(cappedRows.slice(2, -1).every((row) => row.category === 'limit')).toBe(true);
        expect(cappedRows.at(-1)).toEqual({
          _meta: {
            type: 'log-query-limit', limitReached: true, requestedLimit, effectiveLimit: requestedLimit,
            nextCursor: cappedRows[2]!.id, pagination: 'before-id',
          },
        });
      }

      // 메타의 단일 스토어 nextCursor는 기계가 stderr 없이 그대로 다음 쪽 요청에 쓸 수 있다.
      const firstPage = await runLogs(['--instance', 'prod', '--json', '--category', 'limit', '--limit', '300'], home);
      expect(firstPage.status).toBe(0);
      const firstPageRows = firstPage.stdout.trim().split('\n').map((line) => JSON.parse(line));
      const firstPageMeta = firstPageRows.at(-1)!._meta as { limitReached: boolean; nextCursor: number };
      expect(firstPageMeta.limitReached).toBe(true);
      expect(firstPageMeta.nextCursor).toEqual(expect.any(Number));
      const secondPage = await runLogs(['--instance', 'prod', '--json', '--category', 'limit', '--limit', '300', '--before', String(firstPageMeta.nextCursor)], home);
      expect(secondPage.status).toBe(0);
      const secondPageRows = secondPage.stdout.trim().split('\n').map((line) => JSON.parse(line));
      const firstPagePayloadRows = firstPageRows.filter((row) => row._meta == null);
      const secondPagePayloadRows = secondPageRows.filter((row) => row._meta == null);
      const firstPageIds = new Set(firstPagePayloadRows.map((row) => row.id));
      expect(secondPagePayloadRows).toHaveLength(300);
      expect(secondPagePayloadRows.every((row) => !firstPageIds.has(row.id))).toBe(true);

      const completeJson = await runLogs(['--instance', 'prod', '--json', '--category', 'limit', '--limit', '3000'], home);
      expect(completeJson.status).toBe(0);
      const completeRows = completeJson.stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(completeRows).toHaveLength(1203);
      expect(completeRows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(completeRows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(completeRows.slice(2).every((row) => row._meta === undefined)).toBe(true);

      const capped = await runLogs(['--instance', 'prod', '--category', 'limit', '--limit', '10'], home);
      expect(capped.status).toBe(0);
      expect(capped.stdout).toContain('상한 10 도달');
      expect(capped.stdout).toContain('--before ');

      const json = await runLogs(['--instance', 'prod', '--json', '--category', 'limit', '--limit', '10'], home);
      expect(json.status).toBe(0);
      expect(json.stderr).not.toContain('상한 10 도달');
      expect(json.stderr).not.toContain('잘렸다');
      // 모든 stdout 행은 JSON.parse 가능하며, 기존 로그 행 10개와 기계용 메타 행들이 같이 나온다.
      const rows = json.stdout.trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(13);
      expect(rows[0]).toEqual(expect.objectContaining({ _meta: expect.objectContaining({ type: 'log-query-opened-stores' }) }));
      expect(rows[1]).toEqual({ _meta: { type: 'log-query-multi-surface-duplicates', duplicateGroupCount: 0, surfaceKindCount: 0, surfaces: [], groups: [] } });
      expect(rows.slice(2, -1).every((row) => row.category === 'limit')).toBe(true);
      expect(rows.at(-1)).toEqual({
        _meta: {
          type: 'log-query-limit', limitReached: true, requestedLimit: 10, effectiveLimit: 10,
          nextCursor: rows[2]!.id, pagination: 'before-id',
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('--json nextCursor는 역순 id·동일 시각에서도 실제 --before 페이지 경계와 일치한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-json-cursor-boundary-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    const base = Date.UTC(2026, 6, 30, 0, 0, 0);
    const offsets = [4, 1, 3, 1, 5, 0, 2, 3];
    writer.insertBatch(offsets.map((offset, insertion) => ({
      rec: {
        ts: new Date(base + offset * 1000).toISOString(),
        category: 'cursor-boundary',
        event: `insert-${insertion}`,
      },
      surface: 'nexus',
    })));
    writer.close();
    try {
      type JsonLogLine = {
        id?: number;
        event?: string;
        _meta?: { type: string; limitReached: boolean; nextCursor: number | null; pagination: string };
      };
      const records: JsonLogLine[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < 4; page += 1) {
        const result = await runLogs([
          '--instance', 'prod', '--json', '--category', 'cursor-boundary', '--limit', '3',
          ...(cursor === undefined ? [] : ['--before', String(cursor)]),
        ], home);
        expect(result.status).toBe(0);
        const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonLogLine);
        expect(lines.every((line) => line._meta || line.event?.startsWith('insert-'))).toBe(true);
        const meta = lines.at(-1)?._meta;
        const pageRecords = lines.filter((line) => line.event?.startsWith('insert-'));
        records.push(...pageRecords);
        if (!meta) break;
        expect(meta).toMatchObject({ type: 'log-query-limit', limitReached: true, pagination: 'before-id' });
        expect(meta.nextCursor).toBe(pageRecords[0]!.id!);
        cursor = meta.nextCursor!;
      }

      expect(records).toHaveLength(offsets.length);
      expect(new Set(records.map((line) => line.id)).size).toBe(offsets.length);
      expect(records.map((line) => line.event).sort()).toEqual(offsets.map((_, insertion) => `insert-${insertion}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events lists multiple events in a category by descending count (human and JSON)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-multi-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:01.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:02.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:03.000Z', category: 'harness.boundary', event: 'approval-shadow' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:04.000Z', category: 'harness.boundary', event: 'approval-shadow' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:05.000Z', category: 'harness.boundary', event: 'main-tree-reject' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:06.000Z', category: 'other.category', event: 'unrelated' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const text = await runLogs(['--instance', 'prod', '--list-events', '--exact-category', 'harness.boundary'], home);
      expect(text.status).toBe(0);
      expect(text.stderr).toContain('이벤트 3개 · 스토어 1개');
      expect(text.stdout).toBe('       3  request-received\n       2  approval-shadow\n       1  main-tree-reject\n');
      expect(text.stdout).not.toContain('unrelated');

      const json = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'harness.boundary'], home);
      expect(json.status).toBe(0);
      const listing = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((row) => Array.isArray(row.events));
      expect(listing).toEqual({
        stores: 1,
        events: [
          { event: 'request-received', count: 3 },
          { event: 'approval-shadow', count: 2 },
          { event: 'main-tree-reject', count: 1 },
        ],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events respects category filters including zero results', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-zero-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const empty = await runLogs(['--instance', 'prod', '--list-events', '--exact-category', 'no-such-category'], home);
      expect(empty.status).toBe(0);
      expect(empty.stderr).toContain('이벤트 0개 · 스토어 1개');
      expect(empty.stdout).toBe('');

      const json = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'no-such-category'], home);
      expect(json.status).toBe(0);
      const listing = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((row) => Array.isArray(row.events));
      expect(listing).toEqual({ stores: 1, events: [] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events merges counts across stores and keeps descending order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-merge-'));
    const prodState = join(home, '.elanous');
    const otherState = join(home, 'other-state');
    const prod = new LogStore(join(prodState, 'logs', 'logs.db'));
    prod.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:01.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:02.000Z', category: 'harness.boundary', event: 'approval-shadow' }, surface: 'nexus' },
    ]);
    prod.close();
    const other = new LogStore(join(otherState, 'logs', 'logs.db'));
    other.insertBatch([
      { rec: { ts: '2026-09-06T00:00:03.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:04.000Z', category: 'harness.boundary', event: 'main-tree-reject' }, surface: 'nexus' },
    ]);
    other.close();
    writeFileSync(join(prodState, 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--all', '--list-events', '--exact-category', 'harness.boundary'], home);
      expect(text.status).toBe(0);
      expect(text.stderr).toContain('이벤트 3개 · 스토어 2개');
      expect(text.stdout).toBe('       3  request-received\n       1  approval-shadow\n       1  main-tree-reject\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events surfaces truncation and excludes _meta truncation-warning rows', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-trunc-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:01.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:02.000Z', category: 'harness.boundary', event: 'approval-shadow' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:03.000Z', category: '_meta', event: 'truncation-warning' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:04.000Z', category: 'harness.boundary', event: '_meta' }, surface: 'nexus' },
    ]);
    writer.close();
    try {
      const uncapped = await runLogs(['--instance', 'prod', '--list-events', '--category', 'harness.boundary'], home);
      expect(uncapped.status).toBe(0);
      expect(uncapped.stdout).toContain('request-received');
      expect(uncapped.stdout).toContain('approval-shadow');
      expect(uncapped.stdout).not.toContain('truncation-warning');
      expect(uncapped.stdout).not.toMatch(/_meta/);
      expect(uncapped.stderr).not.toContain('result may be truncated');

      const capped = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'harness.boundary', '--limit', '2'], home);
      expect(capped.status).toBe(0);
      expect(capped.stderr).toContain('elanous logs: result may be truncated (limitReached=true)');
      const listing = capped.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((row) => Array.isArray(row.events));
      expect(listing.truncated).toBe(true);
      expect(listing.events.every((row: { event: string }) => row.event !== '_meta' && row.event !== 'truncation-warning')).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events sets truncated only when a probe row exists beyond fetchLimit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-probe-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'alpha' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:01.000Z', category: 'harness.boundary', event: 'beta' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:02.000Z', category: 'harness.boundary', event: 'gamma' }, surface: 'nexus' },
    ]);
    writer.close();
    const parseListing = (stdout: string) => stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .find((row) => Array.isArray(row.events));
    const counted = (listing: { events: Array<{ count: number }> }) =>
      listing.events.reduce((sum, row) => sum + row.count, 0);
    try {
      const under = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'harness.boundary', '--limit', '4'], home);
      expect(under.status).toBe(0);
      expect(under.stderr).not.toContain('result may be truncated');
      const underListing = parseListing(under.stdout);
      expect(underListing.truncated).toBeUndefined();
      expect(counted(underListing)).toBe(3);
      expect(underListing.events).toHaveLength(3);

      const exact = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'harness.boundary', '--limit', '3'], home);
      expect(exact.status).toBe(0);
      expect(exact.stderr).not.toContain('result may be truncated');
      const exactListing = parseListing(exact.stdout);
      expect(exactListing.truncated).toBeUndefined();
      expect(counted(exactListing)).toBe(3);
      expect(exactListing.events).toHaveLength(3);

      const over = await runLogs(['--instance', 'prod', '--json', '--list-events', '--exact-category', 'harness.boundary', '--limit', '2'], home);
      expect(over.status).toBe(0);
      expect(over.stderr).toContain('elanous logs: result may be truncated (limitReached=true)');
      const overListing = parseListing(over.stdout);
      expect(overListing.truncated).toBe(true);
      expect(counted(overListing)).toBe(2);
      expect(overListing.events).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events continues with a warning when one store fails to read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-failsoft-'));
    const prodState = join(home, '.elanous');
    const otherState = join(home, 'other-state');
    const prod = new LogStore(join(prodState, 'logs', 'logs.db'));
    prod.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'request-received' }, surface: 'nexus' },
    ]);
    prod.close();
    mkdirSync(join(otherState, 'logs'), { recursive: true });
    const empty = new Database(join(otherState, 'logs', 'logs.db'));
    empty.close();
    writeFileSync(join(prodState, 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
    }] }));
    try {
      const text = await runLogs(['--all', '--list-events', '--exact-category', 'harness.boundary'], home);
      expect(text.status).not.toBe(1);
      expect(text.stderr).toContain('조회 실패');
      expect(text.stdout).toContain('request-received');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('--list-events is registered as one adjacent logs option and existing flags stay', async () => {
    const logs = program.commands.find((c) => c.name() === 'logs');
    expect(logs).toBeDefined();
    const longs = logs!.options.map((o) => o.long);
    expect(longs).toContain('--list-events');
    expect(longs.filter((flag) => flag === '--list-events')).toHaveLength(1);
    expect(longs).toContain('--list-categories');
    expect(longs).toContain('--category');
    expect(longs).toContain('--exact-category');
    expect(longs).toContain('--event');
    expect(longs).toContain('--json');
    const help = logs!.helpInformation();
    expect(help).toContain('--list-events');
    expect(help).toContain('--list-categories');
  });

  it('--list-events applies --limit globally after merging stores, not per store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-list-events-global-limit-'));
    const prodState = join(home, '.elanous');
    const otherState = join(home, 'other-state');
    const prod = new LogStore(join(prodState, 'logs', 'logs.db'));
    prod.insertBatch([
      { rec: { ts: '2026-09-06T00:00:00.000Z', category: 'harness.boundary', event: 'older-store' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:01.000Z', category: 'harness.boundary', event: 'older-store' }, surface: 'nexus' },
    ]);
    prod.close();
    const other = new LogStore(join(otherState, 'logs', 'logs.db'));
    other.insertBatch([
      { rec: { ts: '2026-09-06T00:00:02.000Z', category: 'harness.boundary', event: 'newer-store' }, surface: 'nexus' },
      { rec: { ts: '2026-09-06T00:00:03.000Z', category: 'harness.boundary', event: 'newer-store' }, surface: 'nexus' },
    ]);
    other.close();
    writeFileSync(join(prodState, 'logs', 'instances.json'), JSON.stringify({ instances: [{
      name: 'other', stateDir: otherState, kind: 'prod', configDir: otherState, pid: 0, startedAt: '',
    }] }));
    try {
      const json = await runLogs(['--all', '--json', '--list-events', '--exact-category', 'harness.boundary', '--limit', '2'], home);
      expect(json.status).toBe(0);
      const listing = json.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((row) => Array.isArray(row.events));
      expect(listing.truncated).toBe(true);
      expect(listing.events).toEqual([{ event: 'newer-store', count: 2 }]);
      expect(listing.events.reduce((sum: number, row: { count: number }) => sum + row.count, 0)).toBe(2);
      expect(json.stderr).toContain('elanous logs: result may be truncated (limitReached=true)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('aggregateListEvents — global limit and safety-max probe', () => {
  const row = (id: number, ts_ms: number, event: string, category = 'harness.boundary'): import('../mss/logging/log-store.js').LogStoreRow => ({
    id, ts: new Date(ts_ms).toISOString(), ts_ms, level: 'debug', instance: 'prod', surface: 'nexus',
    category, event, session_id: null, trace_id: null, data: null,
  });

  const fakeStore = (rows: import('../mss/logging/log-store.js').LogStoreRow[]) => {
    const sorted = [...rows].sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id);
    return {
      query(q: import('../mss/logging/log-store.js').LogQuery) {
        let filtered = sorted;
        const beforeId = q.beforeId;
        if (beforeId !== undefined) {
          const anchor = sorted.find((candidate) => candidate.id === beforeId);
          if (!anchor) throw new Error(`page cursor row ${beforeId} not found in this store`);
          filtered = sorted.filter((candidate) => (
            candidate.ts_ms < anchor.ts_ms || (candidate.ts_ms === anchor.ts_ms && candidate.id < beforeId)
          ));
        }
        return filtered.slice(0, q.limit ?? 100);
      },
    };
  };

  it('caps merged rows at the global limit and truncates on the global N+1th row', () => {
    const result = aggregateListEvents([
      { name: 'prod', store: fakeStore([row(1, 1, 'older'), row(2, 2, 'older')]) },
      { name: 'other', store: fakeStore([row(3, 3, 'newer'), row(4, 4, 'newer')]) },
    ], { exactCategories: ['harness.boundary'], limit: 2 });
    expect(result.truncated).toBe(true);
    expect(result.events).toEqual([{ event: 'newer', count: 2 }]);
    expect(result.unreadable).toEqual([]);
  });

  it('probes one extra row when a store fills the safety max so overflow is not a false negative', () => {
    const store = fakeStore([
      row(1, 1, 'oldest'),
      row(2, 2, 'middle'),
      row(3, 3, 'newest'),
      row(4, 4, 'overflow'),
    ]);
    const queries: Array<{ limit?: number; beforeId?: number }> = [];
    const tracing = {
      query(q: import('../mss/logging/log-store.js').LogQuery) {
        queries.push({ limit: q.limit, beforeId: q.beforeId });
        return store.query(q);
      },
    };
    const result = aggregateListEvents([{ name: 'prod', store: tracing }], {}, 3);
    expect(queries).toEqual([
      { limit: 3, beforeId: undefined },
      { limit: 1, beforeId: 2 },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.events.reduce((sum, item) => sum + item.count, 0)).toBe(3);
    expect(result.events.some((item) => item.event === 'oldest')).toBe(false);
  });

  it('does not mark truncated when the safety-max page has no older row', () => {
    const result = aggregateListEvents([
      { name: 'prod', store: fakeStore([row(1, 1, 'a'), row(2, 2, 'b'), row(3, 3, 'c')]) },
    ], {}, 3);
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(3);
  });
});

describe('buildQuery — 옵션 → LogQuery', () => {
  it('전체 옵션 왕복 (category 의 .* 접미사는 prefix 로 정규화)', () => {
    const { query, error } = buildQuery({
      level: 'warn', surface: 'pwa, telegram', category: 'voice.*,webterm.tabs',
      exactCategory: 'signal, signal.gate1', event: 'lifecycle.bridge-attached,headless.progress',
      grep: 'timeout', session: 's1', limit: '50',
    });
    expect(error).toBeUndefined();
    expect(query).toEqual({
      minLevel: 'warn',
      surfaces: ['pwa', 'telegram'],
      categories: ['voice', 'webterm.tabs'],
      exactCategories: ['signal', 'signal.gate1'],
      events: ['lifecycle.bridge-attached', 'headless.progress'],
      grep: 'timeout',
      sessionId: 's1',
      limit: 50,
    });
  });

  it('since 상대 표기 파싱 (30m)', () => {
    const before = Date.now() - 30 * 60_000;
    const { query } = buildQuery({ since: '30m' });
    expect(query.sinceMs).toBeGreaterThanOrEqual(before - 1000);
    expect(query.sinceMs).toBeLessThanOrEqual(Date.now() - 30 * 60_000 + 1000);
  });

  it('시각 없는 since 날짜는 시각이 붙은 로컬 자정과 같다', () => {
    const dateOnly = buildQuery({ since: '2026-08-05' }).query.sinceMs;
    expect(dateOnly).toBe(buildQuery({ since: '2026-08-05 00:00' }).query.sinceMs);
    expect(dateOnly).toBe(new Date(2026, 7, 5).getTime());
  });

  it('시각 없는 저연도 since 날짜도 ISO 연도를 보존한 로컬 자정이다', () => {
    const expected = new Date(0);
    expected.setHours(0, 0, 0, 0);
    expected.setFullYear(1, 7, 5);
    expect(buildQuery({ since: '0001-08-05' }).query.sinceMs).toBe(expected.getTime());
  });

  it('비UTC 시간대에서도 시각 없는 since 날짜는 로컬 자정과 같다', () => {
    const modulePath = join(process.cwd(), 'src/cli/logs-cli.ts');
    const probe = spawnSync(process.execPath, ['--eval', `
      import { buildQuery } from ${JSON.stringify(modulePath)};
      console.log(JSON.stringify({
        dateOnly: buildQuery({ since: '2026-08-05' }).query.sinceMs,
        localMidnight: buildQuery({ since: '2026-08-05 00:00' }).query.sinceMs,
      }));
    `], {
      cwd: process.cwd(), env: { ...process.env, TZ: 'Asia/Seoul' }, encoding: 'utf8',
    });
    expect(probe.status).toBe(0);
    const { dateOnly, localMidnight } = JSON.parse(probe.stdout);
    expect(dateOnly).toBe(localMidnight);
  });

  it('무효 level/since/limit → error', () => {
    expect(buildQuery({ level: 'loud' }).error).toContain('--level');
    expect(buildQuery({ since: 'gibberish' }).error).toContain('--since');
    expect(buildQuery({ limit: '-3' }).error).toContain('--limit');
  });

  it('--space <kind> → 그 공간 surface exact', () => {
    expect(buildQuery({ space: 'self-implement' }).query.surfaces).toEqual(['harness:self-implement']);
    expect(buildQuery({ space: 'dev-harness' }).query.surfaces).toEqual(['harness:dev-harness']);
  });

  it('--space <run id> → 전 harness 공간 + id grep(병렬 per-run 조회)', () => {
    const { query } = buildQuery({ space: 'f1-grounding-a1b2' });
    // ⛔⭐ 목록을 «손으로 박지 않는다» — 공간이 늘면 이 시험이 그때마다 빨개진다.
    //   📏 실측 2026-09-17: `#18434` 가 네 번째 공간 `dev-hold` 를 더했고, 생산부는
    //     `HARNESS_SPACE_KINDS` 하나에서 파생하는데 여기만 셋을 박아 두어 main 이 «빨강»이었다.
    //   ⇒ 무는 것은 「목록의 내용」이 아니라 ***「전 공간을 «빠짐없이» `harness:` 접두로 편다」*** 는 계약이다.
    expect(query.surfaces).toEqual(HARNESS_SPACE_KINDS.map((kind) => `harness:${kind}`));
    expect(query.surfaces).toHaveLength(HARNESS_SPACE_KINDS.length);
    expect(query.grep).toBe('f1-grounding-a1b2');
  });

  it('--space <id> + 명시 --grep → 명시 grep 우선', () => {
    const { query } = buildQuery({ space: 'some-run', grep: 'timeout' });
    expect(query.grep).toBe('timeout');   // 명시 --grep 이 id-grep 을 덮지 않음
  });
});

describe('renderLogJsonLine — 레거시 surrogate JSONL 방어', () => {
  const row = (data: string): LogStoreRow => ({
    id: 1, ts: '2026-08-13T00:00:00.000Z', ts_ms: 0, level: 'info', instance: 'prod',
    surface: 'nexus', category: 'jsonl', event: 'render', session_id: null, trace_id: null, data,
  });

  it('lone high와 lone low surrogate를 JSON-parse 가능한 대체 문자로 바꾸고 표시한다', () => {
    for (const malformed of ['before\uD800after', 'before\uDC00after']) {
      const legacy = JSON.stringify({ ...row(malformed), instance: 'prod' });
      expect(legacy).toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
      const parsed = JSON.parse(renderLogJsonLine(row(malformed), 'prod')) as Record<string, unknown>;
      expect(parsed.data).toBe('before\uFFFDafter');
      expect(parsed._elanousJsonlSanitized).toBe(true);
    }
  });

  it('유효 surrogate pair와 평범한 값은 기존 JSON 문자열 및 필드를 그대로 보존한다', () => {
    const ordinary = row('plain 😀 text');
    const legacy = JSON.stringify({ ...ordinary, data: ordinary.data, instance: 'prod', store: 'prod', storePath: null });
    const line = renderLogJsonLine(ordinary, 'prod');
    expect(line).toBe(legacy);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('_elanousJsonlSanitized');
    expect(parsed.data).toBe(ordinary.data);
  });

  it('jsonData의 중첩 문자열과 객체 키를 비변이로 손질하고 표시 키 충돌을 피한다', () => {
    const stored = JSON.stringify({ nested: ['safe', 'left\uD800right'], _elanousJsonlSanitized: 'preserve' });
    const original = Object.assign(row(stored), { _elanousJsonlSanitized: 'preserve' });
    const parsed = JSON.parse(renderLogJsonLine(original, 'prod', true)) as Record<string, unknown>;
    expect(parsed.data).toEqual({ nested: ['safe', 'left\uFFFDright'], _elanousJsonlSanitized: 'preserve' });
    expect(parsed._elanousJsonlSanitized).toBe('preserve');
    expect(parsed.__elanousJsonlSanitized).toBe(true);
    expect(original.data).toBe(stored);
  });

  it('최상위와 중첩 객체의 lone surrogate 키를 대체 문자로 바꾸고 모든 값을 보존한다', () => {
    const stored = `{"nested":{"left\uD800":"high","right\uDC00":"low"}}`;
    const original = Object.assign(row(stored), { 'top\uD800': 'top-high' });
    const line = renderLogJsonLine(original, 'prod', true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(line).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    expect(parsed['top\uFFFD']).toBe('top-high');
    expect(parsed.data).toEqual({ nested: { 'left\uFFFD': 'high', 'right\uFFFD': 'low' } });
    expect(parsed._elanousJsonlSanitized).toBe(true);
    expect(original['top\uD800']).toBe('top-high');
    expect(original.data).toBe(stored);
  });

  it('손질 후 충돌하는 객체 키에 결정적 접미사를 붙여 두 항목을 보존한다', () => {
    const stored = `{"\uFFFD":"ordinary","\uD800":"legacy","nested":{"\uFFFD":"nested-ordinary","\uDC00":"nested-legacy"}}`;
    const first = JSON.parse(renderLogJsonLine(row(stored), 'prod', true)) as Record<string, unknown>;
    const second = JSON.parse(renderLogJsonLine(row(stored), 'prod', true)) as Record<string, unknown>;
    expect(first).toEqual(second);
    expect(first.data).toEqual({
      '�': 'ordinary',
      '�__elanousJsonlSanitizedKey1': 'legacy',
      nested: { '�': 'nested-ordinary', '�__elanousJsonlSanitizedKey1': 'nested-legacy' },
    });
    expect(first._elanousJsonlSanitized).toBe(true);
  });

  it('혼합 여러 행에서는 전체 행과 손질된 행 수가 모두 0이 아니고 나머지 행을 보존한다', () => {
    const lines = [row('ordinary'), row('broken\uD800value'), row('😀 intact')]
      .map((item) => renderLogJsonLine(item, 'prod'));
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(3);
    expect(parsed.filter((item) => item._elanousJsonlSanitized === true)).toHaveLength(1);
    expect(parsed.map((item) => item.data)).toEqual(['ordinary', 'broken\uFFFDvalue', '😀 intact']);
  });
});

describe('formatLogLine — logcat 감성', () => {
  const row: LogStoreRow = {
    id: 1, ts: '2026-07-13T07:08:40.123Z', ts_ms: 0,
    level: 'error', instance: 'prod', surface: 'pwa', category: 'webterm.tabs', event: 'list.error',
    session_id: null, trace_id: null, data: '{"reason":"probe"}',
  };
  it('시간·레벨태그·surface·category·event·data 한 줄', () => {
    // ⚠️ TZ 를 명시 주입한다. 종전엔 인자 없이 부르고 '07:08:40.123'(= ISO 문자열
    // slice = UTC)를 정답으로 단정했는데, 그건 **버그를 스펙으로 못 박은 것**이었다.
    // KST 머신에서 실제 시각은 16:08 인데 화면엔 07:08 로 찍혔고, 사고 조사 때
    // 엉뚱한 시간대를 뒤지게 만들었다.
    const line = formatLogLine(row, false, undefined, 'UTC');
    expect(line).toBe('07:08:40.123 E [pwa] webterm.tabs list.error {"reason":"probe"}');
  });
  it('★ 시각은 사용자 시간대로 변환된다 (저장 UTC ↔ 표시 로컬)', () => {
    // 같은 레코드가 시간대에 따라 다르게 보여야 한다 — 이게 회귀의 잠금 지점.
    expect(formatLogLine(row, false, undefined, 'Asia/Seoul'))
      .toBe('16:08:40.123 E [pwa] webterm.tabs list.error {"reason":"probe"}');
    expect(formatLogLine(row, false, undefined, 'America/New_York'))
      .toBe('03:08:40.123 E [pwa] webterm.tabs list.error {"reason":"probe"}');
  });
  it('긴 data 는 200자 컷', () => {
    const long = formatLogLine({ ...row, data: JSON.stringify({ x: 'y'.repeat(500) }) }, false);
    expect(long.length).toBeLessThan(280);
    expect(long.endsWith('…')).toBe(true);
  });
  it('color 모드는 error 에 ANSI red', () => {
    expect(formatLogLine(row, true).startsWith('\x1b[31m')).toBe(true);
  });
});

describe('resolveLogTargets — 인스턴스 타겟 해석 (LF7-b)', () => {
  const inst = (name: string, stateDir: string, dbExists = true): LogInstanceView => ({
    name, stateDir, stateDirCount: 1, ambiguous: false,
    kind: name.startsWith('test:') ? 'test' : 'prod', configDir: stateDir, pid: 1, startedAt: '2026-07-13T00:00:00.000Z',
    alive: false, liveness: 'dead', dbExists, dbPath: join(stateDir, 'logs', 'logs.db'),
  });

  // ── 기본 동선 = 내 우주 ⊕ 운영 (P5 · 2026-07-27) ───────────────────────────
  //
  // ⚠️ 실측 사건: 3층 스위치를 켜자 비-리더 트리의 조회가 **자기도 test 로 파생**돼, 방금 전까지
  //   보이던 운영 로그가 `elanous logs` 에서 통째로 사라졌다(관측 도구가 우주를 바꿔 자기 로그를 못 찾음).
  //   격리는 실행에 필요한 것이지 조회를 좁힐 이유가 아니다.
  const PROD: LogTarget = { name: 'prod', dbPath: '/home/u/.elanous/logs/logs.db' };

  it('플래그 없음 · 현재 우주가 운영 → 단일 타겟(무회귀)', () => {
    const r = resolveLogTargets({}, { instances: [], self: { ...PROD }, prod: PROD });
    expect(r.error).toBeUndefined();
    expect(r.targets.map((t) => t.name)).toEqual(['prod']);
  });

  it('★ 플래그 없음 · 현재 우주가 파생/격리 → 내 것 + 운영 둘 다', () => {
    const self: LogTarget = { name: 'test:axon', dbPath: '/x/axon/.elanous-test/logs/logs.db' };
    const r = resolveLogTargets({}, { instances: [], self, prod: PROD });
    expect(r.targets.map((t) => t.name)).toEqual(['test:axon', 'prod']);
  });

  it('명시 스코프는 기본 합류에 영향받지 않는다(--instance 는 **요청한 그것** 하나만)', () => {
    // ⚠️ 길이만 보면 "엉뚱한 단일 타겟"도 통과한다(리뷰 should-fix) — 이름·경로까지 단정한다.
    const self: LogTarget = { name: 'test:axon', dbPath: '/x/axon/.elanous-test/logs/logs.db' };
    const r = resolveLogTargets({ instance: 'prod' }, { instances: [], self, prod: PROD });
    expect(r.targets).toEqual([{ name: 'prod', dbPath: join(homedir(), '.elanous', 'logs', 'logs.db') }]);

    const views = [inst('test:monad-agent', '/x/monad-agent/.elanous-test')];
    const t = resolveLogTargets({ instance: 'monad-agent' }, { instances: views, self, prod: PROD });
    expect(t.targets).toEqual([{ name: 'test:monad-agent', dbPath: '/x/monad-agent/.elanous-test/logs/logs.db' }]);
  });

  it('실 해석 경로(주입 없음) — 현재 우주가 반드시 포함되고, 비-prod 면 prod 도 합류한다', () => {
    // ⚠️ "1~2개" 는 약하다(리뷰 should-fix) — 실제 구성을 단정한다.
    const r = resolveLogTargets({}, { instances: [] });
    expect(r.error).toBeUndefined();
    const prodPath = join(homedir(), '.elanous', 'logs', 'logs.db');
    const paths = r.targets.map((t) => t.dbPath);
    expect(paths[0]).toBeTruthy();                 // 첫 타겟 = 현재 우주
    expect(paths).toContain(prodPath);             // 운영은 언제나 조회 대상
    expect(r.targets).toHaveLength(paths[0] === prodPath ? 1 : 2);
  });

  it('--test 는 --instance/--all 과 동시 지정하면 에러', () => {
    expect(resolveLogTargets({ test: true, all: true }, { instances: [] }).error).toContain('동시 지정 불가');
    expect(resolveLogTargets({ test: true, instance: 'prod' }, { instances: [] }).error).toContain('동시 지정 불가');
  });

  it('--all --include-test --instance 는 연합 후보군을 지정 인스턴스 하나로 좁힌다', () => {
    const views = [
      inst('axon', '/x/axon-state'),
      inst('test:monad-agent', '/x/monad-agent/.elanous-test'),
    ];
    const r = resolveLogTargets({ all: true, includeTest: true, instance: 'test:monad-agent' }, { instances: views });
    expect(r.error).toBeUndefined();
    expect(r.targets).toEqual([{ name: 'test:monad-agent', dbPath: '/x/monad-agent/.elanous-test/logs/logs.db' }]);
  });

  it('--instance prod → 홈 스토어', () => {
    const r = resolveLogTargets({ instance: 'prod' }, { instances: [] });
    expect(r.targets[0]!.name).toBe('prod');
    expect(r.targets[0]!.dbPath.endsWith('/.elanous/logs/logs.db')).toBe(true);
  });

  it('--instance 이름 매치 (test: 접두 생략 허용) · 미등록은 목록 포함 에러', () => {
    const views = [inst('test:monad-agent', '/x/monad-agent/.elanous-test')];
    expect(resolveLogTargets({ instance: 'test:monad-agent' }, { instances: views }).targets[0]!.name).toBe('test:monad-agent');
    expect(resolveLogTargets({ instance: 'monad-agent' }, { instances: views }).targets[0]!.name).toBe('test:monad-agent');
    const miss = resolveLogTargets({ instance: 'ghost' }, { instances: views });
    expect(miss.error).toContain('미등록');
    expect(miss.error).toContain('test:monad-agent');
  });

  it('같은 stateDir 중복은 비모호성, 서로 다른 경로는 모든 후보를 보고하며 거부한다', () => {
    const duplicateStateDir = '/Users/example/source/temp/monad-agent/.elanous-test';
    const duplicate = resolveLogTargets({ instance: 'test:monad-agent' }, {
      instances: [
        inst('test:monad-agent', duplicateStateDir),
        inst('test:monad-agent', duplicateStateDir),
      ],
    });
    expect(duplicate.error).toBeUndefined();
    expect(duplicate.targets).toEqual([{ name: 'test:monad-agent', dbPath: `${duplicateStateDir}/logs/logs.db` }]);

    const stateDirs = [
      duplicateStateDir,
      '/Users/example/source/elan/monad-agent/.elanous-test',
      '/Users/example/source/demo/monad-agent/.elanous-test',
      '/Users/example/source/axon/monad-agent/.elanous-test',
    ];
    const result = resolveLogTargets({ instance: 'test:monad-agent' }, {
      instances: [
        ...stateDirs.map((stateDir) => inst('test:monad-agent', stateDir)),
        inst('test:monad-agent', duplicateStateDir),
      ],
    });
    expect(result.targets).toEqual([]);
    expect(result.error).toContain("인스턴스 'test:monad-agent' 가 4개 state 경로에 등록되어 모호하다");
    for (const stateDir of stateDirs) expect(result.error).toContain(stateDir);
  });

  it('단일 이름 조회는 기존처럼 단일 타겟을 돌려준다', () => {
    const result = resolveLogTargets({ instance: 'test:monad-agent' }, {
      instances: [inst('test:monad-agent', '/x/monad-agent/.elanous-test')],
    });
    expect(result.error).toBeUndefined();
    expect(result.targets).toEqual([{ name: 'test:monad-agent', dbPath: '/x/monad-agent/.elanous-test/logs/logs.db' }]);
  });

  it('--all → prod-kind 만 연합, 격리 test 는 기본 제외(Phase A), prod 등록 항목은 dedup', () => {
    const home = join(homedir(), '.elanous');
    const views = [
      inst('prod', home),                                  // prod 자신의 등록 — dedup 대상
      inst('axon', '/x/axon-state'),                       // 병렬 비-test 인스턴스 → 포함
      inst('test:monad-agent', '/x/monad-agent/.elanous-test'), // 격리 test → 기본 제외
      inst('test:elanous-2', '/x/elanous-2/.elanous-test', false),  // 스토어 없음 → 제외
    ];
    const r = resolveLogTargets({ all: true }, { instances: views });
    expect(r.targets.map((t) => t.name)).toEqual(['prod', 'axon']);
  });

  it('--all --include-test → 격리 test 도 포함', () => {
    const home = join(homedir(), '.elanous');
    const views = [
      inst('prod', home),
      inst('test:monad-agent', '/x/monad-agent/.elanous-test'),
    ];
    const r = resolveLogTargets({ all: true, includeTest: true }, { instances: views });
    expect(r.targets.map((t) => t.name)).toEqual(['prod', 'test:monad-agent']);
  });

  it('--test 는 cwd 상위에서 .elanous-test 탐색 · 없으면 에러', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logtgt-'));
    const repo = join(dir, 'my-repo');
    mkdirSync(join(repo, '.elanous-test'), { recursive: true });
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const r = resolveLogTargets({ test: true }, { cwd: sub });
    expect(r.targets[0]!.name).toBe('test:my-repo');
    expect(r.targets[0]!.dbPath).toBe(join(repo, '.elanous-test', 'logs', 'logs.db'));
    expect(resolveLogTargets({ test: true }, { cwd: dir }).error).toContain('.elanous-test');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatLogInstance — 인스턴스 목록 모호성 표시', () => {
  const view = (ambiguous: boolean, stateDirCount: number): LogInstanceView => ({
    name: 'test:monad-agent', stateDir: '/x/monad-agent/.elanous-test', stateDirCount, ambiguous,
    kind: 'test', configDir: '/x/monad-agent/.elanous-test', pid: 1, startedAt: '', alive: true, liveness: 'alive', dbExists: true,
    dbPath: '/x/monad-agent/.elanous-test/logs/logs.db',
  });

  it('중복 이름 행은 여러 state 경로에 걸렸음을 표시한다', () => {
    expect(formatLogInstance(view(true, 2))).toContain('ambiguous 2 paths');
  });

  it('단일 이름 행은 새 모호성 잡음이 없다', () => {
    expect(formatLogInstance(view(false, 1))).not.toContain('ambiguous');
  });
});

describe('formatLogLine — 연합 출처 태그 (LF7-b)', () => {
  const row: LogStoreRow = {
    id: 1, ts: '2026-07-13T07:08:40.123Z', ts_ms: 0,
    level: 'info', instance: 'test:monad-agent', surface: 'nexus', category: 'boot', event: 'ready',
    session_id: null, trace_id: null, data: null,
  };
  it('instanceTag 지정 시 ⟨tag⟩ 프리픽스 · 미지정 시 무태그', () => {
    expect(formatLogLine(row, false, 'test:monad-agent', 'UTC')).toBe('07:08:40.123 I ⟨test:monad-agent⟩ [nexus] boot ready');
    expect(formatLogLine(row, false, undefined, 'UTC')).toBe('07:08:40.123 I [nexus] boot ready');
  });
});

// ⛔⭐⭐⭐ 2026-08-02 — 힌트가 **질의가 렌더 카테고리를 이름으로 댈 때만** 떴다.
//    억제가 켜져 있으면 카테고리를 안 댄 질의도 그만큼 빠지는데, 그때는 아무 말이 없었다.
//    실측: `logs --instance X --limit 2000` 으로 전 카테고리를 훑었는데 `dashboard.*` 가
//    통째로 빠져 있었고 힌트는 0회 ⇒ *"그 코드가 안 돈다"* 로 네 번 오진했다.
describe('renderGatedHint — 확정 억제면 질의 모양과 무관하게 알린다', () => {
  const suppressed = () => false;      // level.json.render === false (확정 억제)
  const firing = () => true;           // 확정 발화
  const unset = () => null;            // 미명시

  it('⭐ 확정 억제 + 카테고리 없는 질의 → 알린다', () => {
    const hint = renderGatedHint({}, suppressed);
    expect(hint).not.toBeNull();
    expect(hint).toContain('카테고리를 안 걸어도');
  });

  it('확정 발화면 카테고리 없는 질의에 안 붙는다 (소음 방지)', () => {
    expect(renderGatedHint({}, firing)).toBeNull();
  });

  it('⚠️ 미명시(null)에는 안 붙는다 — "일 수도 있다" 를 매 질의에 붙이면 소음이다', () => {
    expect(renderGatedHint({}, unset)).toBeNull();
  });

  it('렌더 무관 질의여도 확정 억제면 알린다 (빠진 것은 빠진 것이다)', () => {
    expect(renderGatedHint({ category: 'goal.loop' }, suppressed)).not.toBeNull();
  });

  it('렌더 카테고리 질의는 종전 힌트를 그대로 준다 (무회귀 · 안내 요소 전부)', () => {
    const hint = renderGatedHint({ category: 'dashboard.chat.stream' }, suppressed)!;
    // 종전 힌트가 주던 것: 억제 상태 · 켜는 법 · 대체 관측 · 근거 문서
    expect(hint).toContain('억제 ON(무음) 상태다');
    expect(hint).toContain('빈 결과가 정상이다');
    expect(hint).toContain('elanous logs level --render on');
    expect(hint).toContain('화면 관측=tmux `capture-pane`');
    expect(hint).toContain('REPORT §9-3');
    // ⚠️ 그리고 카테고리 없는 질의용 새 문구가 **섞이지 않아야** 한다.
    expect(hint).not.toContain('카테고리를 안 걸어도');
  });
});

describe('runLogsCli — remote /v1/logs', () => {
  /** ⛔⭐ **코드가 «실제로 쓰는 것»을 캡처한다 — 그리고 그것은 «채널 둘»이다.**
   *  📏 실측: `src/cli/logs-cli.ts` 는
   *    · 행 산출 → `process.stdout.write(output, cb)`   (콜백형이라 «호출해 줘야» 한다)
   *    · 오류·안내 → `console.error` / `console.log`
   *  🩸 첫 판은 `process.*.write` 만 갈아 끼워 «오류 문면»을 못 잡았고(4 fail),
   *     둘째 판은 `console.*` 만 갈아 끼워 «행 산출»을 못 잡았다(2 fail).
   *     ⇒ ***한 채널만 재고 「안 나온다」로 읽었다.*** 둘 다 잡는다.
   *  ⛔ `process.stdout.write` 의 «콜백»을 반드시 부른다 — 안 부르면 그 Promise 가 영영 안 풀려
   *     시험이 5초 타임아웃으로 죽는다(그것이 첫 판의 5002ms 실패였다). */
  function captureIo() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    console.log = ((...args: unknown[]) => { stdout.push(`${args.map(String).join(' ')}\n`); }) as typeof console.log;
    console.error = ((...args: unknown[]) => { stderr.push(`${args.map(String).join(' ')}\n`); }) as typeof console.error;
    const sink = (bucket: string[]) => ((chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown) => {
      bucket.push(String(chunk));
      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
      return true;
    });
    process.stdout.write = sink(stdout) as typeof process.stdout.write;
    process.stderr.write = sink(stderr) as typeof process.stderr.write;
    return {
      stdout, stderr,
      restore() {
        console.log = originalLog;
        console.error = originalError;
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      },
    };
  }

  // ⭐⭐⭐ **상한이 «실제로» 건다** — ⛔ 주입 시험은 이 축을 «원리상» 못 잰다.
  //   🩸 앞 판은 `fetchRemoteLogs` 를 주입해 그 «문면»만 봤다. 그러면 배선(`AbortSignal.timeout`)을
  //      «지워도 초록»이다 — 반증으로 확인했다(8 pass · 0 fail). ***내 시험이 실제 경로를 우회했다.***
  //   ⇒ 여기서는 ***응답을 «영영 안 주는» 진짜 서버***에 붙고, 상한만 짧게 준다.
  it('LIVE: a hanging server is aborted BY THE TIMEOUT WIRING (not by an injected shape)', async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => { /* 영영 안 준다 */ }) });
    try {
      const started = Date.now();
      const result = await liveFetchRemoteLogs(`http://127.0.0.1:${hang.port}/v1/logs`, 'tok', 120);
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain('no response within 120ms');
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      hang.stop(true);
    }
  }, 20_000);

  // ⭐⭐⭐ **`--space` 는 «새지 않는다» — 서버가 받는 query string 으로 확인한다** (리뷰 must-fix 6R).
  //   📏 재서 확인: `--space` 는 buildQuery 에서 ***`surfaces`(⊕ per-run 이면 `grep`)로 «전개»***되고,
  //      그 둘은 원격 query string 에 «이미» 실린다. ⇒ 별도 전송·거절이 필요 없다.
  //      ⛔ 그러나 「필요 없다」를 «말»로 두지 않는다 — 서버가 받은 것으로 «고정»한다.
  //      (전개가 깨지면 원격이 «더 넓은» 로그를 조용히 보게 된다. 그게 리뷰의 우려였다.)
  it('remote `--session` is sent as both session and sessionId — verified on the SERVER-received query string', async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        received.push(new URL(req.url).search);
        return Response.json({ ok: true, count: 0, logs: [] });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-session-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'toksess');
    writeFileSync(tok, 'tok');
    const store = new RemotesStore();
    store.addRemote('bm', { host: `127.0.0.1:${server.port}`, acp_url: `ws://127.0.0.1:${server.port}/v1/acp`, token_file: tok, addedAt: new Date(0).toISOString() }, { setDefault: true });
    const io = captureIo();
    try {
      expect(await runLogsCli({ r: true, session: 'sess-42' } as never, { remotesStore: () => store })).toBe(0);
      expect(received[0]).toContain('sessionId=sess-42');
      expect(received[0]).toContain('session=sess-42');
      expect(await runLogsCli({ r: true } as never, { remotesStore: () => store })).toBe(0);
      expect(received[1]).not.toContain('session=');
      expect(received[1]).not.toContain('sessionId=');
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
      server.stop(true);
    }
  });

  it('remote `--space` is carried as surfaces/grep — verified on the SERVER-received query string', async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        received.push(new URL(req.url).search);
        return Response.json({ ok: true, count: 0, logs: [] });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-space-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'toksp');
    writeFileSync(tok, 'tok');
    const store = new RemotesStore();
    store.addRemote('bm', { host: `127.0.0.1:${server.port}`, acp_url: `ws://127.0.0.1:${server.port}/v1/acp`, token_file: tok, addedAt: new Date(0).toISOString() }, { setDefault: true });
    const io = captureIo();
    try {
      // ⓐ 알려진 kind — 그 하나의 surface 로 좁혀진다.
      expect(await runLogsCli({ r: true, space: 'self-implement' } as never, { remotesStore: () => store })).toBe(0);
      expect(received[0]).toContain('surface=harness%3Aself-implement');

      // ⓑ per-run id — 전 harness surface ⊕ 그 id 를 grep 으로.
      expect(await runLogsCli({ r: true, space: 'run-abc123' } as never, { remotesStore: () => store })).toBe(0);
      expect(received[1]).toContain('grep=run-abc123');
      expect(received[1]).toContain('harness%3Adev-harness');

      // ⛔ 대조 — `--space` 가 «없으면» 그 필터가 «안» 실린다(항상 실리면 아무것도 안 재는 것이다).
      expect(await runLogsCli({ r: true } as never, { remotesStore: () => store })).toBe(0);
      expect(received[2]).not.toContain('surface=');
      expect(received[2]).not.toContain('grep=');
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
      server.stop(true);
    }
  });

  // ⭐⭐ **원격에서 거절되는 «로컬 전용 축» 전수** — 계약 변경이므로 시험이 «목록»을 든다(리뷰 should-fix).
  //   🔑 넷 다 `resolveLogTargets` 의 로컬 스토어 스코프다. 원격 데몬은 자기 스코프를 «스스로» 정한다.
  //   ⛔ 조용히 무시하면 사람이 「전 인스턴스를 봤다」고 «잘못 믿는다» — 그게 이 판이 내내 고친 형태다.
  it('remote rejects EVERY local-store scope flag, and each one names itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-scope-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'toks');
    writeFileSync(tok, 'tok');
    const store = new RemotesStore();
    store.addRemote('bm', { host: 'bm', acp_url: 'ws://127.0.0.1:19004/v1/acp', token_file: tok, addedAt: new Date(0).toISOString() }, { setDefault: true });
    const io = captureIo();
    try {
      let fetched = 0;
      const deps = { remotesStore: () => store, fetchRemoteLogs: async () => { fetched += 1; return { ok: true as const, logs: [], count: 0 }; } } as never;
      const cases: Array<[string, Record<string, unknown>]> = [
        ['--all', { all: true }],
        ['--include-test', { includeTest: true }],
        ['--test', { test: true }],
        ['--instance', { instance: 'prod' }],
      ];
      for (const [flag, extra] of cases) {
        io.stderr.length = 0;
        const code = await runLogsCli({ r: true, ...extra } as never, deps);
        // ⭐ 각 칸이 «자기 이름»으로 판정된다 — 하나로 뭉뚱그리면 어느 것이 걸렸는지 모른다.
        expect({ flag, code }).toMatchObject({ flag, code: 1 });
        expect({ flag, err: io.stderr.join('') }).toMatchObject({ flag, err: expect.stringContaining(flag) });
      }
      // ⭐⭐ 본 판정: 넷 다 «원격을 부르지 않는다».
      expect(fetched).toBe(0);
      // ⊕ 대조 — 아무 것도 안 주면 정상 동작한다(가드가 전부를 막으면 그것도 결함이다).
      expect(await runLogsCli({ r: true } as never, deps)).toBe(0);
      expect(fetched).toBe(1);
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐⭐ **`--before` 는 원격에서 «통째로» 거절된다** (리뷰 must-fix 2R).
  //   🩸 앞 판은 「숫자면 보낸다」였다. 그 숫자는 ***이쪽 스토어의 row id*** 이고 저쪽에서 «같은 줄»을
  //      가리킨다는 보장이 없다 — 그러면 사람은 「그 지점부터 봤다」고 믿는데 실제로는 다른 곳부터 본다.
  //   ⛔ 그리고 내 PR 본문은 이미 「거절한다」고 «말하고 있었다» — 말과 코드가 어긋난 것도 결함이다.
  it('remote `--before` is rejected outright (both numeric row ids and federated cursors)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-before-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'tokb');
    writeFileSync(tok, 'tok');
    const store = new RemotesStore();
    store.addRemote('bm', { host: 'bm', acp_url: 'ws://127.0.0.1:19003/v1/acp', token_file: tok, addedAt: new Date(0).toISOString() }, { setDefault: true });
    const io = captureIo();
    try {
      let fetched = 0;
      const deps = { remotesStore: () => store, fetchRemoteLogs: async () => { fetched += 1; return { ok: true as const, logs: [], count: 0 }; } } as never;

      // ⓐ 숫자 row id — ***이것이 앞 판에서 «통과»하던 것***이다.
      const numeric = await runLogsCli({ r: true, before: '12345' } as never, deps);
      expect(numeric).not.toBe(0);
      // ⓑ 연합 커서 형태
      const cursor = await runLogsCli({ r: true, before: 'prod=1,test=2' } as never, deps);
      expect(cursor).not.toBe(0);

      expect(fetched).toBe(0);
      const err = io.stderr.join('');
      expect(err).toContain('bm');              // ⭐ 어느 북마크인지
      expect(err).toContain('--before');        // ⭐ 무엇이 문제인지
      expect(io.stdout.join('')).toBe('');      // ⛔ 로컬 로그로 «안» 떨어진다

      // ⊕ 대조 — `--before` 가 «없으면» 정상 동작한다(가드가 전부를 막으면 그것도 결함이다).
      const fine = await runLogsCli({ r: true } as never, deps);
      expect(fine).toBe(0);
      expect(fetched).toBe(1);
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⭐ **무응답 원격은 «시간»으로 실패한다** (리뷰 should-fix).
  //   ⛔ 상한이 없으면 「실패를 말한다」가 성립하지 않는다 — CLI 가 영영 기다리고 사람은 「느리다」로 읽는다.
  //   ⚠️ 실제 20초를 기다리지 «않는다» — 주입된 fetch 가 그 실패 «모양»을 그대로 낸다.
  //      (실시간 상한 자체는 `AbortSignal.timeout` 의 계약이고 이 시험의 축이 아니다.)
  it('[렌더링] a time-based failure is worded distinctly (⛔ 배선 자체는 위 LIVE hang-server 시험이 잰다)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-timeout-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'tok3');
    writeFileSync(tok, 'tok');
    const store = new RemotesStore();
    store.addRemote('slow', { host: 'slow', acp_url: 'ws://127.0.0.1:9/v1/acp', token_file: tok, addedAt: new Date(0).toISOString() }, { setDefault: true });
    const io = captureIo();
    try {
      const code = await runLogsCli({ r: true }, {
        remotesStore: () => store,
        fetchRemoteLogs: async () => ({ ok: false as const, status: 0, reason: 'no response within 20000ms (remote daemon unreachable or hung)' }),
      } as never);
      expect(code).not.toBe(0);
      const err = io.stderr.join('');
      expect(err).toContain('slow');                       // ⭐ 어느 북마크인지
      expect(err).toContain('no response within');         // ⭐ 「시간으로 실패」임을 말한다
      expect(io.stdout.join('')).toBe('');
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** 별도 프로세스 목 서버를 띄우고 «받은 것»을 파일에 적게 한다.
   *  ⛔ 시험 프로세스 «안»에 두면 자식 요청을 못 돌린다(실측: "no response within 20000ms"). */
  async function startOutOfProcessLogServer(home: string, event: string): Promise<{ port: string; hits: string; stop(): void }> {
    const hits = join(home, `hits-${event}.jsonl`);
    const portFile = join(home, `port-${event}`);
    const serverJs = join(home, `server-${event}.mjs`);
    writeFileSync(serverJs, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch(req) {
        const u = new URL(req.url);
        appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ path: u.pathname, auth: req.headers.get('authorization') }) + '\\n');
        return Response.json({ ok: true, count: 1, logs: [{ id: 7, ts: '2026-09-01T00:00:00.000Z', level: 'info', surface: 'nexus', category: 'named.probe', event: ${JSON.stringify(event)}, data: {} }] });
      }});
      writeFileSync(${JSON.stringify(portFile)}, String(srv.port));
    `);
    const child = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    // ⛔ 조건이 t=0 에 «거짓»이어야 한다 — 포트 파일은 아직 없다.
    const deadline = Date.now() + 30_000;
    while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
    if (!existsSync(portFile)) { child.kill('SIGKILL'); throw new Error('mock log server never reported a port'); }
    return { port: readFileSync(portFile, 'utf8').trim(), hits, stop: () => { try { child.kill('SIGKILL'); } catch { /* 이미 죽었다 */ } } };
  }

  /** 두 북마크를 세운다 — `named` 는 «듣는» 서버, `other`(default) 는 «아무도 안 듣는» 포트. */
  function writeTwoBookmarks(cfg: string, namedPort: string, defaultName: 'other' | 'named'): void {
    mkdirSync(join(cfg, 'remotes'), { recursive: true });
    writeFileSync(join(cfg, 'remotes', 'named.token'), 'named-token');
    writeFileSync(join(cfg, 'remotes', 'other.token'), 'other-token');
    writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({
      version: 1,
      default: defaultName,
      remotes: {
        other: { host: '127.0.0.1:19001', acp_url: 'ws://127.0.0.1:19001/v1/acp', token_file: join(cfg, 'remotes', 'other.token'), addedAt: '2026-09-01T00:00:00Z' },
        named: { host: `127.0.0.1:${namedPort}`, acp_url: `ws://127.0.0.1:${namedPort}/v1/acp`, token_file: join(cfg, 'remotes', 'named.token'), addedAt: '2026-09-01T00:00:00Z' },
      },
    }));
  }

  // ⭐⭐⭐ **`-r`(값 없음 · default 북마크)도 «실물 CLI 배선»을 거친다** (리뷰 must-fix 4R).
  //   🩸 앞 판은 `--remote <name>` 만 실물로 쟀다. 그래서 ***action 에서 `r` 전달을 끊어도 초록***이었다.
  //      두 축은 `src/index.ts` 의 «다른 갈래»(`o.remote` ↔ `o.r`)라 하나가 다른 하나를 안 덮는다.
  it('LIVE CLI: bare `-r` uses the DEFAULT bookmark through the real production wiring', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-live-r-'));
    let server: Awaited<ReturnType<typeof startOutOfProcessLogServer>> | undefined;
    try {
      server = await startOutOfProcessLogServer(home, 'via-bare-r');
      const cfg = join(home, '.elanous');
      writeTwoBookmarks(cfg, server.port, 'named');
      const res = spawnSync(process.execPath, ['bin/elanous.mjs', 'logs', '-r', '--limit', '1'], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg, TZ: 'UTC' },
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
      });
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(out.length).toBeGreaterThan(0);   // ⛔ 자를 먼저 누른다
      expect(existsSync(server.hits)).toBe(true);
      const received = readFileSync(server.hits, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(received).toEqual([{ path: '/v1/logs', auth: 'Bearer named-token' }]);
      expect(out).toContain('via-bare-r');
      expect(out).toContain('⟨remote:named⟩');
      expect({ status: res.status, out: out.slice(0, 300) }).toMatchObject({ status: 0 });
    } finally {
      server?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);

  // ⭐⭐⭐ **`--remote <name>` 이 «실물 CLI 배선»을 거쳐 응답을 받아 «렌더한다»**.
  //   ⛔ 판정은 «둘»이다 — ⓐ 서버가 받은 것(hits) ⊕ ⓑ 자식이 그린 것. 하나만으론 각각 우회된다.
  //   📏 이 형태에 이른 궤적(복제 action → in-process 목 → 오류문만 봄)은 PR #14994 본문에 있다.
  it('LIVE CLI: `--remote <name>` fetches from THAT bookmark and renders the response', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-live-ok-'));
    const cfg = join(home, '.elanous');
    const hits = join(home, 'hits.jsonl');
    const serverJs = join(home, 'server.mjs');
    writeFileSync(serverJs, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      const srv = Bun.serve({ port: 0, fetch(req) {
        const u = new URL(req.url);
        appendFileSync(${JSON.stringify(hits)}, JSON.stringify({ path: u.pathname, auth: req.headers.get('authorization') }) + '\\n');
        return Response.json({ ok: true, count: 1, logs: [{ id: 7, ts: '2026-09-01T00:00:00.000Z', level: 'info', surface: 'nexus', category: 'named.probe', event: 'via-real-cli', data: {} }] });
      }});
      writeFileSync(${JSON.stringify(join(home, 'port'))}, String(srv.port));
    `);
    const server = spawn(process.execPath, [serverJs], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      // 포트가 «생길 때까지» 기다린다 — ⛔ 조건이 t=0 에 거짓이어야 한다(파일이 아직 없다).
      const portFile = join(home, 'port');
      const deadline = Date.now() + 30_000;
      while (!existsSync(portFile) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(portFile)).toBe(true);
      const port = readFileSync(portFile, 'utf8').trim();
      expect(port).toMatch(/^\d+$/);

      mkdirSync(join(cfg, 'remotes'), { recursive: true });
      writeFileSync(join(cfg, 'remotes', 'named.token'), 'named-token');
      writeFileSync(join(cfg, 'remotes', 'other.token'), 'other-token');
      writeFileSync(join(cfg, 'remotes.json'), JSON.stringify({
        version: 1,
        default: 'other',
        remotes: {
          other: { host: '127.0.0.1:19001', acp_url: 'ws://127.0.0.1:19001/v1/acp', token_file: join(cfg, 'remotes', 'other.token'), addedAt: '2026-09-01T00:00:00Z' },
          named: { host: `127.0.0.1:${port}`, acp_url: `ws://127.0.0.1:${port}/v1/acp`, token_file: join(cfg, 'remotes', 'named.token'), addedAt: '2026-09-01T00:00:00Z' },
        },
      }));

      const res = spawnSync(process.execPath, ['bin/elanous.mjs', 'logs', '--remote', 'named', '--limit', '1'], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: cfg, ELANOUS_CONFIG_DIR: cfg, TZ: 'UTC' },
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
      });
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
      expect(out.length).toBeGreaterThan(0);

      expect(existsSync(hits)).toBe(true);
      const received = readFileSync(hits, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(received).toEqual([{ path: '/v1/logs', auth: 'Bearer named-token' }]);

      expect(out).toContain('via-real-cli');
      expect(out).toContain('⟨remote:named⟩');
      expect({ status: res.status, out: out.slice(0, 400) }).toMatchObject({ status: 0 });
    } finally {
      try { server.kill('SIGKILL'); } catch { /* 이미 죽었다 */ }
      rmSync(home, { recursive: true, force: true });
    }
  }, 180_000);


  // ⭐ **무응답 원격은 «시간»으로 실패한다** (리뷰 should-fix).
  //   ⛔ 상한이 없으면 「실패를 말한다」가 성립하지 않는다 — CLI 가 영영 기다리고 사람은 「느리다」로 읽는다.
  it('목 HTTP 서버 북마크의 /v1/logs 줄이 산출에 나온다', async () => {
    const seen: Array<{ path: string; auth: string | null; search: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get('authorization'), search: url.search });
        if (url.pathname === '/v1/logs') {
          return Response.json({
            ok: true,
            logs: [{
              id: 42,
              ts: '2026-09-01T00:00:00.000Z',
              level: 'info',
              surface: 'nexus',
              category: 'remote.probe',
              event: 'from-mock-server',
              data: { stateDir: '/home/box/.elanous' },
            }],
            count: 1,
          });
        }
        return new Response('not-found', { status: 404 });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-remote-ok-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'http-token');
    const store = new RemotesStore();
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `ws://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: new Date(0).toISOString(),
    }, { setDefault: true });
    const io = captureIo();
    try {
      const code = await runLogsCli({ r: true }, { remotesStore: () => store });
      expect(code).toBe(0);
      expect(seen).toEqual([{ path: '/v1/logs', auth: 'Bearer http-token', search: '' }]);
      expect(io.stdout.join('')).toContain('from-mock-server');
      expect(io.stdout.join('')).toContain('remote.probe');
      expect(io.stdout.join('')).not.toContain('stateDir=/home/box/.elanous');
      expect(io.stdout.join('')).toContain('⟨remote:iso⟩');
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
      server.stop(true);
    }
  });

  it('401 은 로컬 로그로 폴백하지 않고 북마크 이름과 실패를 말한다', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() { return Response.json({ error: 'unauthorized' }, { status: 401 }); },
    });
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-remote-401-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'bad-token');
    const store = new RemotesStore();
    store.addRemote('iso', {
      host: 'iso',
      acp_url: `http://127.0.0.1:${server.port}/v1/acp`,
      token_file: tok,
      addedAt: new Date(0).toISOString(),
    }, { setDefault: true });
    const localHits: string[] = [];
    const io = captureIo();
    try {
      const code = await runLogsCli({ r: true }, {
        remotesStore: () => store,
        resolveTargets: () => {
          localHits.push('local');
          return { targets: [{ name: 'prod', dbPath: '/tmp/must-not-open.db' }] };
        },
      });
      expect(code).not.toBe(0);
      expect(localHits).toEqual([]);
      expect(io.stdout.join('')).toBe('');
      expect(io.stderr.join('')).toContain('iso');
      expect(io.stderr.join('')).toMatch(/HTTP 401|unauthorized/i);
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
      server.stop(true);
    }
  });

  it('-r 과 --follow 는 북마크 이름을 대고 거절한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-logs-remote-follow-'));
    const prev = getElanousConfigDirOverride();
    setElanousConfigDir(dir);
    const tok = join(dir, 'tok');
    writeFileSync(tok, 'http-token');
    const store = new RemotesStore();
    store.addRemote('iso', {
      host: 'iso',
      acp_url: 'ws://127.0.0.1:31415/v1/acp',
      token_file: tok,
      addedAt: new Date(0).toISOString(),
    }, { setDefault: true });
    const fetches: string[] = [];
    const io = captureIo();
    try {
      const code = await runLogsCli({ r: true, follow: true }, {
        remotesStore: () => store,
        fetchRemoteLogs: async (url) => {
          fetches.push(url);
          return { ok: true, logs: [] };
        },
      });
      expect(code).not.toBe(0);
      expect(fetches).toEqual([]);
      expect(io.stderr.join('')).toContain('iso');
      expect(io.stderr.join('')).toMatch(/follow.*not supported|지원되지 않/i);
    } finally {
      io.restore();
      if (prev === undefined) resetElanousConfigDir();
      else setElanousConfigDir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('-r 없이 부르면 원격 조회 함수가 안 불린다', async () => {
    const fetches: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'elanous-logs-no-remote-'));
    const dbPath = join(home, '.elanous', 'logs', 'logs.db');
    const writer = new LogStore(dbPath);
    writer.insertBatch([{ rec: { ts: '2026-09-01T00:00:00.000Z', category: 'local.only', event: 'stay-local' }, surface: 'nexus' }]);
    writer.close();
    const io = captureIo();
    try {
      const code = await runLogsCli({ limit: '1' }, {
        resolveTargets: () => ({ targets: [{ name: 'prod', dbPath }] }),
        fetchRemoteLogs: async (url) => {
          fetches.push(url);
          return { ok: true, logs: [{ event: 'must-not-appear' }] };
        },
      });
      expect(code).toBe(0);
      expect(fetches).toEqual([]);
      expect(io.stdout.join('')).toContain('stay-local');
      expect(io.stdout.join('')).not.toContain('must-not-appear');
    } finally {
      io.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('원격 응답에서 없는 칸은 unknown, 빈 칸은 빈 값으로 구별한다', () => {
    const missing = formatRemoteLogLine({ event: 'only-event' }, 'iso', false, 'UTC');
    expect(missing).toContain('unknown');
    expect(missing).toContain('only-event');
    const empty = formatRemoteLogLine({
      ts: '2026-09-01T00:00:00.000Z',
      level: 'info',
      surface: '',
      category: 'cat',
      event: 'evt',
    }, 'iso', false, 'UTC');
    expect(empty).toContain('[]');
    expect(empty).not.toMatch(/\[unknown\]/);
    const jsonNull = formatRemoteLogLine({
      ts: '2026-09-01T00:00:00.000Z',
      level: 'info',
      surface: null,
      category: 'cat',
      event: 'evt',
    }, 'iso', false, 'UTC');
    expect(jsonNull).toContain('[unknown]');
    expect(jsonNull).not.toContain('[]');
    const jsonMissing = JSON.parse(renderRemoteLogJsonLine({ event: 'only-event' }, 'iso')) as Record<string, unknown>;
    expect(jsonMissing.surface).toBe('unknown');
    expect(jsonMissing.event).toBe('only-event');
    const jsonEmpty = JSON.parse(renderRemoteLogJsonLine({ surface: '', event: 'evt' }, 'iso')) as Record<string, unknown>;
    expect(jsonEmpty.surface).toBe('');
    expect(jsonEmpty.event).toBe('evt');
    const jsonNullRow = JSON.parse(renderRemoteLogJsonLine({ surface: null, event: 'evt' }, 'iso')) as Record<string, unknown>;
    expect(jsonNullRow.surface).toBeNull();
    expect(jsonNullRow.event).toBe('evt');
  });

  it('CLI 는 값 없는 -r 과 이름을 받는 --remote 를 런타임에 넘긴다', () => {
    const logs = program.commands.find((c) => c.name() === 'logs');
    expect(logs).toBeDefined();
    const flags = logs!.options.map((o) => ({ short: o.short, long: o.long, required: o.required, optional: o.optional }));
    expect(flags).toContainEqual({ short: '-r', long: undefined, required: false, optional: false });
    expect(flags).toContainEqual({ short: undefined, long: '--remote', required: true, optional: false });
    expect(resolveLogsRemoteFlag({ r: true })).toBe(true);
    expect(resolveLogsRemoteFlag({ remote: 'iso' })).toBe('iso');
    expect(resolveLogsRemoteFlag({})).toBeUndefined();
  });

  it('logs level asks the injected daemon and does not guess 31415', async () => {
    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ ok: true, level: 'info', gates: {} }), { status: 200 });
    }) as typeof fetch;
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    setResolveDaemonEndpointForTest(() => ({
      baseUrl: 'http://127.0.0.1:45678', healthUrl: 'http://127.0.0.1:45678/v1/health', pwaUrl: 'http://127.0.0.1:45678/app/', source: 'registry',
    }));
    try {
      expect(await runLogsLevel(undefined, {})).toBe(0);
      expect(fetched).toEqual(['http://127.0.0.1:45678/v1/logs/level']);
      expect(fetched.join(' ')).not.toContain('31415');
    } finally {
      setResolveDaemonEndpointForTest(null);
      globalThis.fetch = original;
      spy.mockRestore();
      log.mockRestore();
    }
  });

  it('logs level with no daemon does not call 31415', async () => {
    const fetched: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const errors: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
    setResolveDaemonEndpointForTest(() => null);
    try {
      expect(await runLogsLevel(undefined, {})).toBe(1);
      expect(fetched).toEqual([]);
      expect(errors.join(' ')).not.toContain('31415');
    } finally {
      setResolveDaemonEndpointForTest(null);
      globalThis.fetch = original;
      spy.mockRestore();
    }
  });
});
