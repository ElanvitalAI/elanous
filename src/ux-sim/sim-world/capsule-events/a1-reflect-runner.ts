// A1 reflection runner — terra r12 mustFix[1]/[2] (isolated-process real-path verification).
// Spawned BY the A1 scenario (a1-sample.ts) as its OWN process. Inside this process the fixture
// config dir is pinned via setElanousConfigDir (process-local — the parent's process-global config
// dir is never touched, terra r9 mustFix[0]), and ONE real core turn runs with NO injection
// (neither capsulePolicyTurnConfig nor capsulePolicyTurnConfigPath): the turn therefore reads its
// cap through the ACTUAL operational path — readUserConfigObject(userConfigPath()) →
// getElanousConfigDir() → the fixture file. A userConfigPath()/config-dir resolution regression then
// flips the captured row (terra r12 mustFix[1]: the pinned-path seam skipped exactly this call).
// Judgment rows are captured by patching debug.log (same technique as the scenario) and written to
// the output path for the parent to assert. Fixture-only (JUD #123019): the config holds a single
// synthetic turn.syncCapMs — never a copy of an operational config.
// Usage: bun a1-reflect-runner.ts <configDir> <outputPath>
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setElanousConfigDir } from '../../../elanous-config-dir.js';
import { debug } from '../../../debug/log.js';
import { runCoreTurn } from '../../../core-turn/run-core-turn.js';
import type { LLMProvider } from '../../../llm.js';
import type { LLMToolSpec } from '../../../llm/tool-spec.js';

interface CapturedRow { readonly event: string; readonly data: unknown }

const argv = process.argv.slice(2);
const configDir: string | undefined = argv[0];
const outputPath: string | undefined = argv[1];
if (typeof configDir !== 'string' || typeof outputPath !== 'string' || !configDir || !outputPath) {
  console.error('usage: a1-reflect-runner.ts <configDir> <outputPath>');
  process.exit(2);
}

// TS narrowing은 main() 클로저(83행 writeFileSync)까지 전파되지 않으므로(저장소 비-null 어설션 부재 관례)
// 가드 통과 뒤 확정 string 재결속 — changed-tsc RED(a1-reflect-runner.ts:83 TS2345, r13 게이트) 수리.
const outputJsonPath: string = outputPath;

// 격리된 프로세스 안에서만 걸리는 실제 설정 위치 핀(terra r12 mustFix[2] — 부모의 전역 config dir은 무변경).
setElanousConfigDir(configDir);

const rows: CapturedRow[] = [];
const originalLog = debug.log;
try {
  (debug as { log: (category: string, event: string, data?: unknown) => void }).log =
    (category, event, data) => {
      if (category === 'turn-life') rows.push({ event, data });
      try { originalLog.call(debug, category, event, data); } catch { /* mirror must not break the run */ }
    };
} catch { /* capture failure leaves rows empty; the parent's reflection check reports it */ }

const sessionId = `a1-reflect-${randomUUID().replaceAll('-', '')}`;
const tools: LLMToolSpec[] = [{
  name: 'Bash',
  description: 'A1 reflection axis probe (real operational config path)',
  parameters: { type: 'object', properties: {}, required: [] },
}];
let round = 0;
const provider: LLMProvider = {
  name: 'a1-reflect-fake', defaultModel: 'a1-reflect-fake', available: () => true,
  async *chat() { yield 'unused'; },
  async *streamChat() {
    if (++round === 1) {
      // timeout 30000 > fixture cap 5000 → the Bash dispatch is judged at the user cap; 5000의 기대값은
      // 부모가 독립 리터럴로 단언한다(JUD-B #127560 교리 — 제품 상수 미수입).
      yield { type: 'tool_call' as const, id: 'a1_reflect', name: 'Bash', args: { command: 'echo probe', timeout: 30000 } };
    } else {
      yield { type: 'text' as const, delta: 'A1 reflection turn done' };
    }
  },
};

async function main(): Promise<void> {
  const controller = new AbortController();
  // 출처: #39534 — 자식 프로세스 종료 가드(60초). 관측 턴 표본의 상한과 무관한 이 러너 고정 계약.
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    await runCoreTurn({
      sessionId,
      messages: [{ role: 'user', content: 'Run one shell probe under the real user config path.' }],
      tools,
      initialProvider: provider,
      signal: controller.signal,
      // 주입 없음(terra r12 mustFix[1]): capsulePolicyTurnConfig·capsulePolicyTurnConfigPath 어느 쪽도
      // 넘기지 않는다 — 이 턴은 운영 userConfigPath() 경로로 fixture를 읽는다.
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'A1 reflection axis done' }] }),
    });
  } finally {
    clearTimeout(timer);
    try { (debug as { log: unknown }).log = originalLog; } catch { /* already restored */ }
    writeFileSync(outputJsonPath, JSON.stringify({ sessionId, rows }), 'utf-8');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
