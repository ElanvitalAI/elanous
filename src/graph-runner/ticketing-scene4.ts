import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { dispatchKnowledgeQuery } from '../knowledge/tools/knowledge-query.js';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration, type GraphCapabilityRegistry, type GraphContractId } from './capabilities.js';
import { runGraph } from './runner.js';
import { runArchitectureDeliverables } from './architecture-deliverables.js';
import { generateStructuredDesign } from './architecture-output/structured-design.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from './in-process-registry.js';
import { isTicketingArchitecturePrompt, scene4ConcurrentUsers } from './scene4-turn-policy.js';

export { isTicketingArchitecturePrompt } from './scene4-turn-policy.js';

const PACK = 'pack:ticketing-architecture-public@0.2.0';
const stages = ['knowledge', 'normalize', 'render', 'verify'] as const;
type Stage = typeof stages[number];
const contractFor = (stage: Stage): GraphContractId => `scene4.${stage}@1`;
const compact = (s: string) => s.replace(/\s+/gu, ' ').trim();
const firstSentence = (s: string) => compact(s.replace(/^#+\s*/gmu, '').split(/(?<=[.!?。])\s+/u).find(x => x.length > 30) ?? s.slice(0, 300)).slice(0, 320);
const deniedChoice = /사용\s*금지|사용하지|배제|미사용|선택하지|do not use|avoid|without/iu;
function chosenInAnswer(answer: string, name: 'PostgreSQL' | 'Redis'): boolean {
  const mentions: boolean[] = [];
  for (const sentence of answer.split(/[.!?。\n]/u)) {
    const technologies = [...sentence.matchAll(/PostgreSQL|Redis/giu)];
    const sharedDenial = /(?:PostgreSQL|Redis)\s*(?:\/|과|와|및|,)\s*(?:PostgreSQL|Redis)\s*(?:사용\s*)?(?:금지|배제|미사용)/iu.test(sentence);
    for (let i = 0; i < technologies.length; i++) {
      const technology = technologies[i]!;
      if (technology[0].toLowerCase() !== name.toLowerCase()) continue;
      const clause = sentence.slice(technology.index!, technologies[i + 1]?.index ?? sentence.length);
      mentions.push(!sharedDenial && !deniedChoice.test(clause));
    }
  }
  return mentions.length > 0 && mentions.every(Boolean);
}
/** Extract a bounded, explicitly assumed generic design from the model's actual answer. */
export function structureTicketingAnswer(prompt: string, answer: string): Record<string, unknown> {
  if (!isTicketingArchitecturePrompt(prompt)) throw new Error('scene4 requires a three-line ticketing architecture prompt');
  if (answer.length < 120 || !/대기열|queue/iu.test(answer) || !/좌석|seat/iu.test(answer)
    || !/결제|payment/iu.test(answer) || !/PostgreSQL|데이터베이스|DB|database|원장/iu.test(answer))
    throw new Error('model answer lacks queue, seat, payment or durable ledger evidence');
  const users = scene4ConcurrentUsers(prompt);
  if (!Number.isSafeInteger(users) || users < 1) throw new Error('concurrency assumption missing');
  const postgresChosen = chosenInAnswer(answer, 'PostgreSQL');
  const db = postgresChosen ? 'PostgreSQL seat ledger' : 'Transactional seat database';
  const queue = chosenInAnswer(answer, 'Redis') ? 'Redis admission queue' : 'Durable admission queue';
  const outbox = /outbox|아웃박스/iu.test(answer);
  const idempotent = /멱등|idempoten/iu.test(answer);
  const hold = /hold|홀드|보유|잠금|lock/iu.test(answer);
  const summary = firstSentence(answer);
  const mention = (pattern: RegExp, fallback: string) => compact(answer.match(pattern)?.[0] ?? fallback);
  const design = {
    schemaVersion: 1, title: 'Concert ticketing architecture', version: '1.0',
    summary, background: `${prompt.replace(/\n/gu, ' ')} 모델 답변에서 추출한 일반 시스템 설계. 용량·비용 수치는 검증 전 가정이다.`,
    deployment: { provider: 'generic', project: 'ticketing-system', region: 'primary-zone', vpc: 'private-network' },
    nodes: [
      { id: 'fans', label: 'Fans', layer: 'users', zone: 'external', service: 'Browser clients', details: [`${users.toLocaleString()} concurrent`, 'Queue admission token'] },
      { id: 'edge', label: 'Public edge', layer: 'edge', zone: 'project', service: 'TLS edge and rate limits', details: ['Admission boundary'] },
      { id: 'booking', label: 'Booking API', layer: 'application', zone: 'vpc', service: 'Stateless booking workers', details: [hold ? 'Seat hold and expiry' : 'Seat transaction', idempotent ? 'Idempotent requests' : 'Request deduplication to verify'] },
      { id: 'queue', label: 'Admission queue', layer: 'data', zone: 'vpc', service: queue, details: ['Fair ordering', 'Capacity gate'] },
      { id: 'ledger', label: 'Seat ledger', layer: 'data', zone: 'vpc', service: db, details: ['Atomic seat transition', outbox ? 'Order and outbox' : 'Order consistency'] },
      { id: 'observe', label: 'Telemetry', layer: 'observability', zone: 'vpc', service: 'Metrics and tracing', details: ['Queue lag and conflicts'] },
      { id: 'security', label: 'Trust boundary', layer: 'security', zone: 'external', service: 'Identity and policy controls', details: ['Buyer PII boundary'] },
    ],
    flows: [
      { from: 'fans', to: 'edge', label: 'TLS request', kind: 'sync' },
      { from: 'edge', to: 'queue', label: 'join and admission', kind: 'sync' },
      { from: 'queue', to: 'booking', label: 'admitted request', kind: 'sync' },
      { from: 'booking', to: 'ledger', label: 'atomic hold and confirmation', kind: 'sync' },
      { from: 'booking', to: 'observe', label: 'metrics and traces', kind: 'telemetry' },
    ],
    requirements: [
      { id: 'R1', kind: 'fairness', statement: '공정한 대기열', verification: '동일 입장 조건에서 순서 역전·중복 토큰 시험' },
      { id: 'R2', kind: 'correctness', statement: '같은 좌석 중복 확정 0건', verification: '동일 좌석 동시 경쟁 및 최종 원장 유일성 시험' },
      { id: 'R3', kind: 'recovery', statement: '결제 실패 복구', verification: '웹훅 중복·지연·역순 및 만료 경합 시험' },
    ],
    security: [
      { class: 'public', data: '공연·좌석 공개 정보', controls: '공개 캐시와 TLS' },
      { class: 'confidential', data: '구매자·결제 식별자', controls: '최소 권한·암호화·로그 마스킹' },
    ],
    capacity: [
      { item: '동시 사용자', assumption: `${users.toLocaleString()}명; 대기열에 수용하고 좌석 API 입장률은 실측으로 결정`, verification: '피크 부하·DB 연결 상한·큐 지연 측정' },
    ],
    costs: [{ item: '월 비용', formula: '리전·서비스·처리율 미확정: 추정 전 단가 입력 필요', monthlyUsd: 0 }],
    savings: [{ name: '정적 자산 캐시', mechanism: '반복 조회 분산', guardrail: '개인화·결제 응답은 공유 캐시 금지' }],
    alternatives: [{ name: '캐시를 최종 좌석 원장으로 사용', when: '원장 유실·재구축 보증을 별도 증명한 경우', tradeoff: '중복 확정 불변식 검증이 어려움' }],
    decisions: [{ id: 'ADR-1', decision: `${db}를 최종 좌석 원장으로 사용`, rationale: postgresChosen ? mention(/PostgreSQL[^.!?\n]{0,130}/iu, '모델 답변의 영속 원장 선택') : '모델 답변의 영속 원장 선택; 구체 DB는 미정', revisit: '피크 성능 실측 시' }],
  };
  // The renderer is the shared schema validator; an unsupported layout fails before any files are published.
  generateStructuredDesign(design);
  return design;
}

export interface Scene4Input { prompt: string; answer: string; outDir: string; stateRoot: string; resourceRoot: string; architecturePluginRoot: string; graphPath: string }
export function createScene4Registry(): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const stage of stages) registry = registerGraphCapabilityContract(registry, {
    id: contractFor(stage), input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [stage] } } }, output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(registry, { id: 'demo-scene4-architecture', provides: stages.map(contractFor), tier: 'free',
    invoke: async (context: InProcessHandlerContext): Promise<InProcessHandlerResult> => {
      const stage = (context.input as { stage?: unknown } | null)?.stage;
      if (typeof stage !== 'string' || !stages.includes(stage as Stage) || context.requires !== contractFor(stage as Stage))
        return { ok: false, outcome: 'fail', error: 'scene4 stage contract mismatch' };
      try {
        const input = context.graphInput as Scene4Input;
        if (!input || !isTicketingArchitecturePrompt(input.prompt) || typeof input.answer !== 'string'
          || !['outDir', 'stateRoot', 'resourceRoot', 'architecturePluginRoot'].every(key => isAbsolute(input[key as keyof Scene4Input] as string)))
          throw new Error('scene4 graph input contract missing');
        if (stage === 'knowledge') {
          const hits = await dispatchKnowledgeQuery({ pack_id: PACK, question: '좌석' });
          if (!hits.pack_hits?.length) throw new Error(`installed design pack unavailable: ${hits.output}`);
          const refs = hits.pack_hits.slice(0, 8).map(hit => ({ ref: hit.ref, title: hit.title }));
          mkdirSync(input.outDir, { recursive: true });
          writeFileSync(join(input.outDir, 'knowledge.json'), JSON.stringify({ packId: PACK, query: '좌석', calls: 1, refs }, null, 2) + '\n');
          return { ok: true, outcome: 'ok', result: { calls: 1, refs } };
        }
        if (stage === 'normalize') {
          if (!existsSync(join(input.outDir, 'knowledge.json'))) throw new Error('knowledge receipt missing');
          const structured = structureTicketingAnswer(input.prompt, input.answer);
          const knowledge = JSON.parse(readFileSync(join(input.outDir, 'knowledge.json'), 'utf8')) as { refs: Array<{ ref: string; title: string }> };
          const cited = knowledge.refs.slice(0, 4);
          structured.references = cited.map(card => ({ title: card.title, url: card.ref }));
          writeFileSync(join(input.outDir, 'structured-design.json'), JSON.stringify(structured, null, 2) + '\n');
          writeFileSync(join(input.outDir, 'architecture-rfc.md'), `# ${String(structured.title)}\n\n> 3줄 요구사항에서 생성된 모델 설계 초안. 비용 수치는 미검증 가정.\n\n## 요구사항\n\n${input.prompt}\n\n## 설계 답변\n\n${input.answer}\n\n## KGS 근거 카드\n\n${cited.map(card => `- [${card.ref}] ${card.title}`).join('\n')}\n`);
          writeFileSync(join(input.outDir, 'source.json'), JSON.stringify({ prompt: input.prompt,
            answerSha256: createHash('sha256').update(input.answer).digest('hex'), answerChars: input.answer.length }, null, 2) + '\n');
          return { ok: true, outcome: 'ok', result: { structuredDesignPath: join(input.outDir, 'structured-design.json') } };
        }
        if (stage === 'render') {
          const rendered = await runArchitectureDeliverables({ pluginRoot: input.architecturePluginRoot,
            structuredDesignPath: join(input.outDir, 'structured-design.json'), outDir: join(input.outDir, 'architecture'),
            resourceRoot: input.resourceRoot, stateRoot: input.stateRoot });
          return { ok: true, outcome: 'ok', result: { childGraphRunId: rendered.runId, receipt: rendered.receipt } };
        }
        const receipt = JSON.parse(readFileSync(join(input.outDir, 'architecture/verification.json'), 'utf8')) as { status?: string };
        const knowledge = JSON.parse(readFileSync(join(input.outDir, 'knowledge.json'), 'utf8')) as { calls?: number; refs?: unknown[] };
        if (receipt.status !== 'verified' || knowledge.calls !== 1 || !knowledge.refs?.length) throw new Error('scene4 output or KGS receipt missing');
        return { ok: true, outcome: 'ok', result: { receiptPath: join(input.outDir, 'architecture/verification.json'), knowledgeCalls: 1 } };
      } catch (error) { return { ok: false, outcome: 'fail', error: error instanceof Error ? error.message : String(error) }; }
    } });
}

export async function runScene4Architecture(input: Scene4Input) {
  for (const key of ['outDir', 'stateRoot', 'resourceRoot', 'architecturePluginRoot', 'graphPath'] as const)
    if (!isAbsolute(input[key])) throw new Error(`${key} must be absolute`);
  const state = await runGraph(input.graphPath, { input, quiet: true,
    deps: { root: input.stateRoot, capabilityProviders: createScene4Registry() } });
  if (state.status !== 'done') throw new Error(`scene4 graph ${state.status}: ${state.nodes.find(node => node.ok === false)?.error ?? 'unknown failure'}`);
  return { runId: state.runId, outDir: input.outDir, receiptPath: join(input.outDir, 'architecture/verification.json'), knowledgePath: join(input.outDir, 'knowledge.json') };
}
