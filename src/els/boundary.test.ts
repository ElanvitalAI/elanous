// ELS-PRODUCT-SPLIT 경계 가드 — 대표 2026-11-18 «사이드탭 제품 분리».
// els = 바깥 액자(에이전트 무관), eln = 세션·턴·도구·기억·그래프 코어 하나. 경계는 프로세스·프로토콜(소켓)이지
// 코드 import 가 아니다 — 그래서 코드 import 는 양쪽 다 늘지 않게 단속한다(정본 내부 문서 `SIDETAB-ONE-SPACE`
// «지금의 경계» 절 · 래칫: 줄어들기만 허용).
//
// 방향 1 (els→eln): src/els/** 는 eln 코어 실행 모듈을 런타임 import 하지 않는다(목표 = 0).
//   경계를 넘는 것은 소켓 프로토콜의 상태·알림 이벤트뿐이다(child-producer 의 `child` op).
//   타입 공유(import type)는 같은 저장소·같은 열차 안에서 허용한다.
// 방향 2 (eln→els): src/els/** 를 src/els 밖에서 import 하는 비-시험 파일은 기준선(아래 표)에서
//   늘지 않는다 — «새 import 는 만들지 않는다»(import type 도 새 import 다). 시험 배선(.test.ts)은 제외.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compareToBaseline, scanImports, tallyImports, walkSources } from './boundary-scan.js';

const repoRoot = join(import.meta.dir, '..', '..');
const elsDir = join(repoRoot, 'src', 'els');

// eln 코어(세션·턴·도구·기억·그래프·에이전트 두뇌) — 상대 import 경로의 디렉터리/파일 세그먼트.
const CORE_SEGMENTS = [
  'agent', // 에이전트 두뇌·하위 에이전트 실행 (src/agents/ 아님 — 세그먼트 정확 매치)
  'core-turn', 'execution-loop', 'turn-checkpoint', // 턴
  'session', 'session-store', 'session-runtime', // 세션
  'llm', // 모델 호출
  'skills', 'tool-runtime', 'tool-router', // 도구
  'memory', 'memory-triage', 'seat-memory', 'knowledge', 'knowhow', // 기억
  'graph-runner', 'graph-unify', 'graph-v2', 'graph-kinds', 'graph-view', 'graph-wizard', // 그래프
] as const;

// ⚠ ELS-PRODUCT-SPLIT 칸은 두 기준선이 0 이 되기 전까지 🟡 — 이 가드 착지 ≠ 칸 완료.
// 두 기준선 모두 제거 칸 = ELS-ELN-BOUNDARY-BASELINE-ZERO (0.3.32 P1). 새 결합 0 · 줄어들기만.
// 기준선 단위 = '파일|지정자(쓴 그대로)|종류(static/side-effect/dynamic/require)' 별 허용 건수 — 기준선 파일 안의 새 import ·
// 같은 지정자를 한 번 더 쓰는 것도 초과(FAIL). 줄면 시험이 표를 줄이라고 알린다(JUD-B #115264).
// 출처 = 2026-11-21 origin/main(e2d2a4a2a9) 재실측(리베이스) → 2026-11-22 origin/main(5e27f8c93cb7) 재실측
// (게이트 merge-main 이 main 신규 유입 9건을 데려옴 — RED 영수 PREGATE-RED/39408-d774c28185b5) + 유입 PR(git log -S 실측 · 모르면 미확인).
// 방향 1 기준선 — 목표 = 0.
// 출처: src/els/server.ts:162,252 · #39311 ELS-PTY-RECORD — els 서버가 PTY 녹화 런타임을 직접 require. 프로토콜 호출로 바꿔 끊을 대상.
const ELS_TO_ELN_BASELINE: Record<string, number> = {
  // src/els/server.ts — 유입 출처: 미확인
  'src/els/server.ts|../tool-runtime/pty-recording-runtimes.js|require': 2,
  // src/els/server.ts — 유입 출처: #39479(OP 채널을 ELS 좌석 경유 — identity-env 직접 static 참조)
  'src/els/server.ts|../agent/identity-env.js|static': 1,
};

// 방향 2 기준선 — eln→els(타입 import 포함). 출처는 파일 머리 주석.
const ELN_TO_ELS_BASELINE: Record<string, number> = {
  // src/boot/daemon-tools/index.ts — 유입 출처: #39087
  'src/boot/daemon-tools/index.ts|../../els/els-control-tool.js|static': 1,
  // src/tui/entry.ts — 유입 출처: graph-producer #39320 · build-reporter #38986 · client/server.js 유입 PR 미확인
  'src/tui/entry.ts|../els/graph-producer.js|dynamic': 1,
  'src/tui/entry.ts|../els/client.js|dynamic': 1,
  'src/tui/entry.ts|../els/server.js|dynamic': 1,
  'src/tui/entry.ts|../els/build-reporter.js|dynamic': 1,
  // src/tui/els-handoff.ts — 유입 출처: #39329 (ELS-NESTING-RULE; supervisor.js 는 그 뒤 유입 — 미확인)
  'src/tui/els-handoff.ts|../els/client.js|static': 1,
  'src/tui/els-handoff.ts|../els/human-terminal-auth.js|static': 1,
  'src/tui/els-handoff.ts|../els/nesting.js|static': 1,
  'src/tui/els-handoff.ts|../els/server.js|static': 1,
  'src/tui/els-handoff.ts|../els/supervisor.js|static': 1,
  // src/tui/sidetab/els-rows.ts — 유입 출처: 칸 1 교량: eln --side 가 els 를 구독 · 11-18 기준선
  'src/tui/sidetab/els-rows.ts|../../els/address.js|static': 1,
  'src/tui/sidetab/els-rows.ts|../../els/status-vocab.js|static': 1,
  // src/tui/sidetab/els-actions.ts — 유입 출처: #38431
  'src/tui/sidetab/els-actions.ts|../../els/core.js|static': 1,
  // src/tui/sidetab/els-subscribe.ts — 유입 출처: 칸 1 교량 · 11-18 기준선
  'src/tui/sidetab/els-subscribe.ts|../../els/client.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/federation.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/herdr-host.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/hosts.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/human-terminal-auth.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/server.js|static': 1,
  'src/tui/sidetab/els-subscribe.ts|../../els/subscribe-client.js|static': 1,
  // src/prompt-library/universal-preamble.ts — 유입 출처: #39105
  'src/prompt-library/universal-preamble.ts|../els/els-self-context.js|static': 1,
  // src/cli/els-cli.ts — 유입 출처: els 제품 자신의 CLI 진입 · 기준선 11-18(#38431 이전부터)
  'src/cli/els-cli.ts|../els/skill.js|static': 1,
  'src/cli/els-cli.ts|../els/pane-status.js|static': 1,
  'src/cli/els-cli.ts|../els/attach-app.js|static': 1,
  'src/cli/els-cli.ts|../els/attach-client.js|static': 1,
  'src/cli/els-cli.ts|../els/attach-leave.js|static': 1,
  'src/cli/els-cli.ts|../els/attach-view.js|static': 1,
  'src/cli/els-cli.ts|../els/client.js|static': 1,
  'src/cli/els-cli.ts|../els/pane-grep.js|static': 1,
  'src/cli/els-cli.ts|../els/core.js|static': 1,
  'src/cli/els-cli.ts|../els/tab-badge.js|static': 1,
  'src/cli/els-cli.ts|../els/space.js|static': 2,
  'src/cli/els-cli.ts|../els/control-cli.js|static': 1,
  'src/cli/els-cli.ts|../els/mcp-hitl.js|static': 1,
  'src/cli/els-cli.ts|../els/cli-args.js|static': 1,
  'src/cli/els-cli.ts|../els/federation.js|static': 1,
  'src/cli/els-cli.ts|../els/journal.js|static': 1,
  'src/cli/els-cli.ts|../els/herdr-host.js|static': 1,
  'src/cli/els-cli.ts|../els/herdr-import.js|static': 1,
  'src/cli/els-cli.ts|../els/herdr-shape.js|static': 1,
  'src/cli/els-cli.ts|../els/keys.js|static': 1,
  'src/cli/els-cli.ts|../els/hosts.js|static': 1,
  'src/cli/els-cli.ts|../els/http.js|static': 1,
  'src/cli/els-cli.ts|../els/human-terminal-auth.js|static': 1,
  'src/cli/els-cli.ts|../els/nesting.js|static': 1,
  'src/cli/els-cli.ts|../els/mcp-serve.js|static': 1,
  'src/cli/els-cli.ts|../els/server.js|static': 1,
  'src/cli/els-cli.ts|../els/supervisor.js|static': 1,
  // src/cli/els-cli.ts — 유입 출처: #39452(핀 SSH 원격 호스트 갱신) · #39417(턴 경계 로컬 좌석탭 마이그레이션)
  'src/cli/els-cli.ts|../els/remote-update.js|static': 1,
  'src/cli/els-cli.ts|../els/update-all.js|static': 1,
  // src/dashboard/index.ts — 유입 출처: 11-18 기준선(SIDETAB-ONE-SPACE «지금의 경계»)
  'src/dashboard/index.ts|../els/child-producer.js|static': 1,
  'src/dashboard/index.ts|../els/server.js|static': 1,
  // src/nexus/worker-registry/store.ts — 유입 출처: #39073
  'src/nexus/worker-registry/store.ts|../../els/hosts.js|static': 1,
  // src/loops/msg-wake.ts — 유입 출처: #39012 · #39442(좌석 생명을 ELS·호스트 원장 경유)
  'src/loops/msg-wake.ts|../els/client.js|static': 1,
  'src/loops/msg-wake.ts|../els/server.js|static': 1,
  'src/loops/msg-wake.ts|../els/herdr-host.js|static': 1,
  // src/acp/els-acp-serve.ts — 유입 출처: #38829
  'src/acp/els-acp-serve.ts|../els/mcp-serve.js|static': 1,
  // src/repl/index.ts — 유입 출처: #39446(Next TUI 도구 목록에 ElsControl 노출 — require + typeof)
  'src/repl/index.ts|../els/els-control-tool.js|require': 1,
  'src/repl/index.ts|../els/els-control-tool.js|typeof': 1,
  // src/shell-primitive/runtime.ts — 유입 출처: #39448(좌석 소유 ELS 통제 — seat-runtime static)
  'src/shell-primitive/runtime.ts|../els/seat-runtime.js|static': 1,
  // src/tui/ceo-turn-reply.ts — 유입 출처: #39479(OP 채널 ELS 좌석 경유 · 영속 회신 증명)
  'src/tui/ceo-turn-reply.ts|../els/ceo-reply-proof.js|static': 1,
  // src/ux-sim/sim-world/op-channel/scenarios.ts — 유입 출처: #39420(OP 채널 제품문 3축 시험)
  'src/ux-sim/sim-world/op-channel/scenarios.ts|../../../els/ceo-channel.js|static': 1,
};

const isCoreSpecifier = (spec: string): boolean => {
  if (!spec.startsWith('..')) return false;
  const path = spec.replace(/\.(js|ts)$/, '');
  for (const segment of CORE_SEGMENTS) {
    if (path.includes(`../${segment}/`) || path.endsWith(`../${segment}`)) return true;
  }
  return false;
};

const rel = (file: string) => relative(repoRoot, file);

const readAll = (files: string[]) => files.map((f) => ({ path: rel(f), text: readFileSync(f, 'utf8') }));
const isTest = (f: string) => /\.test\.tsx?$/.test(f);

const check = (actual: Record<string, number>, baseline: Record<string, number>, name: string, hint: string) => {
  const { over, under } = compareToBaseline(actual, baseline);
  for (const k of under) console.warn(`[boundary] ${name} 기준선 ${k} 이(가) 줄었다 — 표를 줄여 갱신하라(래칫)`);
  expect(over, over.length ? `새 결합 금지(${hint}): ${over.map((k) => `${k} (${actual[k]}>${baseline[k] ?? 0})`).join(', ')}` : '').toEqual([]);
};

test('방향 1 — src/els 는 eln 코어를 런타임 import 하지 않는다 (경계 = 프로토콜 · 기준선 초과 금지)', () => {
  const files = readAll(walkSources(elsDir).filter((f) => !isTest(f))); // 시험 배선은 대상 아님
  const actual = tallyImports(files, (s) => !s.typeOnly && isCoreSpecifier(s.spec)); // 타입 공유는 허용
  check(actual, ELS_TO_ELN_BASELINE, 'ELS_TO_ELN_BASELINE', 'els 는 프로토콜로');
});

test('방향 2 — src/els 로의 import 는 (파일·지정자·종류)별 기준선에서 늘지 않는다 (줄어들기만)', () => {
  const files = readAll(walkSources(join(repoRoot, 'src')).filter((f) => !isTest(f) && !f.startsWith(elsDir)));
  // ../els/… · ../../els/… — 상대 경로로 src/els 안 모듈을 가리키는 지정자(타입 import 포함).
  const actual = tallyImports(files, (s) => /^(\.\.\/)+els(\/|$)/.test(s.spec));
  check(actual, ELN_TO_ELS_BASELINE, 'ELN_TO_ELS_BASELINE', '새 액자 기능은 els 칸으로');
});

// ELN-AGENT-EVENT-PROTOCOL — eln 은 이벤트를 «밀어낼» 뿐 els 를 import 하지 않는다: 새 방출 파일과 중립 규약 디렉터리.
test('agent-event-bridge(src/tui) 와 src/agent-events 는 src/els 를 import 하지 않는다', () => {
  const files = [join(repoRoot, 'src', 'tui', 'agent-event-bridge.ts'), ...walkSources(join(repoRoot, 'src', 'agent-events'))].filter((f) => !/\.test\.tsx?$/.test(f));
  const hits = files.flatMap((f) => scanImports(readFileSync(f, 'utf8')).filter(({ spec }) => /(^|\/)els(\/|$)/.test(spec)).map(({ spec }) => `${rel(f)}: ${spec}`));
  expect(hits).toEqual([]);
});
