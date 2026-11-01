import { debug } from '../debug/log.js';
import { fetchLinearIssueDescription, fetchLinearMissionIssueIdentity } from '../connectors/linear.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { parseLinearSecretaryManifest, updateLinearSecretaryProgress, type LinearSecretaryCaptureInput } from '../intake-plane/linear-wish.js';
import { submitIntakeWork, type SubmitIntakeWorkDeps } from '../intake-plane/submit-intake-work.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

export type ElanousLinearSecretaryArgs =
  | { action: 'create'; request: string }
  | { action: 'progress'; teamKey: 'DEMO'; parentIssueId: string; taskIssueId: string; state: 'started' | 'completed' | 'comment'; summary: string; absorbText?: string; captureArtifact?: LinearSecretaryCaptureInput; workaround?: string }
  | { action: 'approval'; teamKey: 'DEMO'; parentIssueId: string; title: string; context: string };
export interface ElanousLinearSecretaryResult extends Record<string, unknown> { ok: boolean; output: string }

type CreateRunner = (request: string) => Promise<{ replyCard: string; parentIssueId: string; childIssueIds: string[] }>;
const productionCreate: CreateRunner = async request =>
  (await import('../intake-plane/linear-secretary-runtime.js')).runLinearSecretaryRequest(request);
let createRunner = productionCreate;

export function setElanousLinearSecretaryRunnerForTest(next?: CreateRunner): () => void {
  if (createRunner !== productionCreate) throw new Error('Linear secretary runner already replaced');
  createRunner = next ?? productionCreate;
  const installed = createRunner;
  return () => { if (createRunner === installed) createRunner = productionCreate; };
}

export interface ElanousLinearSecretaryRuntimeDeps {
  create?: CreateRunner;
  getApiKey?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  verifyParent?: typeof ensureDemoParent;
  readChildManifest?: typeof readDemoChildManifest;
  updateProgress?: typeof updateLinearSecretaryProgress;
  intake?: SubmitIntakeWorkDeps;
  ledger?: () => DecisionLedger;
}

async function ensureDemoParent(apiKey: string, parentIssueId: string, fetchFn: typeof fetch): Promise<void> {
  const query = `query SecretaryDemoParent($id: String!) { issue(id: $id) { id team { key } } }`;
  const response = await fetchFn('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: parentIssueId } }) });
  if (!response.ok) throw new Error('Linear parent lookup failed');
  const result = await response.json() as { errors?: unknown[]; data?: { issue?: { id?: string; team?: { key?: string } } | null } };
  const issue = result.data?.issue;
  if (result.errors?.length || !issue || issue.id !== parentIssueId || issue.team?.key !== 'DEMO') {
    throw new Error('Linear secretary only accepts a parent issue in the DEMO team');
  }
}

async function readDemoChildManifest(apiKey: string, parentIssueId: string, taskIssueId: string, fetchFn: typeof fetch) {
  const identity = await fetchLinearMissionIssueIdentity({ apiKey, issueId: taskIssueId, fetch: fetchFn });
  if (identity.teamKey !== 'DEMO' || identity.parentId !== parentIssueId) throw new Error('Linear secretary child is not listed in the DEMO parent manifest');
  const description = await fetchLinearIssueDescription({ apiKey, issueId: taskIssueId, fetch: fetchFn });
  const manifest = parseLinearSecretaryManifest(description, taskIssueId);
  if (!manifest || manifest.parentIssueId !== parentIssueId) throw new Error('Linear secretary child is not listed in the DEMO parent manifest');
  return manifest;
}

async function runProgress(args: Extract<ElanousLinearSecretaryArgs, { action: 'progress' }>, deps: ElanousLinearSecretaryRuntimeDeps) {
  if (args.captureArtifact && (args.captureArtifact.externalShare !== true || args.captureArtifact.sensitivity !== 'public' ||
      args.captureArtifact.linearIssueId !== args.parentIssueId || !args.captureArtifact.runId.trim() || !Number.isFinite(args.captureArtifact.createdAt))) {
    return { ok: false, output: 'Linear 캡처는 현재 DEMO 부모에 대해 명시 승인된 공개 브라우저 증거여야 합니다.' };
  }
  const apiKey = await (deps.getApiKey?.() ?? getSecretAsync('connector.linear.apiKey'));
  if (!apiKey?.trim()) throw new Error('Linear API key is missing; run elanous connector linear set-key');
  const fetchFn = deps.fetch ?? globalThis.fetch;
  await (deps.verifyParent ?? ensureDemoParent)(apiKey, args.parentIssueId, fetchFn);
  const manifest = await (deps.readChildManifest ?? readDemoChildManifest)(apiKey, args.parentIssueId, args.taskIssueId, fetchFn);
  const task = manifest.tasks.find(item => item.issueId === args.taskIssueId);
  if (!task) throw new Error('Linear secretary child is not listed in the DEMO parent manifest');
  const absorbed = args.absorbText?.trim() ? await (async text => {
    const result = await submitIntakeWork({ text, track: 'absorb', origin: { kind: 'owner', ledgerSource: 'memo' } }, deps.intake);
    return result.ok && result.track === 'absorb' ? { ok: true as const, ids: result.ids }
      : { ok: false as const, reason: result.ok ? 'unexpected-intake-track' : result.reason };
  })(args.absorbText.trim()) : undefined;
  if (absorbed && (!absorbed.ok || !absorbed.ids.length)) throw new Error('흡수 근거를 intake 원장에 기록하지 못해 진행을 보류했습니다.');
  const refs = absorbed?.ok ? absorbed.ids.map(id => `elanous:intake:${id}`) : [];
  const summary = [args.summary.trim(), ...(refs.length ? [`흡수 근거: ${refs.join(' · ')}`] : [])].join('\n');
  await (deps.updateProgress ?? updateLinearSecretaryProgress)({ apiKey, parentIssueId: args.parentIssueId, taskIssueId: task.issueId, taskTitle: task.title,
    tasks: manifest.tasks, state: args.state, summary, ...(args.workaround ? { workaround: args.workaround } : {}),
    ...(args.captureArtifact ? { captureArtifact: args.captureArtifact } : {}), fetch: fetchFn });
  return { ok: true, output: `DEMO 하위 이슈 진행을 기록했습니다: ${task.issueId}`, parentIssueId: args.parentIssueId, taskIssueId: task.issueId, state: args.state,
    ...(refs.length ? { evidenceRefs: refs } : {}) };
}

async function runApproval(args: Extract<ElanousLinearSecretaryArgs, { action: 'approval' }>, deps: ElanousLinearSecretaryRuntimeDeps) {
  const apiKey = await (deps.getApiKey?.() ?? getSecretAsync('connector.linear.apiKey'));
  if (!apiKey?.trim()) throw new Error('Linear API key is missing; run elanous connector linear set-key');
  await (deps.verifyParent ?? ensureDemoParent)(apiKey, args.parentIssueId, deps.fetch ?? globalThis.fetch);
  const refs = [args.parentIssueId];
  const title = args.title.trim();
  const context = args.context.trim();
  if (!title || !context) throw new Error('Approval title and context are required');
  const ledger = deps.ledger?.() ?? new DecisionLedger({ stateDir: elanousStateRoot() });
  const ref = `linear-secretary-approval:${args.parentIssueId}`;
  const entry = ledger.raiseOnce({ title, category: 'publish', scqa: { s: 'DEMO Linear 결과와 근거가 준비됐다.', c: context },
    options: [{ key: 'a', label: '승인', consequence: '사람이 명시적으로 승인한 뒤 다음 동작을 진행한다' },
      { key: 'b', label: '보류', consequence: '외부 공개를 멈춘다' }],
    recommendation: { option: 'b', why: '승인 전에는 보류한다' }, raisedBy: { agent: 'OPT', track: 'OP' }, refs: [...refs, ref] }, ref);
  // Local durable pending card only. No Telegram/card transport is invoked here.
  const output = entry.status === 'open' ? `승인 대기 카드를 열었습니다: ${entry.id}` : `기존 승인 카드 ${entry.id}의 상태는 ${entry.status}입니다. 새 카드는 열지 않았습니다.`;
  return { ok: true, output, decisionId: entry.id, status: entry.status };
}

export function createElanousLinearSecretaryRuntime(deps: ElanousLinearSecretaryRuntimeDeps = {}): ToolRuntime<ElanousLinearSecretaryArgs, ElanousLinearSecretaryResult> {
return {
  id: 'elanous_linear_secretary', surfaces: ['tui', 'mcp'],
  spec: {
    name: 'elanous_linear_secretary',
    description: 'DEMO 팀 전용 grounded Linear secretary. create는 due date가 포함된 근거 기반 부모/하위 이슈를 만든다. progress는 intake 원문을 흡수한 ID와 명시 승인된 브라우저 캡처를 연결하고 하위 상태를 갱신한다. approval은 부모당 하나의 로컬 open 카드를 만든다. 같은 부모 재호출은 기존 카드 상태를 돌려주며 외부 발송은 없다.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'progress', 'approval'] },
      request: { type: 'string', minLength: 1, description: 'create에 필수. 명시적 YYYY-MM-DD 날짜를 포함한다.' },
      teamKey: { type: 'string', enum: ['DEMO'] }, parentIssueId: { type: 'string' }, taskIssueId: { type: 'string' },
      state: { type: 'string', enum: ['started', 'completed', 'comment'] }, summary: { type: 'string' },
      absorbText: { type: 'string', description: '흡수 원장에 실제 기록할 원문 또는 URL; 성공한 intake id만 진행 근거로 연결한다.' },
      captureArtifact: { type: 'object', description: 'browser-runtime이 생성하고 Linear 공유가 명시 승인된 정확한 캡처 artifact',
        properties: { path: { type: 'string' }, mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          runId: { type: 'string' }, linearIssueId: { type: 'string' }, externalShare: { type: 'boolean', enum: [true] },
          sensitivity: { type: 'string', enum: ['public'] }, createdAt: { type: 'number' } },
        required: ['path', 'mimeType', 'runId', 'linearIssueId', 'externalShare', 'sensitivity', 'createdAt'], additionalProperties: false },
      workaround: { type: 'string' }, title: { type: 'string' }, context: { type: 'string' },
    }, required: ['action'], additionalProperties: false },
  } satisfies LLMToolSpec,
  async run(args, _ctx): Promise<ElanousLinearSecretaryResult> {
    try {
      if (args?.action === 'create') {
        const request = typeof args.request === 'string' ? args.request.trim() : '';
        if (!request) return { ok: false, output: 'Linear 비서 요청 내용이 필요합니다.' };
        const teamTokens = [...request.matchAll(/(?:^|\s)teamKey\s*=\s*([^\s]+)/gi)].map(match => match[1]);
        const projectlessTokens = [...request.matchAll(/(?:^|\s)projectless\s*=\s*([^\s]+)/gi)].map(match => match[1]?.toLowerCase());
        const declaredTeam = teamTokens[0];
        if (teamTokens.length > 1 || (declaredTeam && declaredTeam.toUpperCase() !== 'DEMO') ||
            projectlessTokens.length > 1 || projectlessTokens.some(token => token !== 'true') || (projectlessTokens.length === 1 && !declaredTeam)) {
          return { ok: false, output: 'DEMO 팀만 지원합니다.' };
        }
        const normalizedRequest = request
          .replace(/(^|\s)teamKey\s*=\s*[^\s]+/gi, '$1teamKey=DEMO')
          .replace(/(^|\s)projectless\s*=\s*[^\s]+/gi, '$1projectless=true');
        const scopedRequest = projectlessTokens.length === 1 ? normalizedRequest
          : declaredTeam ? `projectless=true ${normalizedRequest}` : `projectless=true teamKey=DEMO ${request}`;
        const result = await (deps.create ?? createRunner)(scopedRequest);
        debug.log('tool.linear-secretary', 'created', { childCount: result.childIssueIds.length, teamKey: 'DEMO' });
        return { ok: true, output: result.replyCard, parentIssueId: result.parentIssueId, childIssueIds: result.childIssueIds, teamKey: 'DEMO' };
      }
      if (args?.action === 'progress') {
        if (args.teamKey !== 'DEMO' || !args.parentIssueId?.trim() || !args.taskIssueId?.trim() || !args.summary?.trim() || !args.state) return { ok: false, output: 'DEMO 진행 기록에는 팀·부모·하위 이슈·상태·요약이 필요합니다.' };
        return await runProgress(args, deps);
      }
      if (args?.action === 'approval') {
        if (args.teamKey !== 'DEMO' || !args.parentIssueId?.trim() || !args.title?.trim() || !args.context?.trim()) return { ok: false, output: 'DEMO 승인 카드에는 팀·부모 이슈·제목·맥락이 필요합니다.' };
        return await runApproval(args, deps);
      }
      return { ok: false, output: '지원하지 않는 Linear secretary 작업입니다.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Linear 비서 실행 실패';
      debug.log('tool.linear-secretary', 'failed', { action: args?.action ?? 'unknown', errorType: error instanceof Error ? 'Error' : 'unknown' });
      const safeMessage = ['Linear secretary only accepts a parent issue in the DEMO team', 'Linear secretary child is not listed in the DEMO parent manifest',
        'Linear API key is missing; run elanous connector linear set-key',
        'Linear COO 프로젝트 설정이 없어 이슈 등록을 보류했습니다. 프로젝트를 지정해 주세요.',
        '저장소 근거 검색 총 시간 제한(20초)을 초과했습니다.', '저장소 근거 검색 도구를 실행하지 못해 근거 확인을 완료하지 못했습니다.',
        '저장소·문서·기억에서 확인된 근거가 없어 등록을 보류했습니다.', '요청에 마감일이 없어 등록을 보류했습니다. 요청에 YYYY-MM-DD 날짜를 넣어 주세요.',
        '마감일이 없어 등록하지 않았습니다. 요청에 날짜를 넣어 주세요.', '흡수 근거를 intake 원장에 기록하지 못해 진행을 보류했습니다.']
        .find(known => message.includes(known));
      return { ok: false, output: safeMessage ?? 'Linear 비서 작업을 진행하지 못했습니다. 팀 키·이슈 ID·근거·권한을 확인해 주세요.' };
    }
  },
};
}

export const elanousLinearSecretaryRuntime = createElanousLinearSecretaryRuntime();
