// N03 장치 — SUBAGENT-TOOLS-EMPTY (0.2.36 · 2026-10-22 · 대표 P0).
// 진짜 classic TUI(`--legacy`) ⊕ fake LLM 이 Agent 도구를 «틀린 이름» tool_filter 로 부른다
// (10-22 운영 실물: allow 5~12개를 줘도 49→0 · «0 tools · Blocked»). 판정은 같은 바이너리의 `logs --json`:
//   mismatch  — allow 가 모르는 이름뿐 → tool-filter allowIgnored ⊕ dispatch noTools=false(도구 상속)
//   deny-all  — 모든 도구를 deny → no-tools-refused(발사 거부 · 빈손 실행 0)
// ⛔ 생산 로직 재구현 0 — Agent 도구·필터·레지스트리 모두 진짜 TUI 안에서 돈다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mockSeatPtySequence, type SeatPtySequenceEvidence } from './mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_ENV, TEST_FAKE_LLM_RESPONSE_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from './fake-llm.js';
import { parseData, readLogs } from './next-tui-seat-scenarios.js';

export type SubagentToolsScenario = 'mismatch' | 'zero-refused';

export interface SubagentToolsSpec { scenario: SubagentToolsScenario; root: string; executable: string; entry: string }

export interface SubagentToolsResult {
  spec: SubagentToolsSpec;
  run: SeatPtySequenceEvidence;
  logs: ReturnType<typeof readLogs>;
  checks: Record<string, boolean>;
}

type Row = { category?: string; event?: string; data?: string };

export async function runSubagentToolsDevice(spec: SubagentToolsSpec): Promise<SubagentToolsResult> {
  const root = resolve(spec.root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
  // zero-refused: allow [Read] ⊕ deny [Read] leaves exactly 0 whatever the host's other tool names are.
  const toolFilter = spec.scenario === 'mismatch'
    ? { allow: ['read_file', 'shell', 'grep_search'] }
    : { allow: ['Read'], deny: ['Read'] };
  const run = await mockSeatPtySequence({
    executable: spec.executable,
    args: [spec.entry, '--legacy', '--config-dir', '{root}', '--test-state-dir', '{root}'],
    root,
    rows: 30,
    cols: 100,
    env: {
      ELANOUS_SESSION_ROOT: join(root, 'sessions'),
      [TEST_FAKE_LLM_ENV]: '1',
      ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
      [TEST_FAKE_LLM_RESPONSE_ENV]: '[fake-llm] 맡겼습니다',
      // zero-refused 는 «사람이 좁히기를 켠» 경우의 0-거부 안전망을 잰다(기본은 allow 무시라 0 이 안 생긴다).
      ...(spec.scenario === 'zero-refused' ? { ELANOUS_SUBAGENT_HONOR_ALLOW: '1' } : {}),
      [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify({ when: '서브에이전트로', name: 'Agent', args: { description: '도구 확인', prompt: '파일 하나 읽어라', tool_filter: toolFilter } }),
    },
    ready: { label: 'boot', until: (s: string) => s.includes('elanous | daemon') && s.includes('❯'), timeoutMs: 90_000 },
    quitKeys: '/exit\r',
    exitTimeoutMs: 20_000,
    steps: [{ label: 'delegated', text: '서브에이전트로 확인해줘', until: (s) => /✔ 완료|✘ 실패/.test(s), timeoutMs: 60_000 }],
  });
  const logs = readLogs({ root, executable: spec.executable, entry: spec.entry }, 'agent.spawn');
  const rows: Row[] = logs.lines.map((l) => { try { return JSON.parse(l) as Row; } catch { return {}; } });
  const ev = (event: string) => rows.filter((r) => r.category === 'agent.spawn' && r.event === event).map((r) => parseData<Record<string, unknown>>(r.data));
  const filterRows = ev('tool-filter');
  const dispatch = ev('dispatch');
  const refused = ev('no-tools-refused');
  const f0 = filterRows[0] ?? {};
  const dispatchedTools = Array.isArray(dispatch[0]?.tools) ? (dispatch[0]!.tools as unknown[]).length : -1;
  const checks: Record<string, boolean> = spec.scenario === 'mismatch'
    ? {
        filterObserved: filterRows.length === 1,
        // SUBAGENT-NO-NARROWING — 모델이 넘긴 allow 는 기본 무시(이름이 맞든 틀리든).
        allowIgnored: f0.allowIgnored === 'model-allow-ignored',
        unknownLogged: JSON.stringify(f0.unknownAllow) === JSON.stringify(['read_file', 'shell', 'grep_search']),
        // Full inheritance, not «some tools»: nothing removed and the child got every available tool.
        nothingRemoved: typeof f0.available === 'number' && f0.available > 0 && f0.remaining === f0.available && f0.removed === 0,
        childGotAllTools: dispatch.length === 1 && dispatch[0]?.noTools === false && dispatchedTools === f0.available,
        noRefusal: refused.length === 0,
        exitedClean: run.exitCode === 0,
      }
    : {
        filterLeftZero: filterRows.length === 1 && f0.remaining === 0 && typeof f0.available === 'number' && f0.available > 0,
        refusedOnce: refused.length === 1,
        noDispatch: dispatch.length === 0,
        exitedClean: run.exitCode === 0,
      };
  return { spec, run, logs, checks };
}
