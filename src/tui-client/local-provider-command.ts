import { loadCatalog } from '../intelligence-map/model-catalog.js';
import { getUserConfig, PROVIDER_DEFAULT_MODEL, reloadUserConfig } from '../user-config.js';

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

async function setProviderViaCli(provider: string, model: string | undefined, signal: AbortSignal): Promise<void> {
  const cli = process.argv[1];
  if (!cli) throw new Error('elanous CLI entry is unavailable');
  const child = Bun.spawn({
    cmd: [process.execPath, cli, 'provider:set', provider, ...(model ? ['--model', model] : [])],
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env,
  });
  const abort = (): void => { child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (signal.aborted) throw new Error('provider switch cancelled');
    if (code !== 0) throw new Error(stderr.trim().split('\n').at(-1) || stdout.trim().split('\n').at(-1) || `provider:set exit ${code}`);
    reloadUserConfig();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function runLocalProviderCommand(
  raw: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  if (signal.aborted) throw new Error('provider lookup cancelled');
  const [action, providerArg, modelArg] = raw.trim() ? raw.trim().split(/\s+/) : ['list'];
  const cfg = getUserConfig().llm;
  const current = cfg.provider;
  if (action === 'list') {
    onLine(`현재: ${current}/${cfg.model || PROVIDER_DEFAULT_MODEL[current] || '기본 모델'}`);
    for (const [name, model] of Object.entries(PROVIDER_DEFAULT_MODEL)) {
      if (name === 'auto') continue;
      onLine(`${name === current ? '●' : '○'} ${name} · ${model || '기본 모델'}`);
    }
    onLine('모델: /provider models [provider] · /provider refresh [provider]');
    onLine('전환: /provider use <provider> [model]');
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
      throw new Error('사용법: /provider use <provider> [model]');
    }
    await setProviderViaCli(providerArg, modelArg, signal);
    const next = getUserConfig().llm;
    onLine(`다음 턴 provider: ${next.provider}/${next.model || '기본 모델'}`);
    return;
  }
  throw new Error('사용법: /provider · /provider models [provider] · /provider use <provider> [model]');
}
