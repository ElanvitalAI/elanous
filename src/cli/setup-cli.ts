import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { addSource, listSources } from '../intake-plane/intake-sources.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { Command } from 'commander';
import { formatDoctorReport, registerDoctorCommand, runDoctor, type DoctorOptions, type DoctorReport } from './doctor-cli.js';
import { applyClaudePluginSetup, planClaudePluginSetup } from './claude-plugin-setup.js';
import { recommendedSetup } from './setup-recommend.js';
import { detectSkillCliAuth, type CliAuthStatus } from '../onboarding/cli-auth-status.js';
import { debug } from '../debug/log.js';
import { getUserConfig, saveUserConfig, userConfigPath, type UserConfig } from '../user-config.js';
import { collectServiceKeys, printKeySetupReport } from '../onboarding/key-setup.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { probeProvider } from '../llm/provider-probe.js';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';
import { realIO } from '../onboarding.js';
import { parseServiceKeyEnv, readMaskedServiceEnvPaste } from '../setup/service-keys.js';
import { importServiceKeys, renderServiceKeyStatus, runSetupKeys } from './setup-keys.js';
import { SERVICE_KEY_CATALOG, type ServiceKeyCatalogEntry } from '../setup/llm-env-detect.js';
import { serviceKeyStatus } from '../setup/service-keys.js';
import { detectProviders } from '../llm/provider-detect.js';
import { DEFAULT_PLUGIN_GROUP, defaultPluginStatuses } from '../plugins/install/plugin-install.js';
import type { DefaultPluginStatus } from '../plugins/install/plugin-install.js';

const ELANOUS_LOGIN_COMMAND = 'elanous login openai-codex';
const PROVIDER_COMMAND = 'elanous config set llm.provider openai-codex';
const CODEX_LOGIN_COMMAND = 'codex login';

type SetupStep = {
  name: string;
  complete: boolean;
  command: string;
  symptom: string;
};

export interface SetupCliDeps extends DoctorOptions {
  runDoctor?: (options: DoctorOptions) => DoctorReport;
  runDoctorFix?: (args: readonly string[]) => Promise<number>;
  detectSkillCliAuth?: typeof detectSkillCliAuth;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  homeDir?: () => string;
  getUserConfig?: () => UserConfig;
  saveUserConfig?: (config: UserConfig) => void;
  watchRoot?: string;
  /** Test seam: injected configs are treated as already provisioned unless explicitly first-run. */
  firstRunTopics?: boolean;
  planClaudePluginSetup?: typeof planClaudePluginSetup;
  applyClaudePluginSetup?: typeof applyClaudePluginSetup;
  prompt?: (message: string) => Promise<string | undefined>;
  promptSecret?: (message: string) => Promise<string | undefined>;
  getSecretAsync?: typeof getSecretAsync;
  setSecretAsync?: typeof setSecretAsync;
  probeKey?: typeof probeProvider;
  isStdinTty?: () => boolean;
  out?: { log: (value: string) => void; error?: (value: string) => void };
  setExitCode?: (code: number) => void;
  /** 런타임이 이 config 로 «실제로» 고르는 provider(`decideProviderForConfig().provider`). 시험 seam. */
  resolveRuntimeProvider?: (config: UserConfig) => string | undefined;
  detectProviders?: typeof detectProviders;
  getServiceKeyStatus?: typeof serviceKeyStatus;
  isCommandAvailable?: (command: string) => boolean;
}

/** ⛔ 2026-09-23 — provider 단계는 «문자열 비교»가 아니라 ***런타임의 최종 결정***으로 잰다.
 *  빈 config(=`auto`)도 codex OAuth 가 있으면 런타임은 `auto:openai-codex` 로 이미 고른다(실측).
 *  종전엔 `provider === 'openai-codex'` 만 «완료»로 봐서, setup 이 ***필요 없는 손***
 *  (`elanous config set llm.provider openai-codex`)을 요구하고 「Codex 세션 불가」라고 거짓 표시했다
 *  — Phase 3 「사람 손」 셈의 ③ 이 바로 이것이었다. */
function defaultResolveRuntimeProvider(config: UserConfig): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decideProviderForConfig } = require('../llm.js') as typeof import('../llm.js');
    return decideProviderForConfig(config).provider;
  } catch {
    return undefined;   // 못 풀면 «모른다» — 종전 문자열 판정으로 떨어진다
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function readJson(path: string, exists: (path: string) => boolean, readFile: (path: string) => string): unknown {
  if (!exists(path)) return undefined;
  try { return JSON.parse(readFile(path)); } catch { return undefined; }
}

function hasElanousCodexAuth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const provider = (value as { providers?: Record<string, unknown> }).providers?.['openai-codex'];
  if (typeof provider !== 'object' || provider === null) return false;
  const tokens = (provider as { tokens?: Record<string, unknown> }).tokens;
  return typeof tokens === 'object' && tokens !== null
    && hasNonEmptyString(tokens.accessToken) && hasNonEmptyString(tokens.refreshToken);
}

function hasCodexCliAuth(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const tokens = (value as { tokens?: Record<string, unknown> }).tokens;
  return typeof tokens === 'object' && tokens !== null
    && hasNonEmptyString(tokens.access_token) && hasNonEmptyString(tokens.refresh_token);
}

function setupSteps(deps: SetupCliDeps): SetupStep[] {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const home = (deps.homeDir ?? homedir)();
  const config = (deps.getUserConfig ?? getUserConfig)();
  return [
    {
      name: 'elanous OpenAI Codex login',
      complete: hasElanousCodexAuth(readJson(join(home, '.elanous', 'auth.json'), exists, readFile)),
      command: ELANOUS_LOGIN_COMMAND,
      symptom: 'No LLM provider available can be caused by a missing elanous OpenAI Codex login or provider configuration; check both named steps.',
    },
    {
      name: 'LLM provider configuration',
      complete: config.llm.provider === 'openai-codex'
        || (config.llm.provider === 'auto'
          && (deps.resolveRuntimeProvider ?? defaultResolveRuntimeProvider)(config) === 'auto:openai-codex'),
      command: PROVIDER_COMMAND,
      symptom: 'No LLM provider available means this LLM provider configuration step is missing.',
    },
    {
      name: 'Codex CLI login',
      complete: hasCodexCliAuth(readJson(join(home, '.codex', 'auth.json'), exists, readFile)),
      command: CODEX_LOGIN_COMMAND,
      symptom: 'codex app-server stdin drain timeout can be caused by this missing Codex CLI login step; it is not quota exhaustion.',
    },
  ];
}

function missingRequiredCommands(doctor: DoctorReport): boolean {
  return doctor.externalCommands.some((command) => command.status === 'missing' && command.tier === 'required');
}

function missingGitCapability(doctor: DoctorReport): boolean {
  return doctor.externalCommands.some((command) => command.name === 'git' && command.status !== 'found');
}

function displayCommand(command: string[]): string {
  return command.map((arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
}

export function formatSetupReport(doctor: DoctorReport, steps: SetupStep[], nonInteractive: boolean): string {
  const elanousLogin = steps[0]!.complete;
  const provider = steps[1]!.complete;
  const codexLogin = steps[2]!.complete;
  const externalReady = doctor.ok && !missingRequiredCommands(doctor) && !missingGitCapability(doctor);
  const capabilities = [
    { name: 'OpenAI Codex-backed elanous sessions', ready: elanousLogin && provider },
    { name: 'Codex app-server integration', ready: codexLogin && externalReady },
    { name: 'External command-dependent integrations', ready: externalReady },
  ];
  return [
    'Setup: external command check',
    formatDoctorReport(doctor),
    'Setup: LLM credential steps',
    ...steps.map((step) => step.complete
      ? `completed: ${step.name}`
      : `missing: ${step.name} — run \`${step.command}\`\n  ${step.symptom}`),
    // 대화형 경로도 provider 가 «미완»일 때만 묻는다 — 비대화형 문면을 그것과 맞춘다.
    ...(nonInteractive ? ['Non-interactive: no questions were asked and no configuration was written.', ...(provider ? [] : ['Would ask: Set llm.provider to openai-codex now? [y/N]'])] : []),
    'Available now:',
    ...capabilities.filter((capability) => capability.ready).map((capability) => `- ${capability.name}`),
    'Unavailable until setup is complete:',
    ...capabilities.filter((capability) => !capability.ready).map((capability) => `- ${capability.name}`),
  ].join('\n');
}

const CLI_SKILLS = {
  gh: 'github', gws: 'google-workspace', op: '1password', himalaya: 'himalaya',
} as const;

function formatCliSkillStatus(status: CliAuthStatus, enabled: boolean, reason?: string): string {
  return `${status.cli}: found=${status.found ? 'yes' : 'no'} / enabled=${enabled ? 'yes' : 'no'} / ${enabled ? 'enabled' : `skipped (${reason ?? status.skippedReason ?? 'not authenticated'})`}`;
}

function reportCliSkills(deps: SetupCliDeps, apply: boolean): string[] {
  const statuses = (deps.detectSkillCliAuth ?? detectSkillCliAuth)();
  const config = (deps.getUserConfig ?? getUserConfig)();
  const deny = new Set(config.skills.deny ?? []);
  const allow = config.skills.allow ?? [];
  let changed = false;
  const lines = statuses.map((status) => {
    const skill = CLI_SKILLS[status.cli];
    const allowed = allow.length === 0 || allow.some((name) => name.toLowerCase() === skill);
    if (apply) {
      if (status.authenticated && allowed && deny.has(skill)) { deny.delete(skill); changed = true; }
      if (!status.authenticated && !deny.has(skill)) { deny.add(skill); changed = true; }
    }
    const enabled = status.authenticated && allowed && !deny.has(skill);
    return formatCliSkillStatus(status, enabled,
      status.authenticated && !allowed ? 'excluded by skills.allow' :
        status.authenticated && !apply && deny.has(skill) ? 'not enabled; run setup to apply' : undefined);
  });
  if (apply && changed) (deps.saveUserConfig ?? saveUserConfig)({
    ...config, skills: { ...config.skills, deny: [...deny] },
  });
  return lines;
}

/** 최초 셋업 묶음 제안(읽기 전용). 등급·승인 어휘는 문서 원전을 그대로 쓴다 —
 *  묶음·층 구성 = 내부 문서 `RESEARCH-plugins-connectors-baseline-2026-09-30` §4(0층 «키 없이 항상 켬»),
 *  항목별 보안 등급·승인 = 같은 문서 §5. §5 표에 등급이 없는 0층 항목(Edge/macOS TTS·스킬)은
 *  등급을 지어내지 않기 위해 목록에서 뺀다. 실제 설치·자격 부여는 승인 뒤 후속 조각(plan-then-apply). */
interface SetupBundleItem {
  name: string;
  grade: string;
  approval: string;
}

const DEFAULT_SETUP_BUNDLE: readonly SetupBundleItem[] = [
  { name: '셸·파일(작업 트리 안)', grade: '쓰기(로컬)', approval: '기존 모래상자·워크트리 규칙' },
  { name: 'WebFetch', grade: '읽기', approval: '불요' },
  { name: 'WebSearch(무료 DuckDuckGo·Jina)', grade: '읽기', approval: '불요' },
  { name: 'GitHub 공개 읽기(무인증)', grade: '읽기', approval: '불요' },
  { name: 'PDF/HWP 읽기', grade: '읽기', approval: '불요' },
  { name: '비전', grade: '읽기', approval: '불요' },
  { name: 'Obsidian 검색', grade: '읽기', approval: '불요' },
  { name: 'Obsidian 쓰기', grade: '쓰기(로컬)', approval: 'vault-write-guard' },
  { name: '기억·일정', grade: '쓰기(로컬)', approval: '기존 모래상자·워크트리 규칙' },
  { name: 'CDP 브라우저 탐색·읽기', grade: '읽기(네트워크)', approval: '불요(클릭·입력은 쓰기 → 승인)' },
];

function formatDefaultBundleProposal(): string[] {
  return [
    'Setup: 기본 플러그인·커넥터 묶음 제안 (읽기 전용)',
    `묶음 1/1: 기본 묶음 — 키 없이 항상 켬(0층) · 항목 ${DEFAULT_SETUP_BUNDLE.length}개`,
    ...DEFAULT_SETUP_BUNDLE.map((item) => `- ${item.name} — 보안 등급: ${item.grade} · 승인: ${item.approval}`),
    '후속 층(승인 뒤 조각): 1층 로그인된 CLI 재사용 · 2층 원격 MCP 한 번 OAuth · 3층 채널',
    '제안은 표시만 합니다 — 승인 전 설치 0 · 자격 쓰기 0 · 승인 뒤 설치는 `elanous plugin add <spec>` 경로로(후속 조각)',
  ];
}

/** Check the default plugin group's required/optional connector declarations against the runtime catalog. */
export function validateDefaultPluginServiceKeys(
  group: readonly { id: string; requiredServiceKeys: readonly string[]; optionalServiceKeys: readonly string[] }[] = DEFAULT_PLUGIN_GROUP,
  catalog: readonly Pick<ServiceKeyCatalogEntry, 'id' | 'kind'>[] = SERVICE_KEY_CATALOG,
): string[] {
  const errors: string[] = [];
  const catalogIds = new Set<string>();
  for (const item of catalog) {
    if (catalogIds.has(item.id)) errors.push(`중복 서비스 카탈로그 id: ${item.id}`);
    catalogIds.add(item.id);
  }
  for (const plugin of group) {
    const required = new Set<string>();
    const optional = new Set<string>();
    for (const id of plugin.requiredServiceKeys) {
      if (required.has(id)) errors.push(`${plugin.id}: 필수 키 중복 ${id}`);
      required.add(id);
    }
    for (const id of plugin.optionalServiceKeys) {
      if (optional.has(id)) errors.push(`${plugin.id}: 선택 키 중복 ${id}`);
      optional.add(id);
      if (required.has(id)) errors.push(`${plugin.id}: required/optional 중복 ${id}`);
    }
    for (const id of [...required, ...optional]) {
      const item = catalog.find(candidate => candidate.id === id);
      if (!item) errors.push(`${plugin.id}: 서비스 카탈로그에 없는 키 ${id}`);
      else if (item.kind !== 'api-key') errors.push(`${plugin.id}: API 키가 아닌 서비스 참조 ${id} (${item.kind})`);
    }
  }
  return errors;
}

function commandAvailable(command: string): boolean {
  const path = process.env.PATH ?? '';
  return path.split(delimiter).some(directory => {
    try { accessSync(join(directory, command), constants.X_OK); return true; } catch { return false; }
  });
}

function formatDefaultPluginStatuses(statuses: readonly DefaultPluginStatus[]): string[] {
  return [
    'Setup: 기본 플러그인 묶음 상태 (실제 키·선행 조건)',
    ...statuses.map(plugin => {
      const missing = [
        ...(plugin.missingRequiredKeys.length ? [`필수 키 ${plugin.missingRequiredKeys.join(', ')}`] : []),
        ...(plugin.missingPrerequisites.length ? [`선행 조건 ${plugin.missingPrerequisites.join(', ')}`] : []),
      ];
      const optional = plugin.optionalKeysMissing.length
        ? ` · 선택 키 미설정 ${plugin.optionalKeysMissing.join(', ')}` : '';
      return `${plugin.status === 'ready' ? '✓' : '○'} ${plugin.label}: ${plugin.status}${missing.length ? ` · ${missing.join(' · ')}` : ''}${optional}`;
    }),
  ];
}

async function readDefaultPluginStatuses(deps: SetupCliDeps): Promise<DefaultPluginStatus[]> {
  const catalogErrors = validateDefaultPluginServiceKeys();
  if (catalogErrors.length) throw new Error(`기본 플러그인 서비스 카탈로그 오류: ${catalogErrors.join('; ')}`);
  const keys = (deps.getServiceKeyStatus ?? serviceKeyStatus)()
    .filter(item => item.configured).map(item => item.id);
  const providers = await (deps.detectProviders ?? detectProviders)();
  const prerequisites = new Set<string>();
  if (providers.some(provider => provider.available && provider.auth !== 'agent-cli')) prerequisites.add('llm-provider');
  if ((deps.isCommandAvailable ?? commandAvailable)('aside')) prerequisites.add('aside');
  if ((deps.isCommandAvailable ?? commandAvailable)('claude')) prerequisites.add('claude-cli');
  if ((deps.isCommandAvailable ?? commandAvailable)('gh')) prerequisites.add('github-cli');
  return defaultPluginStatuses({ readyServiceKeyIds: keys, satisfiedPrerequisites: [...prerequisites] });
}

export function registerSetupCommand(program: Command, deps: SetupCliDeps = {}): void {
  const out = deps.out ?? { log: (value: string) => console.log(value), error: (value: string) => console.error(value) };
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const doctorRunner = deps.runDoctor ?? runDoctor;
  const isFirstRunSetup = (): boolean => deps.firstRunTopics ?? (!deps.getUserConfig && !existsSync(userConfigPath()));
  const showDefaultBundleProposal = async (): Promise<void> => {
    for (const line of formatDefaultBundleProposal()) out.log(line);
    for (const line of formatDefaultPluginStatuses(await readDefaultPluginStatuses(deps))) out.log(line);
  };
  const showCliSkills = (apply: boolean) => {
    out.log('Setup: CLI skills (public GitHub repository reads remain available without login)');
    for (const line of reportCliSkills(deps, apply)) out.log(line);
  };
  const isStdinTty = deps.isStdinTty ?? (() => process.stdin.isTTY === true);
  const prompt = deps.prompt ?? (async (message: string) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(message); } finally { rl.close(); }
  });
  // API keys must never fall back to the ordinary (echoing) setup prompt.
  const askSecret = deps.promptSecret ?? createSecretPrompt();

  const setup = program.command('setup')
    .description('Check OpenAI Codex setup and guide each missing credential step')
    .option('--non-interactive', 'Report setup state without prompts or writes')
    .option('--yes', 'Set a missing Codex provider and apply recommended doctor repairs without asking')
    .action(async (opts: { nonInteractive?: boolean; yes?: boolean }) => {
      const doctor = doctorRunner(deps);
      if (opts.nonInteractive) {
        out.log(formatSetupReport(doctor, setupSteps(deps), true));
        showCliSkills(false);
        if (isFirstRunSetup()) await showDefaultBundleProposal();
        for (const line of recommendedSetup((deps.getUserConfig ?? getUserConfig)())) out.log(line);
        setExitCode(0);
        return;
      }
      if (!isStdinTty() && !opts.yes) {
        (out.error ?? out.log)('대화형 온보딩은 stdin TTY가 있는 자리에서만 실행할 수 있다. 무인 설정은 `elanous setup --non-interactive`를 사용하라.');
        setExitCode(1);
        return;
      }
      const isFirstRun = isFirstRunSetup();
      let steps = setupSteps(deps);
      const provider = steps[1]!;
      if (!provider.complete) {
        const approved = opts.yes || (await prompt('Set llm.provider to openai-codex now? [y/N] '))?.trim().toLowerCase() === 'y';
        if (approved) {
          const config = (deps.getUserConfig ?? getUserConfig)();
          (deps.saveUserConfig ?? saveUserConfig)({ ...config, llm: { ...config.llm, provider: 'openai-codex' } });
          steps = setupSteps(deps);
        } else {
          out.log(`Not changed. To complete LLM provider configuration, run \`${PROVIDER_COMMAND}\`.`);
        }
      }
      out.log(formatSetupReport(doctor, steps, false));
      showCliSkills(false);
      if (isFirstRun) await showDefaultBundleProposal();
      for (const line of recommendedSetup((deps.getUserConfig ?? getUserConfig)())) out.log(line);
      let configured = (deps.getUserConfig ?? getUserConfig)();
      if (!configured.starter?.topics && configured.watch?.enabled !== false
        && isFirstRun
        && isStdinTty() && !opts.yes) {
        const answer = (await prompt('관심 주제는 무엇인가요? (쉼표로 구분 · 건너뛰려면 Enter) '))?.trim();
        if (answer) {
          configured = { ...configured, starter: { topics: answer.split(',').map((topic) => topic.trim()).filter(Boolean) } };
          (deps.saveUserConfig ?? saveUserConfig)(configured);
        }
      }
      const starter = configured.starter;
      if (Array.isArray(starter?.topics) && configured.watch?.enabled !== false) {
        const root = deps.watchRoot ?? effectiveInstanceRoot();
        const existing = listSources({ seat: 'user' }, root);
        for (const rawTopic of starter.topics) {
          if (typeof rawTopic !== 'string' || !rawTopic.trim()) continue;
          const topic = rawTopic.trim();
          if (existing.some((source) => source.kind === 'github-query' && source.spec === topic)) continue;
          const id = `watch-${createHash('sha256').update(topic).digest('hex').slice(0, 12)}`;
          if (listSources({}, root).some((source) => source.id === id)) continue;
          existing.push(addSource({ id, seat: 'user', kind: 'github-query', spec: topic, every: '1d', why: 'starter.topics' }, root));
        }
      }
      const accepted = opts.yes || (isStdinTty() && /^(?:y|yes)?$/i.test((await prompt('추천대로 켤까요? [Y/n] '))?.trim() ?? 'n'));
      if (accepted) {
        const runDoctorFix = deps.runDoctorFix ?? (async (args: readonly string[]) => {
          const doctorProgram = new Command();
          let exitCode = 0;
          registerDoctorCommand(doctorProgram, {
            out,
            err: { error: (message) => (out.error ?? out.log)(message) },
            setExitCode: (code) => { exitCode = code; },
          });
          await doctorProgram.parseAsync([...args], { from: 'user' });
          return exitCode;
        });
        const fixCode = await runDoctorFix(['doctor', '--fix', '--yes']);
        showCliSkills(true);
        setExitCode(fixCode);
        return;
      }
      setExitCode(0);
    });

  setup.command('service-keys')
    .description('Import and verify service API keys without rendering their values')
    .action(async () => {
      if (!isStdinTty()) {
        (out.error ?? out.log)('키 설정은 stdin TTY가 있는 자리에서만 실행할 수 있다.');
        setExitCode(1);
        return;
      }
      try {
        const results = await collectServiceKeys({
          config: (deps.getUserConfig ?? getUserConfig)(),
          promptSecret: askSecret,
          print: out.log,
          getSecret: deps.getSecretAsync,
          setSecret: deps.setSecretAsync,
          probe: deps.probeKey,
        });
        printKeySetupReport(results, out.log);
        setExitCode(results.some((result) => result.status === 'failed') ? 1 : 0);
      } catch {
        (out.error ?? out.log)('키 설정을 완료하지 못했습니다. 민감한 오류 내용은 숨겼습니다.');
        setExitCode(1);
      }
    });

  setup.command('claude-code')
    .description('Plan or install the elanous Claude Code plugin')
    .option('--apply', 'Install missing steps and verify the MCP connection')
    .option('--source <URL|경로|owner/repo>', 'Claude plugin marketplace source')
    .option('--json', 'Print the plan or result as one JSON line')
    .action(async (opts: { apply?: boolean; source?: string; json?: boolean }) => {
      let ready: boolean | undefined;
      let needed: number | undefined;
      let executed: number | undefined;
      let mcpVerified: boolean | undefined;
      try {
        const plan = await (deps.planClaudePluginSetup ?? planClaudePluginSetup)({ source: opts.source });
        ready = plan.ready;
        needed = plan.steps.filter((step) => step.needed).length;
        debug.log('setup.claude-code', 'planned', { ready, needed, executed, mcpVerified });
        if (opts.apply) {
          const result = await (deps.applyClaudePluginSetup ?? applyClaudePluginSetup)(plan);
          executed = result.executed.length;
          mcpVerified = result.mcpVerified;
          ready = result.verification.ready;
          if (opts.json) out.log(JSON.stringify(result));
          else {
            for (const command of result.executed) out.log(`✓ 실행: ${displayCommand(command)}`);
            out.log(`MCP 확인: ${mcpVerified ? '✓ 완료' : '✗ 실패'}`);
          }
          debug.log('setup.claude-code', result.ok ? 'applied' : 'failed', { ready, needed, executed, mcpVerified });
          setExitCode(result.ok ? 0 : 1);
          return;
        }
        if (opts.json) out.log(JSON.stringify(plan));
        else {
          for (const binary of [
            { available: plan.claudeCode, name: 'claude', reason: 'Claude Code is not installed' },
            { available: plan.node, name: 'node', reason: 'node is not on PATH' },
            { available: plan.elanous, name: 'elanous', reason: 'elanous is not on PATH' },
          ]) {
            out.log(binary.available ? `✓ 완료: ${binary.name}` : `✗ 막힘: ${binary.reason}`);
          }
          for (const step of plan.steps) {
            out.log(step.needed ? `→ 할 일: ${displayCommand(step.command)}` : `✓ 완료: ${displayCommand(step.command)}`);
          }
          out.log(plan.ready ? '준비됨' : '--apply 로 실행');
        }
        setExitCode(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug.log('setup.claude-code', 'failed', { ready, needed, executed, mcpVerified });
        (out.error ?? out.log)(message.replace(/\r?\n/g, ' '));
        setExitCode(1);
      }
    });

  setup.command('keys')
    .description('Set up service credentials without printing secret values')
    .option('--status', 'Show credential presence only')
    .option('--import-env-file <path>', 'Import catalogued keys from a dotenv file')
    .option('--paste-env', 'Paste a dotenv block into a hidden terminal prompt')
    .option('--all', 'Include optional service keys during interactive setup; --status always shows all services')
    .action(async (opts: { status?: boolean; importEnvFile?: string; pasteEnv?: boolean; all?: boolean }) => {
      const keyConfig = (deps.getUserConfig ?? getUserConfig)();
      const keyOptions = { config: keyConfig, includeOptional: opts.all === true };
      try {
        if (opts.status) {
          if (opts.all) throw new Error('--status already shows the full catalog; omit --all');
          for (const line of renderServiceKeyStatus()) out.log(line);
          for (const line of formatDefaultPluginStatuses(await readDefaultPluginStatuses(deps))) out.log(line);
          setExitCode(0);
          return;
        }
        let text: string | undefined;
        if (opts.importEnvFile) text = readFileSync(opts.importEnvFile, 'utf8');
        else if (opts.pasteEnv) {
          if (!isStdinTty()) throw new Error('hidden paste import requires a terminal');
          text = await readMaskedServiceEnvPaste();
        }
        if (text !== undefined) {
          const parsed = parseServiceKeyEnv(text);
          const result = await importServiceKeys(parsed, { print: (line) => out.log(line) }, keyOptions);
          setExitCode(result.rejected.length ? 1 : 0);
          return;
        }
        if (!isStdinTty()) throw new Error('secret input requires a terminal; use --import-env-file for a protected dotenv file');
        const io = realIO();
        try { await runSetupKeys(io, keyOptions); }
        finally { io.close(); }
        setExitCode(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'setup keys failed';
        (out.error ?? out.log)(message.replace(/\r?\n/g, ' '));
        setExitCode(1);
      }
    });
}
