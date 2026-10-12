// 세션 출처 인스턴스 태깅 (2026-07-16) — 멀티 엘라누스(글로벌 데몬 + 폴더별 --test)에서
// "이 세션을 누가 만들었나"를 SessionMeta.originInstance 에 박제한다. LF7 로그 `instance`
// 컬럼과 동일 유도(instance-identity SSoT).
//
// 정체성은 리졸브된 state 루트에서 온다. 2026-10-12부터 트리 위치만으로
// 시험 우주를 만들지 않는다. 명시 --test/상속된 시험 루트는 test 이름을 유지한다.
//
// 저장 위치(ELANOUS_SESSION_ROOT)와 인스턴스 이름(state 루트)을 독립 제어 —
// SESSION_ROOT 가 저장은 이기고, state 루트가 이름을 준다.

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 시험 실행기의 격리 스탬프와 별개로 운영 우주를 결정론적으로 표현한다. */
const PROD_ROOT = join(homedir(), '.elanous');

const ORIG_STATE = process.env.ELANOUS_STATE_DIR;
const ORIG_SESS = process.env.ELANOUS_SESSION_ROOT;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sess-origin-'));
  process.env.ELANOUS_SESSION_ROOT = tmp;
  // 오버라이드 상태 초기화(다른 테스트가 setInstanceName 했을 수 있음).
  const { setInstanceName } = await import('../src/instance-identity.js');
  setInstanceName(undefined);
});
afterEach(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (ORIG_STATE === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = ORIG_STATE;
  if (ORIG_SESS === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = ORIG_SESS;
  const { setInstanceName } = await import('../src/instance-identity.js');
  setInstanceName(undefined);
});

describe('resolveInstanceName — 격리 경계 = 리졸브된 state 루트', () => {
  test('운영 루트 → prod (글로벌 데몬·크론 은 전부 공유 = prod)', async () => {
    process.env.ELANOUS_STATE_DIR = PROD_ROOT;
    const { resolveInstanceName } = await import('../src/instance-identity.js');
    expect(resolveInstanceName()).toBe('prod');
  });

  test('★후행 슬래시가 붙어도 운영 루트는 prod (경로 정규화 경유)', async () => {
    process.env.ELANOUS_STATE_DIR = `${PROD_ROOT}/`;
    const { resolveInstanceName } = await import('../src/instance-identity.js');
    expect(resolveInstanceName()).toBe('prod');
  });

  test('<repo>/.elanous-test → test:<repo>', async () => {
    process.env.ELANOUS_STATE_DIR = '/Users/x/source/axon/monad-agent/.elanous-test';
    const { resolveInstanceName } = await import('../src/instance-identity.js');
    expect(resolveInstanceName()).toBe('test:monad-agent');
  });

  test('그 외 stateDir → test:<dir 이름> (예: telegram-test)', async () => {
    process.env.ELANOUS_STATE_DIR = '/Users/x/.elanous/telegram-test';
    const { resolveInstanceName } = await import('../src/instance-identity.js');
    expect(resolveInstanceName()).toBe('test:telegram-test');
  });

  test('setInstanceName 오버라이드가 최우선(config logs.instanceName 경로)', async () => {
    process.env.ELANOUS_STATE_DIR = '/Users/x/foo/.elanous-test';
    const { resolveInstanceName, setInstanceName } = await import('../src/instance-identity.js');
    setInstanceName('prod-main');
    expect(resolveInstanceName()).toBe('prod-main');
    setInstanceName('  ');           // 공백 = 무시
    expect(resolveInstanceName()).toBe('test:foo');
  });

  // 기본 우주와 이름의 일치 가드. --test 없이 소스 트리만으로 test가 되어선 안 된다.
  //
  // ⚠️ 반드시 서브프로세스여야 한다 — Bun 의 `os.homedir()` 는 in-process HOME 변경을 무시하고
  //   프로세스 시작 시점 값을 본다(같은 프로세스 안에서는 HOME 격리 불가·subprocess 는 통함).
  test('env 와 --test 없이 트리에서 실행해도 경로와 이름은 운영 집으로 간다', () => {
    const home = mkdtempSync(join(tmpdir(), 'ident-home-'));
    try {
      mkdirSync(join(home, '.elanous'));
      writeFileSync(join(home, '.elanous', 'config.json'), JSON.stringify({ instance: { treeDerivedTest: true } }));
      // 리더를 남의 트리로 못박아 이 트리를 비-리더로 만든다(3층 파생 조건).
      writeFileSync(join(home, '.elanous', 'leader.json'), JSON.stringify({ tree: '/some/other/leader', promotedAt: 'x' }));
      const script = `
        const {resolveInstanceName}=require('${process.cwd()}/src/instance-identity.ts');
        const {effectiveInstanceRoot}=require('${process.cwd()}/src/instance/resolve.ts');
        console.log(JSON.stringify({n:resolveInstanceName(),r:effectiveInstanceRoot()}));
      `;
      const r = spawnSync('bun', ['-e', script], {
        encoding: 'utf8', timeout: 60_000, cwd: process.cwd(),
        // ⚠️ 리졸버의 **상위 층 전부**를 비운다(리뷰 must-fix) — 하나라도 호스트 env 가 새어
        //   들어오면 3층 파생이 안 일어나 이 테스트가 무엇을 쟀는지 알 수 없게 된다.
        //   이 테스트의 전제는 "명시 우주가 하나도 없다" 이다.
        env: {
          ...process.env, HOME: home,
          ELANOUS_STATE_DIR: '', ELANOUS_CONFIG_DIR: '', ELANOUS_NEXUS_DIR: '', ELANOUS_SESSION_ROOT: '',
        },
      });
      const out = JSON.parse((r.stdout ?? '').trim().split('\n').pop() ?? '{}') as { n?: string; r?: string };
      expect(out.r).toBe(join(home, '.elanous'));
      expect(out.n).toBe('prod');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('createSession stamps originInstance + listSessions filters', () => {
  test('운영 루트 → 세션이 prod 로 태깅', async () => {
    process.env.ELANOUS_STATE_DIR = PROD_ROOT;
    const { createSession, loadSession } = await import('../src/session/index.js');
    const meta = createSession({ source: 'cli' }, tmp);
    expect(meta.originInstance).toBe('prod');
    // 재로드해도 보존.
    expect(loadSession(meta.id, tmp)!.meta.originInstance).toBe('prod');
  });

  test('ELANOUS_STATE_DIR 격리 → test:<repo> 로 태깅(저장은 SESSION_ROOT)', async () => {
    process.env.ELANOUS_STATE_DIR = join(tmp, 'source', 'foo', '.elanous-test');
    const { createSession } = await import('../src/session/index.js');
    const meta = createSession({ source: 'cli' }, tmp);
    expect(meta.originInstance).toBe('test:foo');
  });

  test('listSessions({originInstance}) 로 출처 필터 — 공유 스토어에서 prod/test 분리', async () => {
    const { createSession, listSessions } = await import('../src/session/index.js');
    process.env.ELANOUS_STATE_DIR = PROD_ROOT;
    const p = createSession({ source: 'cli', title: 'prod-one' }, tmp);
    process.env.ELANOUS_STATE_DIR = join(tmp, 'source', 'foo', '.elanous-test');
    const t = createSession({ source: 'cli', title: 'test-one' }, tmp);

    const prodOnly = listSessions({ originInstance: 'prod' }, tmp);
    expect(prodOnly.map(m => m.id)).toContain(p.id);
    expect(prodOnly.map(m => m.id)).not.toContain(t.id);

    const testOnly = listSessions({ originInstance: 'test:foo' }, tmp);
    expect(testOnly.map(m => m.id)).toContain(t.id);
    expect(testOnly.map(m => m.id)).not.toContain(p.id);
  });

  test('구 세션(originInstance 부재)은 인스턴스 필터에 비매치(tolerant)', async () => {
    const { listSessions } = await import('../src/session/index.js');
    // index.json 에 originInstance 없는 레코드를 직접 심는다.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tmp, 'index.json'), JSON.stringify([
      { id: 'old-1', title: 'legacy', source: 'cli', createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z', provider: 'auto', model: '', messageCount: 0 },
    ]));
    expect(listSessions({}, tmp).map(m => m.id)).toContain('old-1');       // 필터 없으면 보임
    expect(listSessions({ originInstance: 'prod' }, tmp).map(m => m.id)).not.toContain('old-1');
  });
});

describe('dispatchSessionQuery — instance 필터(list)', () => {
  test('list action 이 instance 로 필터', async () => {
    const { createSession, appendMessage } = await import('../src/session/index.js');
    const { dispatchSessionQuery } = await import('../src/domains/session-query-tool.js');
    delete process.env.ELANOUS_STATE_DIR;
    const p = createSession({ source: 'cli', title: 'prod-x' }, tmp);
    appendMessage(p.id, { role: 'user', content: 'hi prod' }, tmp);   // 비어있지 않게(hideEmpty 기본)
    process.env.ELANOUS_STATE_DIR = join(tmp, 'source', 'bar', '.elanous-test');
    const t = createSession({ source: 'cli', title: 'test-x' }, tmp);
    appendMessage(t.id, { role: 'user', content: 'hi test' }, tmp);

    const res = await dispatchSessionQuery({ action: 'list', instance: 'test:bar' }, { root: tmp }) as {
      sessions: Array<{ title: string; originInstance?: string }>;
    };
    expect(res.sessions.length).toBe(1);
    expect(res.sessions[0].title).toBe('test-x');
    expect(res.sessions[0].originInstance).toBe('test:bar');
  });
});
