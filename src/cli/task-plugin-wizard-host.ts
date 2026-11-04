import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { startClassicMissionCli } from '../dashboard/mission-cli-consumer.js';
import type { MissionCliConsumerDeps } from '../dashboard/mission-cli-consumer.js';
import { requestQuestion, getDefaultQuestionChannels } from '../hitl/question.js';
import type { QuestionChannel } from '../hitl/question.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../ask-user-question/types.js';
import { PLUGIN_WIZARD_MARKET_QUESTION } from '../graph-wizard/mission-compose.js';
import type { PluginMaker, PluginWizardDeps, PluginWizardPairDecomposition } from '../graph-wizard/mission-compose.js';

export interface TaskPluginWizardHostResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export interface TaskPluginWizardHostPorts {
  wizardId?: string;
  questionChannels?: () => QuestionChannel[];
  sendReport?: (report: string, kind: 'report') => Promise<unknown> | unknown;
  searchMarket?: PluginWizardDeps['searchMarket'];
  missionConsumerDeps?: MissionCliConsumerDeps;
  runMission?: (request: { maker: PluginMaker; prompt: string }) => Promise<TaskPluginWizardHostResult>;
  runMissionPair?: (request: { makers: readonly PluginMaker[]; prompt: string; decomposition: PluginWizardPairDecomposition }) => Promise<Partial<Record<PluginMaker, TaskPluginWizardHostResult>>>;
  onEvent?: PluginWizardDeps['onEvent'];
}

async function runClassicMission(maker: PluginMaker, prompt: string, deps?: MissionCliConsumerDeps): Promise<TaskPluginWizardHostResult> {
  const started = await startClassicMissionCli({ agent: maker, prompt }, deps);
  const result = 'completion' in started ? await started.completion : started;
  return { ok: result.ok, ...(result.content ? { content: result.content } : {}), ...(result.error ? { error: result.error } : {}) };
}

function questionRequest(questions: readonly string[]): AskUserQuestionRequest {
  return {
    questions: questions.map((question, index) => ({
      id: `plugin_wizard_${index + 1}`,
      header: '플러그인',
      question,
      options: question.trim() === PLUGIN_WIZARD_MARKET_QUESTION
        ? [
          { label: '마켓', description: '신뢰된 마켓 후보를 먼저 찾아 시험합니다.' },
          { label: '사이드탭', description: 'Claude와 Codex에 같은 작업을 맡겨 비교합니다.' },
        ]
        : [
          { label: '기본안', description: '마법사가 미션과 도구 이름에서 기본 구현을 정합니다.' },
          { label: '직접 입력', description: '원하는 기능을 직접 적습니다.' },
        ],
      includeOther: true,
    })),
  };
}

function answerMap(result: AskUserQuestionResult): Record<string, string> | undefined {
  const answers: Record<string, string> = {};
  for (const [id, raw] of Object.entries(result.answers)) {
    const typed = result.otherText?.[id]?.trim();
    const value = typed || (Array.isArray(raw) ? raw.join(', ') : raw);
    if (typeof value === 'string' && value.trim()) answers[id] = value.trim();
  }
  return Object.keys(answers).length ? answers : undefined;
}

async function pluginSpec(content: string | undefined, workspace: string): Promise<string> {
  const spec = content?.match(/(?:^|\r?\n)PLUGIN_SPEC=([^\r\n]+)\s*$/m)?.[1]?.trim();
  if (!spec || !isAbsolute(spec)) throw new Error('Claude/Codex 결과에 절대경로 PLUGIN_SPEC이 없습니다');
  const [workspacePath, pluginPath] = await Promise.all([realpath(resolve(workspace)), realpath(resolve(spec))]);
  const fromWorkspace = relative(workspacePath, pluginPath);
  if (!fromWorkspace || fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new Error('Claude/Codex PLUGIN_SPEC은 세션 작업실 안의 경로여야 합니다');
  }
  return pluginPath;
}

/** Wire the plugin wizard onto existing question, outbound, and classic side-tab host abstractions. */
export function createTaskPluginWizardHostDeps(ports: TaskPluginWizardHostPorts = {}): PluginWizardDeps {
  const wizardLabel = (ports.wizardId ?? 'wizard').replace(/[^a-zA-Z0-9_-]/gu, '_') || 'wizard';
  const wizardScope = `${wizardLabel}-${randomUUID()}`;
  const ask = async (request: AskUserQuestionRequest): Promise<AskUserQuestionResult> => {
    const response = await requestQuestion({ request, channels: ports.questionChannels?.() ?? getDefaultQuestionChannels() });
    return response.result;
  };
  const sendReport = ports.sendReport ?? ((report: string, kind: 'report') => sendOutbound(report, kind));
  const runMission = ports.runMission ?? ((request: { maker: PluginMaker; prompt: string }) =>
    runClassicMission(request.maker, request.prompt, ports.missionConsumerDeps));

  return {
    ask: async (questions) => answerMap(await ask(questionRequest(questions))),
    // When omitted, composePluginMission uses its built-in trusted-market search.
    ...(ports.searchMarket ? { searchMarket: ports.searchMarket } : {}),
    develop: async ({ maker, goal, workspace }) => {
      const prompt = [goal, '', `세션 작업실: ${workspace}`,
        '플러그인을 작업실 안에 만들고, 끝에 PLUGIN_SPEC=<absolute plugin directory> 한 줄을 정확히 출력해 주세요.'].join('\n');
      const result = await runMission({ maker, prompt });
      if (!result.ok) throw new Error(result.error ?? `${maker} side-tab mission failed`);
      return { spec: await pluginSpec(result.content, workspace) };
    },
    ...(ports.runMissionPair ? {
      developPair: async ({ makers, goal, workspace }: { makers: readonly PluginMaker[]; goal: string; workspace: string }) => {
        const prompt = [goal, '', `세션 작업실: ${workspace}`,
          '플러그인을 작업실 안에 만들고, 끝에 PLUGIN_SPEC=<absolute plugin directory> 한 줄을 정확히 출력해 주세요.'].join('\n');
        const codexPath = resolve(workspace, '.plugin-wizard', wizardScope, 'codex-candidate');
        const claudePath = resolve(workspace, '.plugin-wizard', wizardScope, 'claude-candidate');
        const decomposition: PluginWizardPairDecomposition = {
          status: 'ready',
          codex: {
            scope: `독립 플러그인 후보를 ${codexPath} 아래에 만든다.`,
            deliverables: `완성된 Codex 후보 패키지와 PLUGIN_SPEC=${codexPath} 한 줄`,
            dependsOn: '없음 — 부모 골과 필요한 기능만 사용하고 Claude 후보 파일은 수정하지 않는다.',
          },
          claude: {
            scope: `독립 플러그인 후보를 ${claudePath} 아래에 만든다.`,
            deliverables: `완성된 Claude 후보 패키지와 PLUGIN_SPEC=${claudePath} 한 줄`,
            dependsOn: '없음 — 부모 골과 필요한 기능만 사용하고 Codex 후보 파일은 수정하지 않는다.',
          },
        };
        const results = await ports.runMissionPair!({ makers, prompt, decomposition });
        const specs: Partial<Record<PluginMaker, { spec: string }>> = {};
        for (const maker of makers) {
          const result = results[maker];
          if (!result?.ok) continue;
          try { specs[maker] = { spec: await pluginSpec(result.content, workspace) }; }
          catch { /* one malformed maker result must not discard the other maker's candidate */ }
        }
        return specs;
      },
    } : {}),
    notify: async (report) => { await sendReport(report, 'report'); },
    ...(ports.onEvent ? { onEvent: ports.onEvent } : {}),
  };
}
