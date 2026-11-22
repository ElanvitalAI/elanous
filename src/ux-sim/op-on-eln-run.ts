import { parseArgs } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnElanousBun } from '../instance/spawn-elanous.js';
import { createOpOnElnWorld, type OpWorldAction, type OpWorldActionResult, type OpWorldSnapshot } from './op-on-eln-world.js';
import { compareOpWorldAnswerKey, compareOpWorldBuiltInDispositions, scoreOpWorld, type OpWorldDecisionEvidence } from './op-world-score.js';
import { evaluateOpWorldScene, observeOpWorldReplay, observeOpWorldReplayDecisions, OP_WORLD_REPLAY_DISPOSITIONS, OP_WORLD_REPLAY_ANSWER_KEY_IDS } from './op-world-evaluator.js';

const actionTypes = new Set(['assign', 'hold', 'land', 'report', 'recover']);

/** #39377 terra mustFix ②: 재현 처분은 이 열거 토큰 외의 disposition 값을 받지 않는다. */
const replayDispositionTokens = new Set<string>(Object.values(OP_WORLD_REPLAY_DISPOSITIONS));

/**
 * #39377 terra r4 mustFix ①: 프롬프트는 처분 토큰 «형식»(열거)만 안내한다.
 * 어느 장면에 어느 토큰이 정답인지의 매핑은 채점기(op-world-evaluator.ts)에만 둔다.
 */
const replayDispositionTokenList = Object.values(OP_WORLD_REPLAY_DISPOSITIONS)
  .map(token => `"${token}"`).join(', ');

/** choice must be exactly 'A' or 'B' and carry a non-blank source-bound evidenceId. */
function decodeChoice(value: unknown): OpWorldAction['choice'] {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) throw new Error('Invalid action fields');
  const { choice, evidenceId } = value as Record<string, unknown>;
  if ((choice !== 'A' && choice !== 'B') || typeof evidenceId !== 'string' || !evidenceId.trim()) {
    throw new Error('Invalid action fields');
  }
  return { choice, evidenceId };
}

function decodeActions(reply: string): OpWorldAction[] {
  const json = reply.trim().match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i)?.[1] ?? reply;
  const actions: unknown = JSON.parse(json);
  if (!Array.isArray(actions) || actions.length > 40) throw new Error('Expected at most 40 actions');
  return actions.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid action');
    const { type, target, reason, evidence, worker, choice, disposition } = entry as Record<string, unknown>;
    if (typeof type !== 'string' || !actionTypes.has(type) ||
      typeof target !== 'string' || !target.trim() || typeof reason !== 'string' ||
      (worker !== undefined && typeof worker !== 'string') ||
      (disposition !== undefined && !(typeof disposition === 'string' && replayDispositionTokens.has(disposition))) ||
      !Array.isArray(evidence) || evidence.some(value => typeof value !== 'string')) {
      throw new Error('Invalid action fields');
    }
    const decodedChoice = decodeChoice(choice);
    return {
      type, target, reason, evidence,
      ...(worker ? { worker } : {}), ...(decodedChoice ? { choice: decodedChoice } : {}),
      ...(disposition ? { disposition } : {}),
    } as OpWorldAction;
  });
}

function prompt(snapshot: OpWorldSnapshot): string {
  return [
    '당신은 격리 시뮬레이션의 OP 운영자다. 아래 데이터로 분해, 배정, 보류, 착지, 복구, 보고를 판단하라.',
    '정정과 의존성을 우선하라. 현 head에 맞는 pregate/JUD가 없는 PR은 착지하지 마라.',
    'JSON 배열 하나만 반환하라. 각 원소는 {"type":"assign|hold|land|report|recover","target":"월드 안 ID","reason":"한국어 근거","evidence":["근거 ID"]}이다.',
    'assign은 orders.task를 target으로 쓰고, 지시 ID를 evidence에 넣어라. assign과 recover에는 목적지 worker를 worker 필드에 명시하라.',
    'hold와 land의 target은 정확한 PR ID, recover의 target은 장애가 난 출발 worker ID다.',
    '정시 보고가 필요한 장면에서는 다른 report보다 정시 보고를 먼저 내라. 착지 / 대기 / 막힘을 한국어로 요약하고 첫 문장에 해당 결론을 쓴 뒤 근거를 이어 설명하라.',
    '정시 보고 evidence에는 현재 snapshot의 orders, reports, workers, pullRequests, memory 항목의 id를 하나 이상 인용하라. head 값이나 task 값은 항목의 id가 아니면 evidence에 넣지 말고 reason에서 설명하라. 확인되지 않은 ID를 만들지 마라.',
    '정시 보고에서 관련 이전 약속이 있으면 그 내용을 검토하고 관련 snapshot.memory 항목의 id를 evidence에 포함하라.',
    'A/B 재현 장면은 각 사례를 독립 판단해 report로 기록한다. target은 개별 orders.task, choice는 {"choice":"A 또는 B","evidenceId":"해당 지시 ID"}로 명시하고 근거를 reason에 쓴다. evidence에 각 지시 ID를 넣는다.',
    '처분형 재현 장면은 장면 데이터만으로 스스로 판단해 disposition 필드에 열거 토큰 중 하나를 그대로 명시한다(장면별 정답은 안내하지 않는다): ' + replayDispositionTokenList + '.',
    'actionResults에 retry가 있으면 그 조치의 수복만 재시도하고 이미 반영된 조치는 되풀이하지 마라.',
    JSON.stringify(snapshot),
  ].join('\n');
}

async function ask(executable: string, root: string, input: string, sessionId?: string) {
  const session = sessionId ? ['--session', sessionId] : [];
  const args = ['--test=' + root, 'agent', '--no-tools', '--json', ...session, input];
  const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_LLM_PROVIDER: 'auto' };
  delete env.ELANOUS_TEST_FAKE_LLM;
  delete env.ELANOUS_LLM_MODEL;
  const child = spawnElanousBun(args, {
    executable, stateDir: root, cwd: root, env,
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
  });
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exit !== 0) throw new Error(`eln agent exit ${exit}: ${stderr.trim().slice(-400)}`);
  const line = stdout.trim().split('\n').at(-1);
  const response = JSON.parse(line ?? '') as {
    sessionId?: string; provider?: string; model?: string; reply?: string; incomplete?: boolean;
  };
  if (!response.sessionId || !response.provider || !response.model || typeof response.reply !== 'string') {
    throw new Error('eln agent JSON envelope is incomplete');
  }
  if (response.incomplete) throw new Error('eln agent reported an incomplete response');
  return { sessionId: response.sessionId, provider: response.provider, model: response.model, reply: response.reply };
}

const { values } = parseArgs({
  options: {
    eln: { type: 'string', default: 'eln' },
    output: { type: 'string' },
    'answer-key': { type: 'string' },
  },
});
const answerPath = values['answer-key'] ?? process.env.ELANOUS_OP_WORLD_ANSWER_KEY;
const answerKey = answerPath ? JSON.parse(readFileSync(answerPath, 'utf8')) as OpWorldDecisionEvidence[] : null;
if (answerKey && (!Array.isArray(answerKey) || !answerKey.length
    || answerKey.some(row => !row || typeof row.id !== 'string'))) {
  throw new Error('Expected a non-empty answer key with evidence IDs');
}

const runId = randomUUID();
const root = mkdtempSync(join(tmpdir(), 'eln-op-sim-'));
mkdirSync(join(root, '.elanous'), { mode: 0o700 });
const output = resolve(values.output ?? join(root, 'receipt.json'));
const world = createOpOnElnWorld();
const startedAt = new Date().toISOString();
type ElanousResponse = Awaited<ReturnType<typeof ask>>;
interface ObservedScene {
  snapshot: OpWorldSnapshot;
  response?: ElanousResponse;
  followup?: ElanousResponse;
  actions: OpWorldAction[];
  results: OpWorldActionResult[];
  error?: string;
}
const scenes: ObservedScene[] = [];
let sessionId: string | undefined;
for (let snapshot = world.nextSnapshot(); snapshot; snapshot = world.nextSnapshot()) {
  const scene: ObservedScene = { snapshot, actions: [], results: [] };
  try {
    const independentReplay = snapshot.sceneId.startsWith('replay-');
    scene.response = await ask(values.eln, root, prompt(snapshot), independentReplay ? undefined : sessionId);
    if (!independentReplay) sessionId = scene.response.sessionId;
    scene.actions.push(...decodeActions(scene.response.reply));
    scene.results.push(...world.applyActions(scene.actions));
    if (scene.results.some(result => result.status === 'retry')) {
      scene.followup = await ask(values.eln, root, prompt({ ...snapshot, actionResults: scene.results }), scene.response.sessionId);
      const additional = decodeActions(scene.followup.reply);
      scene.actions.push(...additional);
      scene.results.push(...world.applyActions(additional));
    }
  } catch (error) {
    scene.error = error instanceof Error ? error.message : String(error);
  }
  scenes.push(scene);
  console.error(`Scene ${snapshot.sceneId} observed`);
}
const score = scoreOpWorld(scenes
  .filter(scene => !scene.snapshot.sceneId.startsWith('replay-answer-key-'))
  .map(scene => evaluateOpWorldScene(scene.snapshot, scene.actions, scene.results, scene.error)));
const baselineComparisons = (Object.keys(OP_WORLD_REPLAY_ANSWER_KEY_IDS) as Array<keyof typeof OP_WORLD_REPLAY_ANSWER_KEY_IDS>).map(sceneId => ({
    sceneId,
    decisionId: OP_WORLD_REPLAY_ANSWER_KEY_IDS[sceneId],
    expectedDisposition: OP_WORLD_REPLAY_DISPOSITIONS[sceneId],
    observedDisposition: observeOpWorldReplay(sceneId,
      scenes.find(scene => scene.snapshot.sceneId === sceneId)?.results ?? []),
  }));
const expandedComparisons = scenes.flatMap(scene =>
  observeOpWorldReplayDecisions(scene.snapshot.sceneId, scene.results));
const comparisons = expandedComparisons.length ? expandedComparisons : baselineComparisons;
const evidenceIds = new Set(answerKey?.map(row => row.id));
// #39377 terra mustFix ①: 정답키가 없는 기본 실행도 내장 기대 처분과 비교해 영수증에 기록한다.
const actualDecisionComparison = answerKey
  ? compareOpWorldAnswerKey(answerKey, comparisons.filter(row => evidenceIds.has(row.decisionId)))
  : compareOpWorldBuiltInDispositions(comparisons);
const failedComparison = Boolean(actualDecisionComparison?.mismatched || actualDecisionComparison?.unobserved);
const verdict = scenes.some(scene => scene.error) ? 'error' : score.failedScenes.length || failedComparison ? 'fail' : 'ok';
// JUD-C #129124: verdict 를 영수증 파일 자체에 기록한다(stdout summary 만이 아니라).
const receipt = { runId, startedAt, endedAt: new Date().toISOString(), verdict, ...score, scoredSceneCount: score.sceneCount, sceneCount: scenes.length, requestedProvider: 'auto', isolationRoot: root, actualDecisionComparison, scenes };
writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ outcome: verdict, runId, output, sceneCount: scenes.length }));
