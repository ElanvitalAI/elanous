import { debug } from '../debug/log.js';
import { commentLinearIssue, createLinearTeamIssue, moveLinearIssueToStateType } from '../connectors/linear.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import type { LLMToolSpec } from '../llm.js';
import type { ToolRuntime, ToolRuntimeContext } from './types.js';

export type ElanousLinearIssueArgs =
  | { action: 'create'; teamKey: string; title: string; description?: string }
  | { action: 'comment'; issueId: string; body: string }
  | { action: 'complete'; issueId: string };
export interface ElanousLinearIssueResult extends Record<string, unknown> { ok: boolean; output: string }

type Deps = {
  getApiKey?: (id: string) => Promise<string | undefined>;
  create?: typeof createLinearTeamIssue;
  comment?: typeof commentLinearIssue;
  complete?: typeof moveLinearIssueToStateType;
  fetch?: typeof fetch;
};

export function createElanousLinearIssueRuntime(deps: Deps = {}): ToolRuntime<ElanousLinearIssueArgs, ElanousLinearIssueResult> {
  return {
    id: 'elanous_linear_issue',
    surfaces: ['tui', 'mcp'],
    spec: {
      name: 'elanous_linear_issue',
      description: 'Perform one explicitly requested Linear issue action: create directly in a team without a project, add a comment, or mark an issue complete. Requires connector.linear.apiKey. Never use for an action the user did not request.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'comment', 'complete'] },
          teamKey: { type: 'string', description: 'Required only for create; Linear team key, such as DEMO.' },
          title: { type: 'string', description: 'Required only for create.' },
          description: { type: 'string', description: 'Optional create description.' },
          issueId: { type: 'string', description: 'Required for comment and complete.' },
          body: { type: 'string', description: 'Required only for comment.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    } satisfies LLMToolSpec,
    async run(args: ElanousLinearIssueArgs, _ctx: ToolRuntimeContext): Promise<ElanousLinearIssueResult> {
      const apiKey = await (deps.getApiKey ?? getSecretAsync)('connector.linear.apiKey');
      if (!apiKey?.trim()) return { ok: false, output: 'Linear API key is missing; run elanous connector linear set-key' };
      const fetch = deps.fetch ?? globalThis.fetch;
      try {
        if (args?.action === 'create') {
          const teamKey = typeof args.teamKey === 'string' ? args.teamKey.trim() : '';
          const title = typeof args.title === 'string' ? args.title.trim() : '';
          if (!teamKey || !title) return { ok: false, output: 'Linear issue 생성에는 teamKey와 title이 필요합니다.' };
          const issueId = await (deps.create ?? createLinearTeamIssue)({ apiKey, teamKey, title,
            ...(typeof args.description === 'string' ? { description: args.description } : {}), fetch });
          return { ok: true, output: `Linear 이슈를 생성했습니다: ${issueId}`, issueId };
        }
        const issueId = typeof args?.issueId === 'string' ? args.issueId.trim() : '';
        if (!issueId) return { ok: false, output: 'Linear issueId가 필요합니다.' };
        if (args.action === 'comment') {
          const body = typeof args.body === 'string' ? args.body.trim() : '';
          if (!body) return { ok: false, output: 'Linear 댓글 내용이 필요합니다.' };
          await (deps.comment ?? commentLinearIssue)({ apiKey, issueId, body, fetch });
          return { ok: true, output: `Linear 이슈에 댓글을 추가했습니다: ${issueId}`, issueId };
        }
        if (args.action === 'complete') {
          await (deps.complete ?? moveLinearIssueToStateType)({ apiKey, issueId, type: 'completed', fetch });
          return { ok: true, output: `Linear 이슈를 완료 상태로 바꿨습니다: ${issueId}`, issueId };
        }
        return { ok: false, output: '지원하지 않는 Linear 작업입니다.' };
      } catch {
        debug.log('tool.linear-issue', 'failed', { action: args?.action ?? 'unknown' });
        return { ok: false, output: 'Linear 작업에 실패했습니다. 팀 키, 이슈 ID, 권한을 확인해 주세요.' };
      }
    },
  };
}

export const elanousLinearIssueRuntime = createElanousLinearIssueRuntime();
