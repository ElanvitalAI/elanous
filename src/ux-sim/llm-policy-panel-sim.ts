// UX 시뮬월드 장치 — NEXUS-LLM-POLICY-PANEL (0.3.33 · OP #125562 계약)
//
// 실 패널 라우트(handleLlmPolicyGet/handleLlmPolicyPut)를 임시 configDir 위에서
// 구동하고, 완료선의 실패 경로를 이벤트로 기록한다:
//   ① 비소유자 PUT → 401 (owner 게이트)
//   ② 무효 스키마 PUT → 400 + 거부 사유 + 이전 정책 원본 유지
//   ③ 동시 PUT 두 건 → 둘 다 200, 최종 파일은 마지막 원자 쓰기
//   ④ 정책 파일 부재 GET → 기본 정책 + filePresent=false
// 정책 SoT(src/policy/llm-policy.ts)와 패널 wire(src/nexus/api/llm-policy-panel.ts)는
// 실물을 그대로 부른다 — 흉내 검증기가 아니다.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { handleLlmPolicyGet, handleLlmPolicyPut } from '../nexus/api/llm-policy-panel.js';
import { defaultLlmPolicy } from '../policy/llm-policy.js';
import { debug } from '../debug/log.js';

export type LlmPolicyPanelCaseId =
  | 'owner-write-ok'
  | 'non-owner-rejected'
  | 'invalid-schema-previous-preserved'
  | 'concurrent-write'
  | 'missing-file-defaults';

export interface LlmPolicyPanelCaseResult {
  caseId: LlmPolicyPanelCaseId;
  pass: boolean;
  status: number | null;
  detail: string;
}

export interface LlmPolicyPanelSimResult {
  pass: boolean;
  cases: LlmPolicyPanelCaseResult[];
  devices: string[];
}

const OWNER_AUTH = 'Bearer owner-token';
const STRANGER_AUTH = 'Bearer stranger-token';

function ownerOnly(request: Request): boolean {
  return request.headers.get('authorization') === OWNER_AUTH;
}

function put(configDir: string, body: string, auth: string): Promise<Response> {
  return handleLlmPolicyPut(
    new Request('http://nexus.test/v1/llm/policy', { method: 'PUT', body, headers: { authorization: auth } }),
    { authorizeOwner: ownerOnly, configDir },
  );
}

function get(configDir: string, auth: string = OWNER_AUTH): Promise<Response> {
  return handleLlmPolicyGet(
    new Request('http://nexus.test/v1/llm/policy', { headers: { authorization: auth } }),
    { authorizeOwner: ownerOnly, configDir },
  );
}

function validPolicyYaml(lowRemainingPercent: number): string {
  const policy = defaultLlmPolicy();
  policy.alerts.lowRemainingPercent = lowRemainingPercent;
  return stringify(policy);
}

/** Drive the real GET/PUT panel routes over a temporary config dir and record each case. */
export async function runLlmPolicyPanelSim(): Promise<LlmPolicyPanelSimResult> {
  const configDir = mkdtempSync(join(tmpdir(), 'llm-policy-panel-sim-'));
  const policyPath = join(configDir, 'policy', 'llm.yaml');
  const cases: LlmPolicyPanelCaseResult[] = [];
  const record = (caseId: LlmPolicyPanelCaseId, pass: boolean, status: number | null, detail: string): void => {
    cases.push({ caseId, pass, status, detail });
    debug.log('ux.sim.llm-policy-panel', 'case', { caseId, pass, status });
  };
  try {
    // ① owner 유효 쓰기 — 파일이 생기고 GET 이 그 파일을 본다.
    const first = await put(configDir, validPolicyYaml(10), OWNER_AUTH);
    const afterFirst = await get(configDir);
    const afterFirstBody = (await afterFirst.json()) as { filePresent?: boolean; policy?: { alerts?: { lowRemainingPercent?: number } } };
    record(
      'owner-write-ok',
      first.status === 200 && afterFirst.status === 200 && afterFirstBody.filePresent === true
        && afterFirstBody.policy?.alerts?.lowRemainingPercent === 10,
      first.status,
      `first=${first.status} filePresent=${String(afterFirstBody.filePresent)} lowRemainingPercent=${String(afterFirstBody.policy?.alerts?.lowRemainingPercent)}`,
    );

    // ② 비소유자 PUT — 401 로 거부되고 원본은 그대로.
    const before = readFileSync(policyPath, 'utf8');
    const stranger = await put(configDir, validPolicyYaml(90), STRANGER_AUTH);
    const untouched = readFileSync(policyPath, 'utf8') === before;
    record('non-owner-rejected', stranger.status === 401 && untouched, stranger.status, `status=${stranger.status} previousPreserved=${String(untouched)}`);

    // ③ 무효 스키마 PUT — 400 + 거부 사유 + 이전 정책 유지.
    const invalid = await put(configDir, 'version: 2\nnope: true\n', OWNER_AUTH);
    const invalidBody = (await invalid.json()) as { error?: string; errors?: string[] };
    const stillPrevious = readFileSync(policyPath, 'utf8') === before;
    record(
      'invalid-schema-previous-preserved',
      invalid.status === 400 && invalidBody.error === 'invalid-policy' && (invalidBody.errors?.length ?? 0) > 0 && stillPrevious,
      invalid.status,
      `status=${invalid.status} errors=${invalidBody.errors?.length ?? 0} previousPreserved=${String(stillPrevious)}`,
    );

    // ④ 동시 PUT 두 건 — 둘 다 200, 최종 파일은 마지막 원자 쓰기(15).
    const [a, b] = await Promise.all([
      put(configDir, validPolicyYaml(12), OWNER_AUTH),
      put(configDir, validPolicyYaml(15), OWNER_AUTH),
    ]);
    const afterRace = await get(configDir);
    const afterRaceBody = (await afterRace.json()) as { policy?: { alerts?: { lowRemainingPercent?: number } } };
    const finalPercent = afterRaceBody.policy?.alerts?.lowRemainingPercent;
    record(
      'concurrent-write',
      a.status === 200 && b.status === 200 && (finalPercent === 12 || finalPercent === 15),
      a.status,
      `a=${a.status} b=${b.status} final=${String(finalPercent)}`,
    );

    // ⑤ 정책 파일 부재 GET — 기본 정책 + filePresent=false (별도 임시 디렉터리).
    const emptyDir = mkdtempSync(join(tmpdir(), 'llm-policy-panel-sim-empty-'));
    try {
      const emptyGet = await get(emptyDir);
      const emptyBody = (await emptyGet.json()) as { filePresent?: boolean; policy?: { version?: number } };
      record(
        'missing-file-defaults',
        emptyGet.status === 200 && emptyBody.filePresent === false && emptyBody.policy?.version === 1,
        emptyGet.status,
        `status=${emptyGet.status} filePresent=${String(emptyBody.filePresent)} version=${String(emptyBody.policy?.version)}`,
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }

    return { pass: cases.length === 5 && cases.every((c) => c.pass), cases, devices: ['nexus-llm-policy-panel', 'fake-auth-owner'] };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
