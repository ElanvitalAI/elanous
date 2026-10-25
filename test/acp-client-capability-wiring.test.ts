// ⭐⭐⭐ 배선 시험 — 「협상 결과를 관측으로 흘리는 코드가 «실행 경로에 있는가»」.
//
// ⛔ 자매 파일 `acp-client-capability-observer.test.ts` 는 private `recordCapabilities()` 를
//    «직접» 불러서, `start()` 안의 그 호출을 지워도 통과한다(리뷰 must-fix — Goodhart).
//    이 파일은 실물 스텁 프로세스를 띄워 ***진짜 initialize 핸드셰이크***를 돌린다.
//    ⇒ `start()` 의 `this.recordCapabilities(...)` 를 지우면 «실패한다»(반증 실측 완료).
//
// 근거 = CLAUDE.md — *"반증 자기검증은 「테스트가 코드를 무는가」만 답하고
//        「그 코드가 실행 경로에 있는가」는 구조적으로 못 답한다"*.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcpAgent, readClientInfo } from '../src/acp/client.js';
import { ACP_BACKENDS } from '../src/acp/backend-registry.js';
import type { ElanousCapabilities } from '../src/acp/capabilities.js';
import { debug } from '../src/debug/log.js';

const STUB_ID = 'test-initialize-stub';
const stubPath = join(import.meta.dir, 'fixtures', 'acp-initialize-stub.ts');

// ⛔ 전역 레지스트리를 «파일 로드 시점»에 바꾸면 병렬 실행에서 남의 테스트가 이 항목을 본다
//    (리뷰 should-fix ④). ⇒ 등록·해제를 이 describe 의 수명으로 «좁힌다».
beforeAll(() => {
  // `resolveBinPath()` 는 node_modules/.bin 에 없으면 PATH 로 떨어진다 ⇒ `bun` 을 그대로 쓴다.
  ACP_BACKENDS[STUB_ID] = {
    id: STUB_ID,
    label: 'initialize stub (test only)',
    command: 'bun',
    args: [stubPath],
    npmPackage: '',
    npmVersion: '',
  };
});
afterAll(() => { delete ACP_BACKENDS[STUB_ID]; });

// 버전은 package.json 에서 읽는다 — 릴리스마다 바뀐다(MANUAL-versioning-and-release · 0.1.0 첫 공개판).
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string }).version;

describe('AcpAgent — 협상 관측 배선 (실물 initialize 경로)', () => {
  test('Elanous 소유 메타데이터만 사용하고 누락·오류에도 fallback한다', () => {
    expect(readClientInfo(() => ({ name: 'elanous', version: '9.8.7' }))).toEqual({
      name: 'elanous', version: '9.8.7',
    });
    expect(readClientInfo(() => ({}))).toEqual({ name: 'elanous', version: '0.0.0' });
    expect(readClientInfo(() => { throw new Error('metadata unavailable'); })).toEqual({
      name: 'elanous', version: '0.0.0',
    });
  });

  test('협상 «전»에는 안 부르고, 성공 «후»에 정규화된 값으로 «한 번» 부른다', async () => {
    const observed: ElanousCapabilities[] = [];
    const logs: string[] = [];
    const debugEvents: Array<{ category: string; event: string; data: unknown }> = [];
    const debugSpy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      debugEvents.push({ category, event, data });
    });
    const agent = new AcpAgent({
      backendId: STUB_ID,
      cwd: process.cwd(),
      log: (message) => logs.push(message),
      // ⭐ 스텁이 advertise 할 값을 «테스트가» 정한다 — 그래야 아래 단언이 스텁 기본값이 아니라
      //    ***이 응답의 정규화 결과***를 무는 것이 된다(리뷰 should-fix ③ · 미사용 표면 제거).
      env: {
        ACP_STUB_CAPS: JSON.stringify({
          promptCapabilities: { image: true, audio: false },
          loadSession: false,
          sessionCapabilities: { fork: {}, list: {}, resume: {} },
          mcpCapabilities: { http: true, sse: true },
        }),
        ACP_STUB_REQUIRE_CLIENT_INFO: '1',
      },
      onCapabilities: (capabilities) => observed.push(capabilities),
    });

    // ⭐ 협상 전 — 생성만으로는 안 불린다.
    expect(observed).toEqual([]);

    try {
      await agent.start();

      expect(logs).toContain(`initializing — clientInfo name=elanous version=${PACKAGE_VERSION}`);
      const deadline = Date.now() + 1_500;
      while (!debugEvents.some(event => event.category === 'acp.stderr') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(debugEvents).toContainEqual({ category: 'acp.stderr', event: 'line', data: {
        backendId: STUB_ID,
        line: `received initialize clientInfo={"name":"elanous","version":"${PACKAGE_VERSION}"}`,
      } });
      expect(observed).toHaveLength(1);
      const snapshot = observed[0]!;
      expect(snapshot.protocolVersion).toBe(1);
      expect(snapshot.prompt.image).toBe(true);
      expect(snapshot.prompt.audio).toBe(false);
      expect(snapshot.loadSession).toBe(false);
      expect(snapshot.session).toEqual({ fork: true, list: true, resume: true });
      expect(snapshot.mcp).toEqual({ http: true, sse: true });
      // ⭐ 정규화 — ACP 베이스라인은 text·resourceLink 가 «항상 참»이다.
      expect(snapshot.prompt.text).toBe(true);
      expect(snapshot.prompt.resourceLink).toBe(true);

      // ⛔ 관측자가 스냅샷을 바꿔도 게이트가 안 바뀐다(must-fix ① 계약).
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.prompt)).toBe(true);
      expect(agent.getCapabilities()?.prompt.image).toBe(true);

      // ⭐ start() 는 멱등 — 두 번 불러도 관측이 늘지 않는다.
      await agent.start();
      expect(observed).toHaveLength(1);
    } finally {
      debugSpy.mockRestore();
      await agent.stop().catch(() => { /* noop */ });
    }
  }, 20_000);
});
