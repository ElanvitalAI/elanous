#!/usr/bin/env bun
/**
 * TA-GRAPH-1124 H4 — self-implement parity 픽스처 녹화기.
 * 같은 가짜 seam 으로 legacy 엔진(`runSelfImplement`)을 시나리오 표(`stages/parity-scenarios.ts`)대로 돌려 걸음 순서·종단 stage·seam 호출을
 * 기준선 JSON 으로 쓴다. 기대 리터럴과 다르면 «기준선을 덮어쓰지 않고» 차이를 출력하고 exit 1 — 녹화가 기대를 조용히 바꾸지 못한다.
 *
 *   bun scripts/record-si-fixtures.ts            # 기준선 파일을 다시 쓴다(기대와 일치할 때만)
 *   bun scripts/record-si-fixtures.ts --check    # 파일을 쓰지 않고 현재 legacy 결과가 파일·기대와 같은지만 본다
 *   bun scripts/record-si-fixtures.ts --out <path>
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableLandingFreeze, enableLandingFreeze } from '../src/release-loop/landing-freeze.js';
import { setLaunchGrokQuotaReaderForTesting } from '../src/self-dev/dev-cli.js';
import { diffWalks, runScenario, type SiWalk } from '../src/self-implement/stages/parity.js';
import { SI_PARITY_SCENARIOS } from '../src/self-implement/stages/parity-scenarios.js';

const SI_PARITY_BASELINE_PATH = join(import.meta.dir, '..', 'src', 'self-implement', 'stages', '__fixtures__', 'si-parity-legacy-baseline.json');

/** legacy 엔진으로 모든 시나리오를 돌린다. 호출자는 격리된 상태 디렉터리 안에서 부른다(`withIsolatedState`). */
async function recordLegacyBaseline(): Promise<Record<string, SiWalk>> {
  const { runSelfImplement } = await import('../src/self-implement/orchestrator.js');
  await Promise.all([import('../src/self-implement/graph-stage-units.js'), import('../src/task-orchestrator/surfaces/self-implement.js'),
    import('../src/task-orchestrator/surfaces/pod-failure-reason.js')]);
  const out: Record<string, SiWalk> = {};
  for (const scenario of SI_PARITY_SCENARIOS) {
    out[scenario.id] = await runScenario(scenario.plan, runSelfImplement, {
      setFreeze: (on) => { if (on) enableLandingFreeze({ reason: 'si-parity', by: 'record-si-fixtures' }); else disableLandingFreeze(); },
      setGrokQuota: (quota) => setLaunchGrokQuotaReaderForTesting(quota ? () => quota : undefined),
    });
  }
  return out;
}

async function withIsolatedState<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'si-parity-state-'));
  const prior = { ELANOUS_STATE_DIR: process.env.ELANOUS_STATE_DIR, ELANOUS_POD_NAME: process.env.ELANOUS_POD_NAME, ELANOUS_SUBSTRATE: process.env.ELANOUS_SUBSTRATE };
  process.env.ELANOUS_STATE_DIR = dir;
  delete process.env.ELANOUS_POD_NAME;
  delete process.env.ELANOUS_SUBSTRATE;
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 기록 결과 ↔ 기대 리터럴 차이(시나리오별). 비어 있으면 12/12(+보조) 일치. */
function expectationDiffs(recorded: Readonly<Record<string, SiWalk>>): Array<{ id: string; diffs: string[] }> {
  return SI_PARITY_SCENARIOS.map((scenario) => ({ id: scenario.id, diffs: diffWalks(scenario.expected, recorded[scenario.id]!) })).filter((row) => row.diffs.length > 0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIndex = args.indexOf('--out');
  const path = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1]! : SI_PARITY_BASELINE_PATH;
  const recorded = await withIsolatedState(recordLegacyBaseline);
  const mismatches = expectationDiffs(recorded);
  for (const { id, diffs } of mismatches) for (const diff of diffs) console.error(`✗ ${id} — ${diff}`);
  const body = `${JSON.stringify(recorded, null, 2)}\n`;
  if (check) {
    let existing = '';
    try { existing = readFileSync(path, 'utf8'); } catch { /* 없음 = 불일치 */ }
    if (existing !== body) { console.error(`✗ 기준선 파일이 현재 legacy 결과와 다르다: ${path}`); process.exit(1); }
  } else if (mismatches.length === 0) {
    writeFileSync(path, body);
    console.log(`기준선 기록: ${path} (${Object.keys(recorded).length} 시나리오)`);
  }
  if (mismatches.length > 0) process.exit(1);
  console.log(`legacy 기준선 ${SI_PARITY_SCENARIOS.length}/${SI_PARITY_SCENARIOS.length} — 기대 리터럴과 일치`);
}
