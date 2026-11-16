import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration, type GraphContractId } from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';
import { createSourcePlanningRegistry, type PlanningModelReply } from './source-planning.js';
import { generatePlannedFiles } from '../app-build/file-generation.js';
import { createBuildExecution } from '../app-build/build-execution.js';
import { parseTestStrategy, APP_BUILD_MAX_FILES, APP_BUILD_MAX_REPAIRS } from '../app-build/contracts.js';
import { debug } from '../../debug/log.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { diagnoseDeploymentEnvironment, environmentContract, environmentSummary, missingMethodHint, readEnvironmentReceipt, unavailableImportHint,
  unavailableImports, writeEnvironmentReceipt, type DeploymentEnvironment } from '../app-build/deployment-environment.js';
import { normalizeSourceFileJson, sourceFileResponseFormat, writeSourceFileRaw } from '../app-build/source-file-json.js';
import { groundDeploymentEnvironment, groundingPrompt, readGroundingReceipt, validateAppBuildGrounding,
  writeGroundingReceipt, type AppBuildGrounding } from '../app-build/grounding.js';

type Host = ReturnType<typeof createBuildExecution>;
type Grant = Awaited<ReturnType<Host['reserve']>>;
type PlanningInput = Parameters<typeof generatePlannedFiles>[0];
type FileFormat = ReturnType<typeof sourceFileResponseFormat>;
type Deps = { callLLM?: (prompt: string, signal?: AbortSignal, responseFormat?: FileFormat) => Promise<PlanningModelReply>; host?: Host;
  diagnoseEnvironment?: typeof diagnoseDeploymentEnvironment; recordEnvironment?: typeof writeEnvironmentReceipt;
  readEnvironment?: typeof readEnvironmentReceipt; recordModelRaw?: typeof writeSourceFileRaw;
  collectGrounding?: typeof groundDeploymentEnvironment;
  recordGrounding?: typeof writeGroundingReceipt; readGrounding?: typeof readGroundingReceipt };
type Stage = 'reserve' | 'grounding' | 'files' | 'verify' | 'materialize' | 'publish';
const stages: Stage[] = ['reserve', 'grounding', 'files', 'verify', 'materialize', 'publish'];
const contract = (stage: Stage): GraphContractId => `source-build.${stage}@1`;
// Same request/output transport ceiling as the A provider. Includes repair diagnostics.
const MAX_CONTEXT_BYTES = 128 * 1024;
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const output = (context: InProcessHandlerContext, name: string) => row(row(context.outputs[name]).result);

type PlannedFile = { path: string; role: string; dependsOn: string[] };

/** Bind an explicitly requested seed to the actual process entry and its selected test. */
export function seedRuntimePlanMatches(plan: PlannedFile[], startPath: string, strategy: unknown): boolean {
  const byPath = new Map(plan.map(file => [file.path, file]));
  const start = byPath.get(startPath);
  if (start?.role !== 'backend') return false;
  const databases = plan.filter(file => file.role === 'database');
  if (databases.length !== 1) return false;
  const ancestors = (path: string, seen = new Set<string>()): Set<string> => {
    for (const dependency of byPath.get(path)?.dependsOn ?? []) {
      if (!seen.has(dependency)) { seen.add(dependency); ancestors(dependency, seen); }
    }
    return seen;
  };
  const startupDependencies = ancestors(startPath);
  const seeds = plan.filter(file => file.role === 'seed' && startupDependencies.has(file.path)
    && ancestors(file.path).has(databases[0]!.path));
  if (!seeds.length) return false;
  let selected: ReturnType<typeof parseTestStrategy>;
  try { selected = parseTestStrategy(strategy, plan); } catch { return false; }
  return selected.some(item => item.kind === 'seed' && byPath.get(item.testFile)?.role === 'test'
    && ancestors(item.testFile).has(startPath)
    && seeds.some(seed => ancestors(item.testFile).has(seed.path)));
}

function configuredModel() {
  let selected: Promise<{ llm: typeof import('../../llm.js'); provider: import('../../llm.js').LLMProvider; model?: string }> | undefined;
  return async (prompt: string, signal?: AbortSignal, responseFormat?: FileFormat): Promise<PlanningModelReply> => {
    selected ??= (async () => {
      const [{ getUserConfig }, llm] = await Promise.all([import('../../user-config.js'), import('../../llm.js')]);
      const config = getUserConfig();
      return { llm, provider: await llm.getProviderForConfigAsync(config, config.llm.model), model: config.llm.model };
    })();
    const choice = await selected;
    let provider = choice.provider.name; let model = choice.model ?? '';
    const text = await choice.llm.streamLLM([{ role: 'user', content: prompt }], () => {}, {
      provider: choice.provider, preferExplicitProvider: true, ...(choice.model ? { model: choice.model } : {}), signal,
      ...(responseFormat && /(?:^|\/)solar-pro4$/u.test(choice.model ?? '') ? { responseFormat } : {}),
      onResolvedProvider: (actualProvider, actualModel) => { provider = actualProvider; model = actualModel; },
    });
    if (provider !== choice.provider.name || !model || choice.model && choice.model !== model) throw new Error('BUILD_MODEL_PIN_REFUSED');
    choice.model = model; // Pin a resolved default too; later stages cannot silently switch it.
    return { text, provider, model };
  };
}

/** Production default factory used by the manifest loader. A and B share one
 * configured model and execution host, with independent finite stage budgets. */
export function createSourceBuildRegistry(deps: Deps = {}) {
  const host = deps.host ?? createBuildExecution();
  const caller = deps.callLLM ?? configuredModel();
  let calls = 0;
  const planningBudget = { used: 0, limit: ['assumptions', 'architecture', 'file-plan'].length + APP_BUILD_MAX_REPAIRS };
  const fileBudget = () => ({ used: 0, limit: APP_BUILD_MAX_FILES * (APP_BUILD_MAX_REPAIRS + 1) });
  const initialFilesBudget = fileBudget();
  // Each whole-program repair owns a complete per-file retry allowance. Earlier
  // planning/generation/repair calls cannot spend a later round's allocation.
  const repairBudgets = Array.from({ length: APP_BUILD_MAX_REPAIRS }, fileBudget);
  let deployment: Record<string, unknown> | undefined;
  let environment: DeploymentEnvironment | undefined;
  let grounding: AppBuildGrounding | undefined;
  let environmentReceipt: { path: string; sha256: string } | undefined;
  let activeRunId: string | undefined;
  const modelRawReceipts: Array<{ file: string; path: string; sha256: string }> = [];
  let lastModel: { provider: string; model: string } | undefined;
  const model = async (prompt: string, signal?: AbortSignal, budget = planningBudget): Promise<PlanningModelReply> => {
    if (signal?.aborted) throw new Error('BUILD_CANCELLED');
    if (deployment && !environment) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
    const request = deployment ? prompt + '\nDeployment contract: ' + JSON.stringify(deployment)
      + '\n' + (environment ? environmentContract(environment) : '')
      + (grounding ? '\n' + groundingPrompt(grounding) : '')
      + '\nInclude the declared backend entry, frontendRoot/index.html, and every local architecture reference in the file plan. '
      + 'Include a local test file for the measured runtime; the host owns the service port. '
      + 'Return a single parseable JSON object without Markdown fences; encode source line breaks and quotes as JSON string escapes.' : prompt;
    if (Buffer.byteLength(request) > MAX_CONTEXT_BYTES || budget.used >= budget.limit) throw new Error('BUILD_MODEL_BUDGET');
    let sourceFilePath: string | undefined;
    if (prompt.startsWith('{')) {
      try { const file = row(row(JSON.parse(prompt)).file); if (typeof file.path === 'string') sourceFilePath = file.path; }
      catch { /* A stage prompts and malformed source prompts use the ordinary bounded parser. */ }
    }
    budget.used++; calls++;
    const reply = await caller(request, signal, sourceFilePath ? sourceFileResponseFormat(sourceFilePath) : undefined);
    lastModel = { provider: reply.provider, model: reply.model };
    if (!sourceFilePath) return reply;
    if (!activeRunId) throw new Error('BUILD_CONTEXT_REQUIRED');
    const root = join(getElanousConfigDir(), 'app-build', 'model-raw');
    const rawReceipt = (deps.recordModelRaw ?? writeSourceFileRaw)(root, activeRunId, reply.text);
    modelRawReceipts.push({ file: sourceFilePath, ...rawReceipt });
    return { ...reply, text: normalizeSourceFileJson(reply.text, sourceFilePath) };
  };
  let registry = createSourcePlanningRegistry({ callLLM: model });
  const restoreEnvironment = (context: InProcessHandlerContext) => {
    activeRunId = context.runId;
    deployment = JSON.parse(JSON.stringify(row(row(context.graphInput).artifactMetadata)));
    const recorded = row(output(context, 'source-reserve').environmentReceipt);
    if (typeof recorded.path !== 'string' || typeof recorded.sha256 !== 'string') throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
    const root = join(getElanousConfigDir(), 'app-build', 'environment');
    environmentReceipt = { path: recorded.path, sha256: recorded.sha256 };
    environment = (deps.readEnvironment ?? readEnvironmentReceipt)(root, context.runId, environmentReceipt);
    grounding = undefined;
    for (const item of Object.values(context.outputs)) {
      const receipt = row(row(item).result).groundingReceipt;
      if (!receipt || typeof receipt !== 'object') continue;
      const check = row(receipt);
      if (typeof check.path !== 'string' || typeof check.sha256 !== 'string') throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
      const candidate = (deps.readGrounding ?? readGroundingReceipt)(join(getElanousConfigDir(), 'app-build', 'grounding'),
        context.runId, { path: check.path, sha256: check.sha256 });
      if (!validateAppBuildGrounding(candidate, environment)) throw new Error('BUILD_GROUNDING_INVALID');
      if (grounding) throw new Error('BUILD_GROUNDING_RECEIPT_INVALID');
      grounding = candidate;
    }
  };
  registry = { ...registry, providers: registry.providers.map(provider => provider.id === 'source-planning'
    ? { ...provider, invoke: async (context: InProcessHandlerContext) => {
      restoreEnvironment(context);
      return provider.invoke(context);
    } } : provider) };
  for (const stage of stages) registry = registerGraphCapabilityContract(registry, {
    id: contract(stage), input: { type: 'object', required: ['stage'], properties: { stage: { type: 'string', enum: [stage] } } }, output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'source-build', provides: stages.map(contract), tier: 'byok',
    invoke: async context => {
      const stage = row(context.input).stage as Stage;
      if (!stages.includes(stage) || context.requires !== contract(stage) || !context.verifiedOwnerId) return { ok: false, outcome: 'failed', error: 'BUILD_CONTEXT_REQUIRED' };
      const input = row(context.graphInput);
      const evidence = () => ({ phase: stage, runId: context.runId, modelCalls: calls,
        modelBudgetUsed: { planning: planningBudget.used, files: initialFilesBudget.used, repairs: repairBudgets.map(budget => budget.used) },
        modelRawReceipts: modelRawReceipts.map(item => ({ ...item })), ...lastModel });
      const done = (result: Record<string, unknown>): InProcessHandlerResult => {
        debug.log('app-build.phase', stage, { ...evidence(), files: result.files, repairUsed: result.repairUsed });
        return { ok: true, outcome: 'done', result, evidence: evidence() };
      };
      try {
        if (stage === 'grounding') {
          const receipts = Object.values(context.outputs).map(item => row(row(item).result).environmentReceipt)
            .filter(item => item && typeof item === 'object');
          if (receipts.length !== 1) throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
          const receipt = row(receipts[0]);
          if (typeof receipt.path !== 'string' || typeof receipt.sha256 !== 'string') throw new Error('BUILD_ENVIRONMENT_RECEIPT_INVALID');
          const root = join(getElanousConfigDir(), 'app-build', 'environment');
          const measured = (deps.readEnvironment ?? readEnvironmentReceipt)(root, context.runId,
            { path: receipt.path, sha256: receipt.sha256 });
          const collected = await (deps.collectGrounding ?? groundDeploymentEnvironment)(measured, {}, context.signal);
          if (!validateAppBuildGrounding(collected, measured)) throw new Error('BUILD_GROUNDING_INVALID');
          const groundingReceipt = (deps.recordGrounding ?? writeGroundingReceipt)(
            join(getElanousConfigDir(), 'app-build', 'grounding'), context.runId, collected);
          const persisted = (deps.readGrounding ?? readGroundingReceipt)(
            join(getElanousConfigDir(), 'app-build', 'grounding'), context.runId, groundingReceipt);
          if (!validateAppBuildGrounding(persisted, measured)) throw new Error('BUILD_GROUNDING_INVALID');
          return done({ groundingReceipt, externalStatus: persisted.externalStatus,
            neededDevices: persisted.neededDevices, buildComplete: false });
        }
        if (stage === 'reserve') {
          const metadata = row(input.artifactMetadata); const runtime = row(metadata.runtime);
          if (typeof input.appSlug !== 'string' || typeof input.seedRequested !== 'boolean' || !Array.isArray(runtime.startCommand)
            || runtime.startCommand.length !== 2 || runtime.startCommand[0] !== 'bun'
            || typeof runtime.startCommand[1] !== 'string' || !/^backend\/[A-Za-z0-9][A-Za-z0-9._/-]*\.tsx?$/u.test(runtime.startCommand[1])
            || runtime.startCommand[1].includes('..') || typeof runtime.healthPath !== 'string' || !/^\/[A-Za-z0-9/_-]*$/u.test(runtime.healthPath)
            || Buffer.byteLength(JSON.stringify(metadata)) > MAX_CONTEXT_BYTES) throw new Error('BUILD_DEPLOYMENT_CONTRACT_REQUIRED');
          deployment = JSON.parse(JSON.stringify(metadata));
          const grant = await host.reserve(context.verifiedOwnerId, context.runId, input.appSlug, context.signal);
          if (grant.ownerId !== context.verifiedOwnerId || grant.runId !== context.runId || grant.appSlug !== input.appSlug) throw new Error('BUILD_CONTEXT_REQUIRED');
          activeRunId = context.runId;
          const environmentRoot = join(getElanousConfigDir(), 'app-build', 'environment');
          environment = await (deps.diagnoseEnvironment ?? diagnoseDeploymentEnvironment)(environmentRoot, String(runtime.startCommand[0]));
          environmentReceipt = (deps.recordEnvironment ?? writeEnvironmentReceipt)(environmentRoot, context.runId, environment);
          environment = (deps.readEnvironment ?? readEnvironmentReceipt)(environmentRoot, context.runId, environmentReceipt);
          const summary = environmentSummary(environment);
          debug.log('app-build.environment', 'diagnosed', { runId: context.runId, summary,
            receiptSha256: environmentReceipt.sha256 });
          return done({ grant, environmentSummary: summary, environmentReceipt, buildComplete: false });
        }
        const grant = output(context, 'source-reserve').grant as Grant | undefined;
        if (!grant || grant.ownerId !== context.verifiedOwnerId || grant.runId !== context.runId || grant.appSlug !== input.appSlug) throw new Error('BUILD_CONTEXT_REQUIRED');
        restoreEnvironment(context);
        const planned = output(context, 'file-plan');
        const planInput = { assumptions: planned.assumptions, architecture: planned.architecture, plan: planned.plan,
          seedRequested: input.seedRequested, signal: context.signal } as PlanningInput;
        if (stage === 'files') {
          const metadata = row(input.artifactMetadata); const runtime = row(metadata.runtime);
          if (!Array.isArray(planInput.plan) || !planInput.plan.some(file => file.path === (runtime.startCommand as string[])[1])
            || !planInput.plan.some(file => file.role === 'test' && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file.path))
            || typeof metadata.frontendRoot === 'string' && !planInput.plan.some(file => file.path === metadata.frontendRoot + '/index.html')
            || input.seedRequested === true && !seedRuntimePlanMatches(planInput.plan,
              String((runtime.startCommand as string[])[1]), row(planned.architecture).testStrategy)) throw new Error('BUILD_PLAN_RUNTIME_MISMATCH');
          const resume = await host.load(grant, context.signal);
          let generated = await generatePlannedFiles({ ...planInput, ...(resume ? { resume } : {}) }, {
            callLLM: async (prompt, options) => (await model(prompt, options.signal, initialFilesBudget)).text,
          });
          if (!generated.ok) {
            const checkpoint = generated.resume ? await host.save(grant, generated.resume.planDigest, generated.files, context.signal) : undefined;
            return { ok: false, outcome: 'failed', error: generated.code, evidence: { ...evidence(), checkpoint } };
          }
          if (!environment) throw new Error('BUILD_ENVIRONMENT_UNAVAILABLE');
          let imports = unavailableImports(generated.files, environment);
          for (let repair = 0; imports.length && repair < APP_BUILD_MAX_REPAIRS; repair++) {
            const hint = unavailableImportHint(imports, environment);
            const previous = new Map(generated.files.map(file => [file.path, file.content]));
            const firstAffected = generated.files.findIndex(file => imports.some(issue => issue.path === file.path));
            if (firstAffected < 0) throw new Error('BUILD_IMPORTS_UNAVAILABLE');
            const resumePrefix = { planDigest: generated.resume.planDigest, files: generated.files.slice(0, firstAffected) };
            generated = await generatePlannedFiles({ ...planInput, resume: resumePrefix }, { callLLM: async (prompt, options) => {
              const request = row(JSON.parse(prompt));
              return (await model(JSON.stringify({ ...request, testFailure: hint,
                previousContent: previous.get(String(row(request.file).path)) }), options.signal, initialFilesBudget)).text;
            } });
            if (!generated.ok) {
              const checkpoint = generated.resume ? await host.save(grant, generated.resume.planDigest, generated.files, context.signal) : undefined;
              return { ok: false, outcome: 'failed', error: generated.code, evidence: { ...evidence(), checkpoint } };
            }
            imports = unavailableImports(generated.files, environment);
          }
          if (imports.length) return { ok: false, outcome: 'failed', error: 'BUILD_IMPORTS_UNAVAILABLE',
            evidence: { ...evidence(), unavailableImports: imports, environmentReceiptSha256: environmentReceipt?.sha256 } };
          const checkpoint = generated.resume ? await host.save(grant, generated.resume.planDigest, generated.files, context.signal) : undefined;
          return done({ checkpoint, files: generated.files.length, receipts: generated.receipts, buildComplete: false });
        }
        if (stage === 'verify') {
          let resume = await host.load(grant, context.signal);
          if (!resume) throw new Error('BUILD_CHECKPOINT_REQUIRED');
          // Revalidate the entire saved prefix through B1, including content/schema
          // and the current A plan binding, without regenerating successful files.
          let generated = await generatePlannedFiles({ ...planInput, resume }, {
            callLLM: async () => { throw new Error('BUILD_CHECKPOINT_INCOMPLETE'); },
          });
          if (!generated.ok) throw new Error('BUILD_CHECKPOINT_INVALID');
          for (let repair = 0; repair <= APP_BUILD_MAX_REPAIRS; repair++) {
            const testStrategy = row(planned.architecture).testStrategy;
            const selected = testStrategy === undefined ? undefined : parseTestStrategy(testStrategy, planInput.plan);
            const tested = await host.verify(grant, generated.files, context.signal, selected);
            if (tested.passed) return done({ passed: true, files: generated.files.length, repairUsed: repair,
              fileDigest: tested.fileDigest, sandbox: tested.sandbox, testStrategySha256: tested.testStrategySha256,
              testReceipts: tested.testReceipts, buildComplete: false });
            if (repair === APP_BUILD_MAX_REPAIRS) return { ok: false, outcome: 'failed', error: 'BUILD_TESTS_EXHAUSTED',
              evidence: { ...evidence(), repairUsed: repair, diagnosticSha256: createHash('sha256').update(tested.diagnostic).digest('hex'),
                testStrategySha256: tested.testStrategySha256, testReceipts: tested.testReceipts } };
            const previous = new Map(generated.files.map(file => [file.path, file.content]));
            const methodHint = environment ? missingMethodHint(tested.diagnostic, environment) : '';
            generated = await generatePlannedFiles(planInput, { callLLM: async (prompt, options) => {
              const request = row(JSON.parse(prompt));
              return (await model(JSON.stringify({ ...request, testFailure: tested.diagnostic + (methodHint ? '\nMeasured API surface:\n' + methodHint : ''),
                previousContent: previous.get(String(row(request.file).path)) }), options.signal, repairBudgets[repair]!)).text;
            } });
            if (generated.resume) await host.save(grant, generated.resume.planDigest, generated.files, context.signal);
            if (!generated.ok) return { ok: false, outcome: 'failed', error: generated.code, evidence: evidence() };
          }
          throw new Error('BUILD_TESTS_EXHAUSTED');
        }
        if (stage === 'materialize') {
          if (output(context, 'verify-repair').passed !== true) throw new Error('BUILD_TESTS_REQUIRED');
          const resume = await host.load(grant, context.signal);
          if (!resume) throw new Error('BUILD_CHECKPOINT_REQUIRED');
          const checked = await generatePlannedFiles({ ...planInput, resume }, { callLLM: async () => { throw new Error('BUILD_CHECKPOINT_INCOMPLETE'); } });
          if (!checked.ok) throw new Error('BUILD_CHECKPOINT_INVALID');
          const created = await host.materialize(grant, checked.files, row(input.artifactMetadata), context.signal);
          return done({ sourceRoot: created.sourceRoot, fileDigest: created.fileDigest, buildComplete: false });
        }
        if (!output(context, 'materialize').fileDigest) throw new Error('BUILD_ARTIFACT_REQUIRED');
        const published = await host.publish(grant, context.signal);
        return done({ ...published, buildComplete: true });
      } catch (error) {
        const message = error instanceof Error && /^BUILD_[A-Z_]+$/u.test(error.message) ? error.message : 'BUILD_EXECUTION_REFUSED';
        debug.log('app-build.phase', 'blocked', { ...evidence(), error: message });
        return { ok: false, outcome: 'failed', error: message, evidence: evidence() };
      }
    },
  });
}
