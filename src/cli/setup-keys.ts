import { SERVICE_KEY_CATALOG } from '../setup/llm-env-detect.js';
import { serviceKeyStatus, storeServiceKeys, verifyServiceKey, type ParsedServiceKeyEnv } from '../setup/service-keys.js';
import { detectProviders } from '../llm/provider-detect.js';
import { loginWithCodex } from '../oauth/codex.js';
import type { FirstRunProviderSetupResult } from '../onboarding/first-run.js';
import { MODEL_ROLES, resolveRoleLlm, userConfigPath } from '../user-config.js';
import type { LLMProviderName, UserConfig } from '../user-config/types.js';
import { parseMenuAnswer } from '../onboarding/menu-answer.js';
import { isHeadlessEnv } from '../acp/codex-auth.js';
import { listCredentialSlotsAsync, selectBackendFromConfig, setCredentialSlotBatchAsync } from '../nexus/config/secrets/index.js';
import { scanCredentialImports, type CredentialImportScan } from '../setup/cred-import-scan.js';

export interface SetupKeysIO {
  ask(prompt: string): Promise<string>;
  askSecret?(prompt: string): Promise<string>;
  print(message: string): void;
  updateLine?(message: string): void;
  finishLine?(): void;
  onInterrupt?(handler: () => void): () => void;
}

export type SetupKeyProvider = Extract<(typeof SERVICE_KEY_CATALOG)[number], { kind: 'api-key' }>['id'];
export type SetupKeyValidationResult =
  | { success: true; verification: 'verified' | 'unsupported' }
  | { success: false; reason: 'invalid' | 'rate-limited' | 'unavailable'; httpStatus?: number };
export type SetupKeyVerifier = (input: { provider: SetupKeyProvider; apiKey: string }) => Promise<SetupKeyValidationResult>;

export interface SetupKeysOptions {
  config: UserConfig;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  homeDir?: string;
  cwd?: string;
  configPath?: string;
  includeOptional?: boolean;
  /** Override GUI-less shell detection in first-run tests/embedders. */
  isHeadless?: () => boolean;
  /** Existing OAuth fetch injection used by deterministic login simulation. */
  loginWithCodex?: typeof loginWithCodex;
  /** Verification seam for deterministic setup simulations; the production default remains verifyServiceKey. */
  verifier?: SetupKeyVerifier;
  /** Storage seams for the metadata-only existing credential import proposal. */
  initializeCredentialBackend?: () => void;
  listCredentialSlots?: typeof listCredentialSlotsAsync;
  saveCredentialSlotBatch?: typeof setCredentialSlotBatchAsync;
}

export interface FirstRunProviderSetupOptions extends SetupKeysOptions {
  /** Required so the first-run OAuth boundary is explicit and observable in tests. */
  loginWithCodex: typeof loginWithCodex;
}

function providerForService(id: string): string | undefined {
  switch (id) {
    case 'openai-api': return 'openai';
    case 'anthropic-api': return 'anthropic';
    case 'gemini-api': return 'gemini';
    case 'openrouter': return 'openrouter';
    case 'xai': return 'grok';
    case 'opengateway': return 'opengateway';
    default: return undefined;
  }
}

function providerBaseUrl(config: UserConfig, serviceId: string): string | undefined {
  const provider = providerForService(serviceId);
  if (!provider) return undefined;
  return config.llm.rotation?.find(item => item.provider === provider)?.baseUrl;
}

function renderProviderProposal(config: UserConfig, providers: Awaited<ReturnType<typeof detectProviders>>): string[] {
  const available = providers.filter(provider => provider.available).sort((a, b) => a.rank - b.rank);
  const ordered = [...new Set(available.map(provider => provider.provider))];
  const defaultProvider = ordered.includes(config.llm.provider) ? config.llm.provider : ordered[0];
  const fallback = config.llm.fallbackChain ?? [];
  const suggestion = defaultProvider ? [defaultProvider, ...ordered.filter(name => name !== defaultProvider)] : [];
  return [
    `LLM 감지: ${available.length ? available.map(provider => `${provider.provider}(${provider.auth})`).join(' · ') : '사용 가능한 인증 없음'}`,
    `기본 제안: ${defaultProvider ?? '설정 후 선택'} · 현재 기본: ${config.llm.provider}`,
    `폴백 제안: ${suggestion.length ? suggestion.join(' → ') : '현재 설정 유지'} · 현재 llm.fallbackChain: ${fallback.length ? fallback.join(' → ') : '미설정'}`,
    `역할별 현재 해석: ${MODEL_ROLES.map(role => {
      try {
        const resolved = resolveRoleLlm(role, { config });
        return `${role}=${resolved.provider}/${resolved.model}`;
      } catch {
        return `${role}=미설정`;
      }
    }).join(' · ')}`,
    '위 내용은 제안만 표시하며 roleLlm·llm.fallbackChain을 변경하지 않습니다.',
  ];
}

export async function renderServiceKeyStatus(options: { env?: NodeJS.ProcessEnv; cacheDir?: string; getSecret?: (id: string) => Promise<string | undefined> } = {}): Promise<string[]> {
  const status = await serviceKeyStatus(options);
  return SERVICE_KEY_CATALOG.map(item => {
    const row = status.find(candidate => candidate.id === item.id);
    if (!row) return `${item.label}: 상태 확인 불가`;
    if (item.kind === 'api-key') {
      const state = row.sourceCheckFailed && !row.configured ? '상태 확인 불가' : row.configured ? '키 있음' : '키 필요';
      return `${item.label}: ${state} (${row.sources.join(', ') || '감지된 출처 없음'})`;
    }
    return `${item.label}: ${item.kind === 'subscription' || item.kind === 'oauth' || item.kind === 'cli' ? '로그인/설치 상태는 별도 감지' : '로컬 도구 확인 필요'}`;
  });
}

export async function importServiceKeys(values: ParsedServiceKeyEnv, io: Pick<SetupKeysIO, 'print'>, options: SetupKeysOptions): Promise<{ stored: string[]; rejected: string[]; unverified: string[] }> {
  const accepted = new Map<string, string>();
  const rejected: string[] = [];
  const unverified: string[] = [];
  const env = options.env ?? process.env;
  for (const [name, value] of values) {
    const item = SERVICE_KEY_CATALOG.find(candidate => candidate.kind === 'api-key' && candidate.envNames.includes(name));
    if (!item) { rejected.push(name); continue; }
    if (env[name]?.trim() === value) io.print(`${name}: 환경에서 이미 제공됨 · 캐시에도 저장합니다 · 값 출력 0`);
    const verification = options.verifier
      ? await options.verifier({ provider: item.id as SetupKeyProvider, apiKey: value })
      : await verifyServiceKey(item.id, value, {
        env,
        cacheDir: options.cacheDir,
        baseUrl: providerBaseUrl(options.config, item.id),
      }).then(({ result, httpStatus }): SetupKeyValidationResult => result === 'verified' || result === 'unsupported'
        ? { success: true, verification: result }
        : { success: false, reason: result, ...(httpStatus === undefined ? {} : { httpStatus }) });
    if (verification.success && verification.verification === 'verified') accepted.set(name, value);
    else if (verification.success && verification.verification === 'unsupported') {
      accepted.set(name, value);
      unverified.push(name);
      io.print(`${item.label}: 최소 확인을 지원하지 않아 검증 없이 저장합니다 · 값 출력 0`);
    }
    else if (verification.success === false) {
      rejected.push(name);
      io.print(`${item.label}: 검증 ${verification.reason}${verification.httpStatus ? ` (HTTP ${verification.httpStatus})` : ''} · 저장 안 함`);
    }
  }
  const cached = new Map<string, string>();
  const stored: string[] = [];
  for (const [name, value] of accepted) {
    const item = SERVICE_KEY_CATALOG.find(candidate => candidate.kind === 'api-key' && candidate.envNames.includes(name));
    if (item?.id === 'openrouter' && item.storeIds?.[0]) {
      try {
        await (options.saveCredentialSlotBatch ?? setCredentialSlotBatchAsync)({ [item.storeIds[0]]: value });
        env[name] = value;
        stored.push(name);
      } catch { rejected.push(name); }
    } else cached.set(name, value);
  }
  if (cached.size) stored.push(...storeServiceKeys(cached, { env, cacheDir: options.cacheDir }).stored);
  if (stored.length) io.print(`저장 완료: ${stored.sort().join(', ')} · 값 출력 0`);
  return { stored: stored.sort(), rejected: rejected.sort(), unverified: unverified.sort() };
}

function parseImportSelection(answer: string, count: number): number[] | undefined {
  const tokens = answer.split(',').map(token => token.trim()).filter(Boolean);
  if (!tokens.length || tokens.some(token => !/^\d+$/.test(token))) return undefined;
  const indices = tokens.map(Number);
  if (indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) return undefined;
  if (new Set(indices).size !== indices.length) return undefined;
  return indices;
}

/** Offer source metadata, then pass only explicit user selections to the canonical credential-slot writer. */
export async function importExistingCredentialSources(io: Pick<SetupKeysIO, 'ask' | 'print'>, options: SetupKeysOptions): Promise<string[]> {
  let scan: CredentialImportScan;
  try {
    (options.initializeCredentialBackend ?? selectBackendFromConfig)();
    const inventory = await (options.listCredentialSlots ?? listCredentialSlotsAsync)();
    scan = scanCredentialImports({
      homeDir: options.homeDir,
      cwd: options.cwd,
      configPath: options.configPath ?? userConfigPath(),
      existingSlots: inventory.filter(slot => slot.present).map(slot => slot.id),
    });
  } catch {
    io.print('기존 자격 가져오기: 슬롯 상태를 확인할 수 없어 건너뜁니다 · 값 출력 0');
    return [];
  }
  if (scan.proposals.length === 0) {
    io.print('기존 자격 가져오기: 가져올 후보 없음 · 값 출력 0');
    return [];
  }
  io.print('기존 자격 가져오기 제안 (값은 표시하지 않음):');
  scan.proposals.forEach((proposal, index) => {
    const review = proposal.reason ? ` · 가져오지 않음: ${proposal.reason}` : '';
    io.print(`${index} ${proposal.name} · ${proposal.sourcePath} → ${proposal.slot}${review}`);
  });
  const answer = (await io.ask('eln secret에 가져올 번호 (쉼표로 여러 개, Enter=건너뜀): ')).trim();
  if (!answer) return [];
  const indices = parseImportSelection(answer, scan.proposals.length);
  if (!indices) {
    io.print('기존 자격 가져오기: 선택이 올바르지 않아 저장하지 않았습니다 · 값 출력 0');
    return [];
  }
  const selected = indices.map(index => scan.proposals[index]!).filter(Boolean);
  const unresolved = selected.find(proposal => proposal.reason);
  if (unresolved) {
    io.print(`선택한 후보는 안전하게 해석되지 않아 저장하지 않았습니다 · ${unresolved.reason} · 값 출력 0`);
    return [];
  }
  let values: Record<string, string>;
  try { values = scan.readSelected(selected.map(proposal => proposal.id)); }
  catch {
    io.print('기존 자격 가져오기: 같은 슬롯 후보는 하나만 선택해야 합니다 · 저장 안 함 · 값 출력 0');
    return [];
  }
  try {
    await (options.saveCredentialSlotBatch ?? setCredentialSlotBatchAsync)(values);
    const slots = Object.keys(values).sort();
    io.print(`eln secret 가져오기 완료: ${slots.join(', ')} · 값 출력 0`);
    return slots;
  } catch {
    io.print('기존 자격 가져오기: 저장하지 못했습니다 · 값 출력 0');
    return [];
  }
}

export async function runSetupKeys(io: SetupKeysIO, options: SetupKeysOptions): Promise<{ stored: string[]; skipped: string[] }> {
  await importExistingCredentialSources(io, options);
  const providers = await detectProviders({ env: options.env });
  for (const line of renderProviderProposal(options.config, providers)) io.print(line);
  const { listCodexAccountsInStore } = await import('../oauth/codex-account-store.js');
  const codexAccounts = listCodexAccountsInStore().map(account => account.name);
  io.print(`Codex 계정: ${codexAccounts.length ? codexAccounts.join(', ') : '없음'} · 추가: 별도 CODEX_HOME에서 codex login 후 elanous provider codex account import <이름> --home <홈>`);
  const statuses = await serviceKeyStatus({ env: options.env, cacheDir: options.cacheDir });
  const entries = SERVICE_KEY_CATALOG.filter(item => item.kind === 'api-key' && (item.demoRequired || options.includeOptional));
  const stored: string[] = [];
  const skipped: string[] = [];
  for (const item of entries) {
    const status = statuses.find(candidate => candidate.id === item.id);
    if (!status) { io.print(`${item.label}: 상태 확인 불가 · 건너뜀`); skipped.push(item.id); continue; }
    if (status.configured) { io.print(`${item.label}: 이미 설정됨`); continue; }
    const envName = item.envNames[0];
    if (!envName) continue;
    io.print(`${item.label} · ${item.setupUrl} · ${item.demoRequired ? '데모 필요' : '선택'}`);
    if (!io.askSecret) {
      io.print(`${item.label}: 이 입력 화면은 비밀 입력을 지원하지 않습니다 · eln setup keys --paste-env 사용`);
      skipped.push(item.id);
      continue;
    }
    const value = (await io.askSecret(`${envName} (Enter=건너뜀): `)).trim();
    if (!value) { skipped.push(item.id); continue; }
    const result = await importServiceKeys(new Map([[envName, value]]), io, options);
    if (result.stored.includes(envName)) stored.push(envName);
    else skipped.push(item.id);
  }
  for (const line of await renderServiceKeyStatus({ env: options.env, cacheDir: options.cacheDir })) io.print(line);
  return { stored, skipped };
}

export const FIRST_RUN_PROVIDER_SETUP_MENU_HEADING = '처음 실행 LLM 설정';
export const FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES = '1 Codex 구독 로그인 · 2 API 키 입력 · Enter 건너뛰기';
export const FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES = 3;

/** First-run entry: offer the existing Codex device login or the same verified-key flow as `setup keys`. */
export async function runFirstRunProviderSetup(io: SetupKeysIO, options: FirstRunProviderSetupOptions): Promise<FirstRunProviderSetupResult> {
  const choices = ['codex-login', 'api-key'] as const;
  let misses = 0;
  let choice: typeof choices[number];
  for (;;) {
    io.print(FIRST_RUN_PROVIDER_SETUP_MENU_HEADING);
    io.print(FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES);
    const parsed = parseMenuAnswer(await io.ask('선택: '), choices);
    if (parsed.kind === 'cancel') return null;
    if (parsed.kind === 'miss') {
      misses += 1;
      if (misses >= FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES) return { kind: 'needs-llm' };
      continue;
    }
    choice = parsed.provider;
    break;
  }

  if (choice === 'codex-login') {
    const headless = options.isHeadless?.() ?? isHeadlessEnv(options.env);
    const controller = new AbortController();
    let waitingStartedAt: number | undefined;
    let waitLineStarted = false;
    let waitingLinePrinted = false;
    let cancelled = false;
    let cancelLogin: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const elapsedSeconds = () => Math.floor((Date.now() - (waitingStartedAt ?? Date.now())) / 1000);
    const updateWaitLine = () => {
      if (!headless || !io.updateLine || waitingStartedAt === undefined) return;
      waitLineStarted = true;
      io.updateLine('Codex 로그인 대기 중… ' + elapsedSeconds() + '초 · Ctrl-C 건너뛰기');
    };
    const interrupted = new Promise<'cancel'>(resolve => {
      cancelLogin = io.onInterrupt?.(() => {
        cancelled = true;
        controller.abort();
        resolve('cancel');
      });
    });
    const login = options.loginWithCodex({
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === 'user_code') {
          if (headless) {
            io.print('헤드리스 Codex 로그인 · 브라우저에서 아래 주소를 열고 코드를 입력하세요');
            io.print('주소: ' + event.loginUrl);
            io.print('코드: ' + event.userCode);
            waitingStartedAt = Date.now();
            updateWaitLine();
            if (io.updateLine) timer = setInterval(updateWaitLine, 1_000);
          } else {
            io.print('Codex 로그인: ' + event.loginUrl + ' · 코드 ' + event.userCode);
          }
        } else if (event.type === 'polling') {
          if (headless) updateWaitLine();
          else if (!waitingLinePrinted) {
            io.print('Codex 로그인을 기다리는 중… · Ctrl-C 건너뛰기');
            waitingLinePrinted = true;
          }
        } else if (event.type === 'exchanging') {
          if (headless) {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            io.updateLine?.('Codex 로그인 확인 중… ' + elapsedSeconds() + '초');
          } else io.print('Codex 로그인을 확인하는 중…');
        }
      },
    });
    try {
      const outcome = await Promise.race([login.then(() => 'complete' as const), interrupted]);
      if (outcome === 'cancel') {
        controller.abort();
        void login.catch(() => {});
        if (waitLineStarted) io.finishLine?.();
        io.print('Codex 로그인을 건너뛰었습니다. 나중에 elanous login openai-codex로 이어갈 수 있습니다.');
        return null;
      }
      if (waitLineStarted) io.finishLine?.();
      io.print('Codex 로그인 완료');
      return 'openai-codex';
    } catch {
      if (waitLineStarted) io.finishLine?.();
      io.print('Codex 로그인을 완료하지 못했습니다. 나중에 elanous login openai-codex로 다시 시도할 수 있습니다.');
      return null;
    } finally {
      if (timer !== undefined) clearInterval(timer);
      cancelLogin?.();
      if (cancelled) void login.catch(() => {});
    }
  }
  // Keep the exact environment object through storage and rediscovery: storeServiceKeys
  // writes accepted values into it as well as the protected cache, so a newly entered
  // key is immediately visible to detectProviders and resolveProviderCredential.
  const env = options.env ?? process.env;
  await runSetupKeys(io, { ...options, env });
  // runSetupKeys handles an absent askSecret capability per item (skip + safe guidance);
  // it does not throw or turn the first-run entry into a crash.
  const providers = (await detectProviders({ env }))
    .filter(provider => provider.available && provider.auth === 'apikey');
  const available = [...new Set(providers.map(provider => provider.provider as LLMProviderName))];
  if (!available.length) return null;
  io.print(`기본 공급자 선택: ${available.map((provider, index) => `${index + 1} ${provider}`).join(' · ')}`);
  const answer = (await io.ask('기본 공급자 번호 (Enter=건너뜀): ')).trim();
  return available[Number(answer) - 1] ?? null;
}
