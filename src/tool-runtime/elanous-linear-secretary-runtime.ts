import { debug } from '../debug/log.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

export interface ElanousLinearSecretaryArgs { request: string }
export interface ElanousLinearSecretaryResult extends Record<string, unknown> { ok: boolean; output: string }

type Runner = (request: string) => Promise<{ replyCard: string; parentIssueId: string; childIssueIds: string[] }>;
const productionRunner: Runner = async request =>
  (await import('../intake-plane/linear-secretary-runtime.js')).runLinearSecretaryRequest(request);
let runner = productionRunner;

export function setElanousLinearSecretaryRunnerForTest(next?: Runner): () => void {
  if (runner !== productionRunner) throw new Error('Linear secretary runner already replaced');
  runner = next ?? productionRunner;
  const installed = runner;
  return () => { if (runner === installed) runner = productionRunner; };
}

export const elanousLinearSecretaryRuntime: ToolRuntime<ElanousLinearSecretaryArgs, ElanousLinearSecretaryResult> = {
  id: 'elanous_linear_secretary',
  surfaces: ['tui', 'mcp'],
  spec: {
    name: 'elanous_linear_secretary',
    description: 'Ground a request in repository evidence and create a Linear parent issue with 3–5 assigned subtasks. Requires an explicit due date and verified evidence. Use configured project by default; team-only creation requires `projectless=true` and exactly one explicit `teamKey=<KEY>` token in the request.',
    parameters: {
      type: 'object',
      properties: { request: { type: 'string', minLength: 1, description: 'The user request. Include an explicit YYYY-MM-DD due date.' } },
      required: ['request'],
      additionalProperties: false,
    },
  } satisfies LLMToolSpec,
  async run(args: ElanousLinearSecretaryArgs, _ctx: ToolRuntimeContext): Promise<ElanousLinearSecretaryResult> {
    const request = typeof args?.request === 'string' ? args.request.trim() : '';
    if (!request) return { ok: false, output: 'Linear 비서 요청 내용이 필요합니다.' };
    try {
      const result = await runner(request);
      debug.log('tool.linear-secretary', 'created', { childCount: result.childIssueIds.length });
      return { ok: true, output: result.replyCard, parentIssueId: result.parentIssueId, childIssueIds: result.childIssueIds };
    } catch (error) {
      // The existing secretary validates key, project, evidence and dates before creating issues.
      const message = error instanceof Error ? error.message : 'Linear 비서 실행 실패';
      // Error.name is caller-controlled and may itself contain connector secrets.
      debug.log('tool.linear-secretary', 'failed', { errorType: error instanceof Error ? 'Error' : 'unknown' });
      const safeMessage = [
        'Linear API key is missing; run elanous connector linear set-key',
        'Linear COO 프로젝트 설정이 없어 이슈 등록을 보류했습니다. 프로젝트를 지정해 주세요.',
        'projectless=true requires an explicit teamKey=<KEY>',
        '저장소 근거 검색 총 시간 제한(20초)을 초과했습니다.',
        '저장소 근거 검색 도구를 실행하지 못해 근거 확인을 완료하지 못했습니다.',
        '저장소·문서·기억에서 확인된 근거가 없어 등록을 보류했습니다.',
        '요청에 마감일이 없어 등록을 보류했습니다. 요청에 YYYY-MM-DD 날짜를 넣어 주세요.',
      ].find(known => message.includes(known));
      return { ok: false, output: safeMessage ?? 'Linear 비서 작업을 진행하지 못했습니다. 키·프로젝트·요청 내용을 확인해 주세요.' };
    }
  },
};
