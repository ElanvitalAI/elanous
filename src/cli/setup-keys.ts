import { SERVICE_KEY_CATALOG } from '../setup/llm-env-detect.js';
import { serviceKeyStatus, storeServiceKeys, verifyServiceKey, type ParsedServiceKeyEnv } from '../setup/service-keys.js';
import { detectProviders } from '../llm/provider-detect.js';
import { loginWithCodex } from '../oauth/codex.js';
import type { FirstRunProviderSetupResult } from '../onboarding/first-run.js';
import { MODEL_ROLES, resolveRoleLlm, type LLMProviderName, type UserConfig } from '../user-config.js';
import { parseMenuAnswer } from '../onboarding/menu-answer.js';

export interface SetupKeysIO {
  ask(prompt: string): Promise<string>;
  askSecret?(prompt: string): Promise<string>;
  print(message: string): void;
}

export interface SetupKeysOptions {
  config: UserConfig;
  env?: NodeJS.ProcessEnv;
  cacheDir?: string;
  includeOptional?: boolean;
  /** Existing OAuth fetch injection used by deterministic login simulation. */
  loginWithCodex?: typeof loginWithCodex;
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

export function renderServiceKeyStatus(options: { env?: NodeJS.ProcessEnv; cacheDir?: string } = {}): string[] {
  const status = serviceKeyStatus(options);
  return SERVICE_KEY_CATALOG.map(item => {
    const row = status.find(candidate => candidate.id === item.id);
    if (!row) return `${item.label}: 상태 확인 불가`;
    if (item.kind === 'api-key') return `${item.label}: ${row.configured ? '키 있음' : '키 필요'} (${item.envNames.join(', ')})`;
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
    const verification = await verifyServiceKey(item.id, value, {
      env,
      cacheDir: options.cacheDir,
      baseUrl: providerBaseUrl(options.config, item.id),
    });
    if (verification.result === 'verified') accepted.set(name, value);
    else if (verification.result === 'unsupported') {
      accepted.set(name, value);
      unverified.push(name);
      io.print(`${item.label}: 최소 확인을 지원하지 않아 검증 없이 저장합니다 · 값 출력 0`);
    }
    else {
      rejected.push(name);
      io.print(`${item.label}: 검증 ${verification.result}${verification.httpStatus ? ` (HTTP ${verification.httpStatus})` : ''} · 저장 안 함`);
    }
  }
  const saved = accepted.size ? storeServiceKeys(accepted, { env, cacheDir: options.cacheDir }) : { stored: [] };
  if (saved.stored.length) io.print(`저장 완료: ${saved.stored.join(', ')} · 값 출력 0`);
  return { stored: saved.stored, rejected: rejected.sort(), unverified: unverified.sort() };
}

export async function runSetupKeys(io: SetupKeysIO, options: SetupKeysOptions): Promise<{ stored: string[]; skipped: string[] }> {
  const providers = await detectProviders({ env: options.env });
  for (const line of renderProviderProposal(options.config, providers)) io.print(line);
  const { listCodexAccountsInStore } = await import('../oauth/codex-account-store.js');
  const codexAccounts = listCodexAccountsInStore().map(account => account.name);
  io.print(`Codex 계정: ${codexAccounts.length ? codexAccounts.join(', ') : '없음'} · 추가: 별도 CODEX_HOME에서 codex login 후 elanous provider codex account import <이름> --home <홈>`);
  const statuses = serviceKeyStatus({ env: options.env, cacheDir: options.cacheDir });
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
  for (const line of renderServiceKeyStatus({ env: options.env, cacheDir: options.cacheDir })) io.print(line);
  return { stored, skipped };
}

export const FIRST_RUN_PROVIDER_SETUP_MENU_HEADING = '처음 실행 LLM 설정';
export const FIRST_RUN_PROVIDER_SETUP_MENU_CHOICES = '1 Codex 구독 로그인 · 2 API 키 입력 · Enter 건너뛰기';
export const FIRST_RUN_PROVIDER_SETUP_MENU_MAX_MISSES = 3;

/** First-run entry: offer the existing Codex device login or the same verified-key flow as `setup keys`. */
export async function runFirstRunProviderSetup(io: SetupKeysIO, options: SetupKeysOptions): Promise<FirstRunProviderSetupResult> {
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
    try {
      await (options.loginWithCodex ?? loginWithCodex)({ onProgress: (event) => {
        if (event.type === 'user_code') io.print(`Codex 로그인: ${event.loginUrl} · 코드 ${event.userCode}`);
        else if (event.type === 'polling') io.print('Codex 로그인을 기다리는 중…');
        else if (event.type === 'exchanging') io.print('Codex 로그인을 확인하는 중…');
      } });
      io.print('Codex 로그인 완료');
      return 'openai-codex';
    } catch {
      io.print('Codex 로그인을 완료하지 못했습니다. 다시 시도하거나 Enter로 건너뛰세요.');
      return null;
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
