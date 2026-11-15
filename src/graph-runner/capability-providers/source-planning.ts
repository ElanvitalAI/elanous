import { createHash } from 'node:crypto';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphContractId, type GraphCapabilityRegistry } from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';
import { checkArchitectureDocument } from '../app-build/architecture-check.js';
import { APP_BUILD_MAX_REPAIRS, ARCHITECTURE_SECTIONS, parsePlanningStage } from '../app-build/contracts.js';

type PlanningStage = 'assumptions' | 'architecture' | 'file-plan';
export interface PlanningModelReply { text: string; provider: string; model: string }
export interface SourcePlanningDeps {
  callLLM?: (prompt: string, signal?: AbortSignal) => Promise<PlanningModelReply>;
  checkArchitecture?: (value: { markdown: string; sections: Record<string, string> }) => { ok: boolean; issues: unknown[] };
}
const stages: PlanningStage[] = ['assumptions', 'architecture', 'file-plan'];
const contract = (stage: PlanningStage): GraphContractId => `source-planning.${stage}@1`;
// Bounded planning transport, kept below the existing model request cap.
const MAX_ASK_BYTES = 8 * 1024;
const MAX_MODEL_BYTES = 128 * 1024;
const filePlanRoles = ['architecture', 'frontend', 'backend', 'database', 'test', 'seed', 'config', 'asset'] as const;
const filePlanRolesText = filePlanRoles.join(', ');
const architectureMarkdownSkeleton = [
  'Keep these eight required level-two section headings in this order, followed by references. Fill every section with application-specific facts; put each diagram inside its named section, not under a separate diagram heading:',
  '## context', 'Describe actors, trust boundaries, and containers. Fill this empty Mermaid fence with graph or flowchart syntax.', '```mermaid', '```',
  '## dataModel', 'Describe entities, keys, and relationships. Fill this empty Mermaid fence with erDiagram syntax.', '```mermaid', '```',
  '## api', 'Describe methods, paths, schemas, errors, and authorization.',
  '## sequences', 'Describe the core request and failure flow. Fill this empty Mermaid fence with sequenceDiagram syntax.', '```mermaid', '```',
  '## deployment', 'Describe the runnable local topology; label unbuilt cloud design as a proposal.',
  '## security', 'Describe identity, secrets, validation, and data boundaries.',
  '## tradeOffs', 'Describe assumptions, measured limits, and alternatives.',
  '## operations', 'Describe health, logs, restart, and undo.',
  '## references', 'Use a real relative link to a planned artifact, for example [API contract](backend/api.md). Include that target in the file plan.',
].join('\n');

function architectureIssueInstructions(issues: Array<{ code: string; section?: string; reference?: string }>): string {
  const hints = issues.map(issue => {
    const section = issue.section && ARCHITECTURE_SECTIONS.includes(issue.section as typeof ARCHITECTURE_SECTIONS[number]) ? `## ${issue.section}` : 'its named section';
    switch (issue.code) {
      case 'missing-section': return `Fill the structured sections.${issue.section} field and its matching ${section} body.`;
      case 'missing-heading': return `Add a level-two heading starting with ${section}, followed by a title in the request language, with content in canonical order.`;
      case 'empty-markdown-section': return `Put substantive design content inside ${section}, before the next level-two heading.`;
      case 'missing-diagram': return issue.section === 'context'
        ? 'Put a nonempty Mermaid graph or flowchart fenced block inside ## context, before ## dataModel; do not move it to a separate Context Diagram heading.'
        : issue.section === 'dataModel'
          ? 'Put a nonempty Mermaid erDiagram fenced block inside ## dataModel, before ## api; do not move it to a separate ERD heading.'
          : 'Put a nonempty Mermaid sequenceDiagram fenced block inside ## sequences, before ## deployment; do not move it to a separate Sequence heading.';
      case 'missing-reference': return 'Add a ## references section with a Markdown link to a real relative artifact path that the file plan will include.';
      case 'missing-reference-definition': return 'Define the referenced Markdown link or replace it with an inline relative link in ## references.';
      case 'invalid-reference': return 'Replace unsafe or malformed links with valid relative paths under the planned application.';
      case 'missing-reference-target': return 'Point the Markdown link to a real relative path included in the planned application.';
      case 'empty-document': return 'Return a complete Markdown architecture document using the eight-heading skeleton.';
      default: return 'Correct the architecture structure and preserve all eight canonical sections.';
    }
  });
  return [...new Set(hints)].slice(0, 12).join(' ');
}

function filePlanRepairInstructions(value: unknown): string {
  const plan = object(value).plan;
  const invalid = Array.isArray(plan) ? [...new Set(plan.map(item => object(item).role)
    .filter((role): role is string => typeof role === 'string' && !filePlanRoles.includes(role as typeof filePlanRoles[number])))] : [];
  const roleHints = invalid.slice(0, 8).map(role => {
    const label = /^[a-zA-Z0-9_-]{1,32}$/u.test(role) ? role : 'invalid-value';
    const mapped = role === 'deployment' ? 'config' : role === 'tests' ? 'test' : undefined;
    return `role ${label} is outside the allowed list; choose one of ${filePlanRolesText}${mapped ? ` (use ${mapped} for ${label})` : ''}.`;
  });
  return roleHints.length ? roleHints.join(' ') : `Use only these file-plan roles: ${filePlanRolesText}. Every dependsOn path must name an earlier plan entry; keep all paths unique and relative.`;
}

function architectureReferencePaths(value: Record<string, unknown>): string[] {
  const document = object(value.architecture);
  if (typeof document.markdown !== 'string') return [];
  const issues = checkArchitectureDocument({ markdown: document.markdown,
    sections: object(document.sections) as Record<string, string>, files: [] }).issues;
  return [...new Set(issues.filter(issue => issue.code === 'missing-reference-target')
    .map(issue => issue.reference).filter((path): path is string => typeof path === 'string'))];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function prior(context: InProcessHandlerContext, name: string): Record<string, unknown> {
  return object(object(context.outputs[name]).result);
}
function decode(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_MODEL_BYTES) throw new Error('model output budget exceeded');
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
}

/** Pin one configured model for this registry/run. No domain-specific model or fallback is selected here. */
function configuredModelCaller(): NonNullable<SourcePlanningDeps['callLLM']> {
  let selected: Promise<{ llm: typeof import('../../llm.js'); provider: import('../../llm.js').LLMProvider; model?: string }> | undefined;
  return async (prompt, signal) => {
    selected ??= (async () => {
      const [{ getUserConfig }, llm] = await Promise.all([import('../../user-config.js'), import('../../llm.js')]);
      const config = getUserConfig();
      return { llm, provider: await llm.getProviderForConfigAsync(config, config.llm.model), model: config.llm.model };
    })();
    const choice = await selected;
    let actualProvider = choice.provider.name;
    let actualModel = choice.model ?? '';
    const text = await choice.llm.streamLLM([{ role: 'user', content: prompt }], () => {}, {
      provider: choice.provider, preferExplicitProvider: true, ...(choice.model ? { model: choice.model } : {}), signal,
      onResolvedProvider: (provider, model) => { actualProvider = provider; actualModel = model; },
    });
    if (actualProvider !== choice.provider.name || (choice.model && actualModel && actualModel !== choice.model)) throw new Error('configured planning model changed');
    return { text, provider: actualProvider, model: actualModel };
  };
}

/** Shared planning capabilities; the plugin supplies the ordered graph, not executable code. */
export function createSourcePlanningRegistry(deps: SourcePlanningDeps = {}): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const stage of stages) registry = registerGraphCapabilityContract(registry, {
    id: contract(stage), input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [stage] } } },
    output: { type: 'object' },
  });
  const callLLM = deps.callLLM ?? configuredModelCaller();
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'source-planning', provides: stages.map(contract), tier: 'byok',
    invoke: async context => runStage(context, callLLM, deps.checkArchitecture ?? checkArchitectureDocument),
  });
}

async function runStage(context: InProcessHandlerContext, callLLM: NonNullable<SourcePlanningDeps['callLLM']>,
  checkArchitecture: NonNullable<SourcePlanningDeps['checkArchitecture']>): Promise<InProcessHandlerResult> {
  const stage = object(context.input).stage as PlanningStage;
  if (!stages.includes(stage) || context.requires !== contract(stage)) return { ok: false, outcome: 'failed', error: 'PLANNING_STAGE_MISMATCH' };
  if (!context.verifiedOwnerId) return { ok: false, outcome: 'failed', error: 'VERIFIED_OWNER_REQUIRED' };
  const input = object(context.graphInput);
  if (typeof input.ask !== 'string' || !input.ask.trim() || Buffer.byteLength(input.ask) > MAX_ASK_BYTES) return { ok: false, outcome: 'failed', error: 'PLANNING_REQUEST_INVALID' };
  const assumed = prior(context, 'assumptions');
  const architecture = prior(context, 'architecture');
  if (stage !== 'assumptions' && !Array.isArray(assumed.assumptions)) return { ok: false, outcome: 'failed', error: 'ASSUMPTIONS_NOT_VALIDATED' };
  if (stage === 'file-plan' && !architecture.architecture) return { ok: false, outcome: 'failed', error: 'ARCHITECTURE_NOT_VALIDATED' };
  const referencePaths = stage === 'file-plan' ? architectureReferencePaths(architecture) : [];
  const used = stage === 'assumptions' ? 0 : Number((stage === 'architecture' ? assumed : architecture).repairUsed);
  if (!Number.isInteger(used) || used < 0 || used > APP_BUILD_MAX_REPAIRS) return { ok: false, outcome: 'failed', error: 'PLANNING_BUDGET_INVALID' };
  const shape = stage === 'assumptions' ? JSON.stringify({ assumptions: [{ statement: 'assumed: <assumption in the requested output language>', source: 'assumed' }] })
    : stage === 'architecture' ? JSON.stringify({ markdown: 'Complete local architecture Markdown in the requested output language, with diagrams, ERD and API/sequence evidence',
    sections: Object.fromEntries(ARCHITECTURE_SECTIONS.map(key => [key, 'Concrete application-specific content in the requested output language'])) })
      : JSON.stringify({ plan: [{ path: 'ARCHITECTURE.md', purpose: 'purpose in the requested output language', role: 'architecture', dependsOn: [] }] });
  const request = JSON.stringify({ ask: input.ask, seedRequested: input.seedRequested === true,
    ...(stage === 'assumptions' ? {} : { assumptions: assumed.assumptions }),
    ...(stage === 'file-plan' ? { architecture: architecture.architecture, architectureReferencePaths: referencePaths } : {}) });
  let lastError = 'PLANNING_OUTPUT_INVALID';
  let repairInstruction = '';
  for (let repair = 0; repair + used <= APP_BUILD_MAX_REPAIRS; repair++) {
    if (context.signal?.aborted) return { ok: false, outcome: 'failed', error: 'PLANNING_CANCELLED' };
    const prompt = ['Complete only the named planning stage. Return JSON, never ask product clarification questions.',
      'Follow an explicit requested output language even when quoted sources or context contain another language. Otherwise write in the language of the user request. Apply this to every explanatory sentence, table cell, Mermaid diagram label, structured architecture section value, assumption content, and file-plan purpose. Preserve JSON property names, source labels user/assumed, file roles, code syntax, paths, and the eight canonical architecture heading keys. In Markdown append a title in the output language after each key with an em dash, for example ## context — 시스템 맥락 for Korean or ## context — System context for English; do not translate or remove the key. The references heading may also have a localized title. Examples in this prompt describe the schema and do not choose the output language.',
      'Choose reasonable missing product assumptions. Each statement must be one declarative line in label: content format (for example assumed: <concrete assumption in the requested output language>), never a question; the label must exactly match source (user or assumed). Do not claim code, tests or deployment completed.',
      stage === 'architecture' ? architectureMarkdownSkeleton + '\nAlso return testStrategyTitle in the explicitly requested output language (시험 전략 for Korean; Test strategy for English) and a nonempty testStrategy (up to eight items): id, kind(unit/api/seed/fault), target in the request language, testFile, device=bun-test-sandbox, command=[bun,test,./testFile]. Choose real test files. API round trips must run in process (no network); declare only checks you will implement. The host appends the strategy document section; do not claim tests ran.' : '',
      `Stage: ${stage}. Required output shape: ${shape}`,
      stage === 'file-plan' ? `Plan frontend, backend, database, test, and config files in dependency order. For this demo target at most 12 total files: keep the implementation minimal and combine compatible modules, configuration, and tests when practical. The contract maximum remains 24; never omit a required file solely to hit the 12-file target. Include role and purpose. The role field must be exactly one of: ${filePlanRolesText}. A deployment script or Docker file has role config; a test file has role test (singular). Never use deployment or tests as role values. Each dependsOn path must appear earlier in the plan. Include every architecture.testStrategy testFile with role test. Include ARCHITECTURE.md and every exact path in architectureReferencePaths from the request context as plan entries; do not rename or omit a referenced file. Include a repeatable synthetic seed script only when requested.` : '',
      `Request/context: ${request}`, repair ? `Previous output failed validation (${lastError}). ${repairInstruction || 'Correct the JSON contract and complete the requested stage.'}` : ''].join('\n');
    if (Buffer.byteLength(prompt) > MAX_MODEL_BYTES) return { ok: false, outcome: 'failed', error: 'PLANNING_CONTEXT_BUDGET_EXCEEDED' };
    let reply: PlanningModelReply;
    try { reply = await callLLM(prompt, context.signal); }
    catch { return { ok: false, outcome: 'failed', error: 'PLANNING_MODEL_CALL_FAILED' }; }
    let decoded: unknown;
    try {
      decoded = decode(reply.text);
      const value = object(parsePlanningStage(stage, decoded, { seedRequested: input.seedRequested === true, requireTestStrategy: stage === 'architecture',
        ...(stage === 'file-plan' ? { testStrategy: object(architecture.architecture).testStrategy } : {}) }));
      if (stage === 'architecture') {
        const title = value.testStrategyTitle as string;
        const strategy = value.testStrategy as Array<{id: string; kind: string; target: string; testFile: string; command: string[]}>;
        value.markdown = String(value.markdown) + '\n\n## ' + title + '\n' + strategy.map(item =>
          '- ' + item.id + ' [' + item.kind + ']: ' + item.target + ' — ' + item.testFile + ' — ' + item.command.join(' ')).join('\n');
        const checked = checkArchitecture(value as unknown as { markdown: string; sections: Record<string, string> });
        if (!checked.ok) {
          lastError = 'ARCHITECTURE_CHECK_FAILED';
          repairInstruction = architectureIssueInstructions(checked.issues as Array<{ code: string; section?: string; reference?: string }>);
          continue;
        }
      }
      if (stage === 'file-plan') {
        const document = object(architecture.architecture);
        const checked = checkArchitectureDocument({ markdown: document.markdown as string,
          sections: object(document.sections) as Record<string, string>,
          files: (value.plan as Array<{ path: string }>).map(item => item.path) });
        const missing = checked.issues.filter(issue => issue.code === 'missing-reference-target' && typeof issue.reference === 'string');
        if (missing.length) {
          lastError = 'ARCHITECTURE_REFERENCE_TARGET_MISSING';
          repairInstruction = missing.map(issue => `missing-reference-target ${JSON.stringify(issue.reference)}: add this exact file path to the plan, or remove its reference from ARCHITECTURE.md in the architecture stage; this file-plan stage can only add plan entries.`).join(' ');
          continue;
        }
      }
      const common = { repairUsed: used + repair, stage, buildComplete: false, nextStage: stage === 'file-plan' ? 'files' : stages[stages.indexOf(stage) + 1] };
      const result = stage === 'assumptions' ? { ...common, ...value }
        : stage === 'architecture' ? { ...common, architecture: value }
          : { ...common, ...value, assumptions: assumed.assumptions, architecture: architecture.architecture, planningComplete: true };
      return { ok: true, outcome: 'done', result, evidence: { stage, provider: reply.provider, model: reply.model,
        outputSha256: createHash('sha256').update(reply.text).digest('hex'), repairUsed: used + repair, runId: context.runId } };
    } catch {
      lastError = 'PLANNING_OUTPUT_INVALID';
      repairInstruction = stage === 'file-plan' && decoded !== undefined
        ? filePlanRepairInstructions(decoded) : 'Return valid JSON with the required stage fields and complete the requested stage.';
    }
  }
  return { ok: false, outcome: 'failed', error: 'PLANNING_OUTPUT_REPAIR_EXHAUSTED', evidence: { stage, repairUsed: APP_BUILD_MAX_REPAIRS } };
}
