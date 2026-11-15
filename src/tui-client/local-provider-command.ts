import { loadCatalog } from '../intelligence-map/model-catalog.js';
import { getUserConfig, PROVIDER_DEFAULT_MODEL, reloadUserConfig } from '../user-config.js';
import { clearSessionProvider, configForSessionProviderTurn, getSessionProvider, parseSessionProvider, setSessionProvider, type SessionProviderSelection } from './session-provider.js';
import { backupConfigPath, userConfigPath } from '../user-config.js';
import { withFileLockSync } from '../storage/file-lock.js';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

type FetchModels = (url: string, init: RequestInit) => Promise<Response>;
type ModelList = { ids: string[]; source: 'remote' | 'cache' | 'local'; note?: string };

const MODEL_LOOKUP_TIMEOUT_MS = 2_000;
const MODEL_DISPLAY_LIMIT = 12;

/** The provider command is imported only when opened; this cache lives for one TUI process. */
export class ProviderModelCache {
  private local = new Map<string, string[]>();
  private lastGoodRemote = new Map<string, { apiKey: string | undefined; ids: string[] }>();

  localModels(provider: string): string[] {
    const cached = this.local.get(provider);
    if (cached) return cached;
    const ids = [...new Set(loadCatalog().catalog.models
      .filter((model) => model.provider === provider)
      .map((model) => model.id))].sort();
    this.local.set(provider, ids);
    return ids;
  }

  async models(
    provider: string,
    remoteUrl: string | undefined,
    apiKey: string | undefined,
    signal: AbortSignal,
    refresh = false,
    fetchModels: FetchModels = fetch,
    timeoutMs = MODEL_LOOKUP_TIMEOUT_MS,
  ): Promise<ModelList> {
    if (signal.aborted) throw new Error('provider lookup cancelled');
    const local = this.localModels(provider);
    if (!remoteUrl) return { ids: local, source: 'local' };
    const cacheKey = `${provider}\0${remoteUrl}`;
    const cached = this.lastGoodRemote.get(cacheKey);
    const previous = cached && cached.apiKey === apiKey ? cached.ids : undefined;
    if (previous && !refresh) return { ids: previous, source: 'cache' };
    try {
      const ids = await queryRemoteModels(remoteUrl, apiKey, signal, fetchModels, timeoutMs);
      this.lastGoodRemote.set(cacheKey, { apiKey, ids });
      return { ids, source: 'remote' };
    } catch (error) {
      if (signal.aborted) throw error;
      const note = error instanceof Error ? error.message : String(error);
      if (previous) return { ids: previous, source: 'cache', note };
      return { ids: local, source: 'local', note };
    }
  }
}

const cache = new ProviderModelCache();
const supportedProvider = (name: string): boolean => Object.prototype.hasOwnProperty.call(PROVIDER_DEFAULT_MODEL, name);

async function queryRemoteModels(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetchModels: FetchModels = fetch,
  timeoutMs = MODEL_LOOKUP_TIMEOUT_MS,
): Promise<string[]> {
  if (signal.aborted) throw new Error('provider lookup cancelled');
  const controller = new AbortController();
  let rejectCancelled: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  const cancel = (): void => {
    controller.abort();
    rejectCancelled?.(new Error('provider lookup cancelled'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) throw new Error('provider lookup cancelled');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('remote model lookup timed out'));
        controller.abort();
      }, timeoutMs);
    });
    const request = (async () => {
      const response = await fetchModels(url, {
        signal: controller.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!response.ok) throw new Error(`remote model lookup HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)
        || payload.data.some((entry: unknown) => !entry || typeof entry !== 'object'
          || !('id' in entry) || typeof entry.id !== 'string' || entry.id.trim().length === 0)) {
        throw new Error('remote model list is malformed');
      }
      const ids = [...new Set(payload.data.map((entry: { id: string }) => entry.id))].sort();
      if (ids.length === 0) throw new Error('remote model list is empty');
      return ids;
    })();
    return await Promise.race([request, deadline, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

function remoteModelsUrl(provider: string, baseUrl: string | undefined): string | undefined {
  if (baseUrl) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = new URL('models', base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid base URL');
    return url.toString();
  }
  return provider === 'openrouter' ? 'https://openrouter.ai/api/v1/models' : undefined;
}

function setGlobalProvider(provider: SessionProviderSelection['provider'], model: string | undefined, signal: AbortSignal): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withFileLockSync(`${path}.lock`, () => {
    if (signal.aborted) throw new Error('provider switch cancelled');
    // Only ENOENT is initial absence; failed reads and malformed JSON stop without publishing.
    let before: string | undefined;
    try { before = readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parsed: unknown = before === undefined ? {} : JSON.parse(before);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json 형식 오류');
    const next = parsed as Record<string, unknown>;
    const priorLlm = next.llm;
    if (priorLlm !== undefined && (!priorLlm || typeof priorLlm !== 'object' || Array.isArray(priorLlm))) {
      throw new Error('config.json llm 형식 오류');
    }
    const llm = { ...(priorLlm as Record<string, unknown> | undefined) };
    const changed = llm.provider !== provider;
    llm.provider = provider;
    llm.model = model ?? PROVIDER_DEFAULT_MODEL[provider];
    if (changed) {
      delete llm.apiKey;
      delete llm.baseUrl;
    }
    next.llm = llm;
    const backup = backupConfigPath(path);
    const suffix = `.provider-${process.pid}-${randomUUID()}.tmp`;
    const backupTmp = `${backup}${suffix}`;
    const nextTmp = `${path}${suffix}`;
    if (signal.aborted) throw new Error('provider switch cancelled');
    try {
      if (before !== undefined) writeFileSync(backupTmp, before, { mode: 0o600, flag: 'wx' });
      writeFileSync(nextTmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (signal.aborted) throw new Error('provider switch cancelled');
      // Publish only after both files are complete. The backup preserves the old origin's credential.
      if (before !== undefined) renameSync(backupTmp, backup);
      renameSync(nextTmp, path);
    } finally {
      rmSync(backupTmp, { force: true });
      rmSync(nextTmp, { force: true });
    }
  });
  reloadUserConfig();
}

export async function runLocalProviderCommand(
  raw: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
  sessionId?: string,
): Promise<void> {
  if (signal.aborted) throw new Error('provider lookup cancelled');
  const [action, providerArg, modelArg, ...flags] = raw.trim() ? raw.trim().split(/\s+/) : ['list'];
  const selected = sessionId ? getSessionProvider(sessionId) : undefined;
  const cfg = (await configForSessionProviderTurn(getUserConfig(), selected)).llm;
  const current = cfg.provider;
  if (action === 'list') {
    onLine(`현재: ${current}/${cfg.model || PROVIDER_DEFAULT_MODEL[current] || '기본 모델'}${selected ? ' (이 세션)' : ' (전역 기본)'}`);
    for (const [name, model] of Object.entries(PROVIDER_DEFAULT_MODEL)) {
      if (name === 'auto') continue;
      onLine(`${name === current ? '●' : '○'} ${name} · ${model || '기본 모델'}`);
    }
    onLine('모델: /provider models [provider] · /provider refresh [provider]');
    onLine('세션 전환: /provider use <provider> [model] · 전역 변경: --global --yes');
    return;
  }
  if (action === 'models' || action === 'refresh') {
    const provider = providerArg || current;
    if (!supportedProvider(provider)) throw new Error(`알 수 없는 provider: ${provider}`);
    let url: string | undefined;
    let urlError: string | undefined;
    try {
      url = provider === current ? remoteModelsUrl(provider, cfg.baseUrl) : remoteModelsUrl(provider, undefined);
    } catch {
      urlError = 'invalid base URL';
    }
    const result = await cache.models(provider, url, provider === current ? cfg.apiKey : undefined, signal, action === 'refresh');
    const note = urlError ?? result.note;
    onLine(`${provider} 모델 · ${result.source}${note ? ` (조회 실패: ${note})` : ''}`);
    for (const id of result.ids.slice(0, MODEL_DISPLAY_LIMIT)) onLine(`  ${id}`);
    if (result.ids.length > MODEL_DISPLAY_LIMIT) onLine(`  외 ${result.ids.length - MODEL_DISPLAY_LIMIT}개`);
    if (result.ids.length === 0) onLine('  목록 없음 · /provider use <provider> <model>로 직접 지정 가능');
    return;
  }
  if (action === 'use') {
    if (!providerArg || !supportedProvider(providerArg)) {
      throw new Error('사용법: /provider use <provider> [model] [--global --yes]');
    }
    const tokens = [modelArg, ...flags].filter((token): token is string => Boolean(token));
    const global = tokens.includes('--global');
    const confirmed = tokens.includes('--yes');
    const model = tokens.find((token) => !token.startsWith('--'));
    if (tokens.some((token) => token.startsWith('--') && token !== '--global' && token !== '--yes')
      || (model ? tokens.filter((token) => !token.startsWith('--')).length > 1 : false)
      || (confirmed && !global)) throw new Error('사용법: /provider use <provider> [model] [--global --yes]');
    if (global && !confirmed) throw new Error('전역 config 변경 확인: 같은 명령에 --global --yes를 붙여 주세요');
    const next = parseSessionProvider(providerArg, model);
    if (!global) {
      if (!sessionId) throw new Error('현재 대화를 찾을 수 없습니다');
      setSessionProvider(sessionId, next);
      onLine(`이 세션 다음 턴 provider: ${next.provider}/${next.model || PROVIDER_DEFAULT_MODEL[next.provider] || '기본 모델'}`);
      return;
    }
    setGlobalProvider(next.provider, next.model, signal);
    if (sessionId) clearSessionProvider(sessionId);
    const currentGlobal = getUserConfig().llm;
    onLine(`전역 기본 provider: ${currentGlobal.provider}/${currentGlobal.model || '기본 모델'}`);
    return;
  }
  throw new Error('사용법: /provider · /provider models [provider] · /provider use <provider> [model]');
}
