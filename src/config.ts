import { existsSync, realpathSync } from 'fs';
import { effectiveInstanceRoot, normRoot } from './instance/resolve.js';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { lookupLlmTierSpec } from './model-tier/llm-tier-map.js';
import { listSshHosts } from './ssh/ssh-hosts.js';
import { isInstalledPackagePath } from './instance/installed-package.js';

// ── User config ──
export const REMOTE_HOME = homedir();
export const LOCAL_SKILLS_DIR = join(REMOTE_HOME, '.claude/skills');
export const LOCAL_AGENTS_DIR = join(REMOTE_HOME, '.claude/agents');
/**
 * 가변 상태(`plugin-trust.json` · `market-posture.json` · `execution-history.json` · `sync.db` …)의 폴더.
 * 🩸 2026-09-24: 종전엔 늘 «코드 옆» `<코드>/data` 였다. 운영이 설치본(`~/.local/share/elanous/versions/<판>`)으로 옮기자
 *    판마다 빈 `data/` 가 새로 생기고 야간 정리가 옛 판을 지우며 같이 지워졌다(플러그인 신뢰 승인·시장 자세 last-good).
 *    ⇒ 설치본 또는 운영 우주는 `~/.elanous/data`, 격리 소스 트리는 자기 `data/`를 쓴다.
 *    `ELANOUS_DATA_DIR` 가 있으면 그것이 이긴다.
 */
export function resolveDataDir(
  codeRoot: string = resolve(import.meta.dir, '..'),
  deps: { env?: NodeJS.ProcessEnv; home?: string; instanceRoot?: () => string; hasGit?: (dir: string) => boolean } = {},
): string {
  const env = deps.env ?? process.env;
  const override = env.ELANOUS_DATA_DIR?.trim();
  if (override) return override;
  const home = deps.home ?? homedir();
  const stateData = join(home, '.elanous', 'data');
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const root = real(codeRoot);
  const hasGit = deps.hasGit ?? ((dir: string) => {
    for (let d = dir, i = 0; i < 30; i++) {
      if (existsSync(join(d, '.git'))) return true;
      const parent = resolve(d, '..');
      if (parent === d) return false;
      d = parent;
    }
    return false;
  });
  if (isInstalledPackagePath(root) && !hasGit(root)) return stateData;   // 설치본(설치기 · npm)
  if (normRoot((deps.instanceRoot ?? effectiveInstanceRoot)()) === normRoot(join(home, '.elanous'))) return stateData;
  return join(codeRoot, 'data');
}

// Module consumers of DATA_DIR/DB_PATH use the same resolved universe as the CLI.
export const DATA_DIR = resolveDataDir();
export const DB_PATH = join(DATA_DIR, 'sync.db');

// ── Obsidian vault ──
// Root directory of the user's Obsidian vault. The working-dir V1
// layout pairs a Working browser and an Obsidian browser side by side
// so results saved to Obsidian are one pane-focus away.
export const OBSIDIAN_VAULT =
  process.env.OBSIDIAN_VAULT || join(REMOTE_HOME, 'Obsidian', 'ElanvitalAI');

// ── Servers (SSH host aliases) ──
// `local` is a first-class target for syncing between local agent runtimes
// without requiring SSH back into the same machine.
export const LOCAL_SYNC_SERVER = 'local';
/** Sync targets = `local` ⊕ the ssh fleet from ~/.elanous/ssh-hosts.json.
 *  (2026-09-25: was a hard-coded list of one person's machines.) */
export function syncServers(): string[] {
  return [LOCAL_SYNC_SERVER, ...listSshHosts().map((h) => h.name)];
}

export function isLocalSyncServer(server: string): boolean {
  const normalized = server.trim().toLowerCase();
  return normalized === LOCAL_SYNC_SERVER
    || normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

// ── Services & their remote paths ──
export const SERVICES: Record<string, string> = {
  hermes:   `${REMOTE_HOME}/.hermes/skills/`,
  openclaw: `${REMOTE_HOME}/.openclaw/workspace/skills/`,
  opencode: `${REMOTE_HOME}/.config/opencode/skills/`,
  codex:    `${REMOTE_HOME}/.codex/skills/`,
};

export const SERVICE_NAMES = Object.keys(SERVICES);

// ── Rsync excludes ──
export const RSYNC_EXCLUDES = [
  'node_modules/',
  '.pnpm-store/',
  '.yarn/cache/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.env/',
  'site-packages/',
  '*.pyc',
  '*.pyo',
  '*.pyd',
  '*.egg-info/',
  '*.dist-info/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  'skillpad.sh',
  'sync-to-*.sh',
  'elanous/',  // exclude this project itself
];

// ── Env-sensitive file patterns ──
export const ENV_FILE_PATTERNS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '*.config.json',
  '*.config.ts',
  '*.config.js',
];

// ── 키의 SSOT 는 «파일», env 는 «캐시» (대표 2026-08-06) ──────────────────────
//
// ⛔⭐⭐ **왜 env 를 최종 답으로 읽지 않나** (2026-08-06 실측):
//   장수 프로세스(nexus 데몬·launchd·오래 뜬 세션)는 **기동 시점의 env** 를 들고 산다.
//   `~/.config/api-key-setup/api-keys.zsh` 는 이미 «캐시 우선»으로 고쳐져 있지만 그것은
//   **새 셸에만** 먹고, ***이미 뜬 프로세스엔 영영 안 닿는다.***
//   ⇒ 실측: 8/4 에 뜬 프로세스가 **소진된 팀**의 XAI 키를 들고 403 을 받았고
//     캐시 파일의 키는 **200** 이었다. 같은 사건이 그 4일 전에도 났다(그 zsh 파일 주석).
//   ⇒ 그래서 캐시 파일이 있으면 **그것을 먼저** 읽는다. env 는 폴백으로 내린다.
//
// ⛔ 셸 파일과 **같은 규약**을 쓴다(둘이 갈리면 어느 쪽이 이겼는지 아무도 모른다):
//   ⓐ 캐시가 없거나 **비어 있으면** env 를 쓴다(살아 있는 키를 지우지 않는다)
//   ⓑ `ELANOUS_KEEP_ENV_KEYS=1` 이면 캐시를 무시한다(임시로 다른 키를 쓰는 탈출구)
//
// ⚠️ 캐시는 **매 호출 읽지 않는다** — 프로세스 수명 동안 1회만 읽고 기억한다(파일 I/O 억제).
//    ⇒ 회전 직후 살아 있는 프로세스를 즉시 고치려면 `resetKeyCacheForTests()` 가 아니라
//      **호출부의 401/403 경로**가 `refreshKeyFromCache()` 를 부른다(2안).
const keyCache = new Map<string, string | null>();

/** 캐시 파일 1개를 읽는다. 파일명 규약 = 환경변수명 **소문자**(`XAI_API_KEY` → `xai_api_key`). */
function readKeyCacheFile(envName: string): string | null {
  if (process.env.ELANOUS_KEEP_ENV_KEYS) return null;
  try {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { homedir } = require('node:os') as typeof import('node:os');
    const { resolve } = require('node:path') as typeof import('node:path');
    // ⭐ 테스트 seam — `ELANOUS_KEY_CACHE_DIR` 로 캐시 디렉토리를 바꿀 수 있다.
    //   ⛔ `HOME` 을 흔드는 방식은 **안 통한다**(2026-08-06 실측: `os.homedir()` 가 바뀐 `HOME` 을
    //     안 따라와 회귀가 조용히 통과할 뻔했다) — 그래서 경로를 «명시 입력»으로 뺀다.
    const dir = process.env.ELANOUS_KEY_CACHE_DIR?.trim() || resolve(homedir(), '.cache');
    const v = readFileSync(resolve(dir, envName.toLowerCase()), 'utf-8')
      .trim().replace(/^["']|["']$/g, '');
    return v || null;
  } catch { return null; }
}

/** ⭐ 테스트 seam — 프로세스당 1회 메모이즈되는 키 캐시를 비운다.
 *
 *  ⛔⭐ 왜 필요한가: 「이 기계엔 자격증명이 «없다»」를 세우려는 시험이 ***env 만 지우면 «안 된다»***.
 *  `keyFromCacheOrEnv` 는 ***캐시 파일을 «먼저»*** 보고, 그 결과를 프로세스 내내 기억한다.
 *  ⇒ `ELANOUS_KEY_CACHE_DIR` 을 나중에 바꿔도 ***이미 기억한 값이 이긴다***.
 *
 *  📏 2026-08-25 실측(`D2`): `test/web-search.test.ts` 가 env 넷을 지우고도 빨갰다 —
 *  「맨 상자」 전제는 ***의도였고 선언도 돼 있었는데***, 지운 문이 넷이고 해석기가 보는 문이 더 많았다.
 *  📄 근거 = 내부 문서 `FINDING-the-bare-box-was-intended-but-the-isolation-named-four-doors-2026-08-25` */
export function _resetKeyCacheForTests(): void { keyCache.clear(); }

/** 캐시 우선 조회(프로세스당 1회 읽고 기억). ⛔ 캐시가 없으면 `undefined` 가 아니라 env 로 내려간다. */
export function keyFromCacheOrEnv(envName: string, ...envFallbacks: string[]): string | undefined {
  if (!keyCache.has(envName)) keyCache.set(envName, readKeyCacheFile(envName));
  const cached = keyCache.get(envName);
  if (cached) return cached;
  for (const name of [envName, ...envFallbacks]) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

/** 2안 — 인증 거절을 만난 호출부가 부른다. 캐시를 **다시** 읽어 값이 바뀌었으면 true.
 *  ⛔ true 를 돌려줬을 때만 재시도할 것(값이 같으면 재시도해도 같은 답이다). */
export function refreshKeyFromCache(envName: string): boolean {
  const before = keyCache.get(envName) ?? process.env[envName];
  const fresh = readKeyCacheFile(envName);
  keyCache.set(envName, fresh);
  return fresh !== null && fresh !== before;
}

/**
 * 🆕 2026-09-24 (설치본 전환 RFC 0b) — 상주 프로세스(nexus · openai-relay)가 부팅 때 키 캐시로 env 를 채운다.
 * 계기: launchd plist 에 평문 키가 있었고, 그중 하나는 캐시와 «달랐다». 코드 26곳이 `process.env.X` 를 직접 읽어
 * (음성 STT/TTS 등) plist 에서 키만 빼면 조용히 죽는다 ⇒ 부팅 한 곳에서 캐시를 env 에 싣는다(규약 = 캐시 우선 · ⓐⓑ 동일).
 * 자식 프로세스도 이 env 를 물려받는다. 반환 = 캐시로 채운 이름(값은 절대 안 싣는다).
 */
export const DAEMON_KEY_ENV_NAMES = [
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
  'ELANOUS_OPENAI_RELAY_SHARED_SECRET',
] as const;

export function hydrateEnvFromKeyCache(names: readonly string[] = DAEMON_KEY_ENV_NAMES, env: NodeJS.ProcessEnv = process.env): string[] {
  const filled: string[] = [];
  for (const name of names) {
    const cached = readKeyCacheFile(name);
    if (!cached) continue;   // ⓐ 캐시가 없거나 비면 env 를 그대로 둔다
    keyCache.set(name, cached);
    if (env[name] !== cached) { env[name] = cached; filled.push(name); }
  }
  return filled;
}

// ── Grok API config ──
export function getGrokApiKey(): string | undefined {
  return keyFromCacheOrEnv('XAI_API_KEY', 'GROK_API_KEY');
}

// 2026-09-22 정비: flagship grok-4.7 (docs.x.ai 1차 · 500k ctx · <200k $2/$6 · 컷오프 2026-05).
//   ⚠️ ≥200k 구간은 $4/$12 로 «두 배»다 — 긴 창을 쓰면 비용이 이 주석의 수와 다르다.
//   📏 grok CLI 의 기본 모델과도 «같다»(`grok models` 실측 2026-09-22).
// ⚠️ 구독 프록시로 나갈 땐 이 id 가 `grok-4.6-build` 로 매핑돼 돌아온다(실측).
export const GROK_MODEL = process.env.GROK_MODEL || 'grok-4.7';
export const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

/** Shared secret enabling the OpenAI-compatible Grok subscription relay. */
export function getOpenAiRelaySharedSecret(): string | undefined {
  return keyFromCacheOrEnv('ELANOUS_OPENAI_RELAY_SHARED_SECRET')?.trim() || undefined;
}

// ── Multi-LLM provider config ──
export function getOpenAIApiKey(): string | undefined {
  return keyFromCacheOrEnv('OPENAI_API_KEY');
}
export function getAnthropicApiKey(): string | undefined {
  return keyFromCacheOrEnv('ANTHROPIC_API_KEY');
}
// 대표 2026-09-23 — OpenRouter (OpenAI 호환 게이트웨이 · kimi·qwen·glm 의 첫 경로).
//   키 = `~/.cache/openrouter_api_key`(규약) → env. `scripts/add-api-key.sh OPENROUTER_API_KEY` 가 둘 다 세운다.
export function getOpenRouterApiKey(): string | undefined {
  return keyFromCacheOrEnv('OPENROUTER_API_KEY');
}
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// 기본 = 사다리 `balanced`(`llm-tier-map.ts` OPENROUTER). 카탈로그 id 는 `openrouter/<vendor>/<model>`,
//   wire 로는 `openrouter/` 를 떼고 보낸다(`makeOpenRouterProvider`).
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openrouter/z-ai/glm-5.3';
export function getLocalLLMUrl(): string | undefined {
  return process.env.LOCAL_LLM_URL; // e.g. http://localhost:11434/v1 (ollama)
}

// ⭐ 2026-09-25 (대표 「모델별 최신으로」): API 키 경로 기본도 사다리 `balanced`(GPT-6 Sol)에서 파생 — 종전 gpt-4o-mini 는 두 세대 낡았다.
export const OPENAI_MODEL = process.env.OPENAI_MODEL || lookupLlmTierSpec('openai', 'balanced').model;
// ⭐ 2026-09-25 (대표 B7) — 기본은 사다리 `best`(최신 Opus · 현재 claude-opus-5-5)에서 «파생»한다. 이름을 박지 않는다.
//   대표: 「밸런스가 코딩 구현에도 쓰인다면 opus 5.5 로」 — 이 값은 `defaultModelForProvider('anthropic')` 를 거쳐
//   `ELANOUS_LLM_PROVIDER=anthropic` 만 준 런의 «주 모델» = 구현 자식 goal-loop 의 모델이 된다(역할 `implement` 는 배선 전 · BACKLOG B14).
//   종전 `claude-haiku-4-5-20251001` 은 첫 멀티 provider 커밋(04-14)의 옛 상수였다. haiku·sonnet 이 필요하면 `ANTHROPIC_MODEL` env.
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || lookupLlmTierSpec('anthropic', 'best').model;
export const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || 'llama3';

export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ── Google Gemini (OpenAI-compatible endpoint) ──
export function getGeminiApiKey(): string | undefined {
  return keyFromCacheOrEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY');
}
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// ── Chinese chat-model families · all OpenAI-compatible ──────────────
// Each provider exposes a `/v1/chat/completions` endpoint identical in
// shape to OpenAI. Picking one means setting the API key, model id,
// and base URL — no per-provider request shape divergence at this
// layer. Local open-weight pulls are handled by `LOCAL_LLM_*` and the
// quad-probe local-llm manager, not by these constants.

// Kimi (Moonshot) · platform.moonshot.cn
export function getKimiApiKey(): string | undefined {
  return process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
}
export const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-latest';
export const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions';

// Qwen (Alibaba DashScope) · international Singapore endpoint by default.
// Use `DASHSCOPE_API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
// for the China region, or `https://coding-intl.dashscope.aliyuncs.com/v1`
// for the coding subscription variant.
export function getDashScopeApiKey(): string | undefined {
  return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
}
export const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3.6-flash';
export const DASHSCOPE_API_URL = process.env.DASHSCOPE_API_BASE_URL
  ? `${process.env.DASHSCOPE_API_BASE_URL.replace(/\/$/, '')}/chat/completions`
  : 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

// GLM (Zhipu) · Z.ai / BigModel platform.
export function getZhipuApiKey(): string | undefined {
  return process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || process.env.BIGMODEL_API_KEY;
}
export const GLM_MODEL = process.env.GLM_MODEL || 'glm-4.7-flash';
export const GLM_API_URL = process.env.GLM_API_BASE_URL
  ? `${process.env.GLM_API_BASE_URL.replace(/\/$/, '')}/chat/completions`
  : 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
/** Gemini native (non-OpenAI-compat) base URL — used by the
 *  context-cache REST client. The `chat/completions` endpoint doesn't
 *  expose cachedContents; the native v1beta root does. */
export const GEMINI_NATIVE_API_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ── Prompt-cache defaults ──
/** Normalize the ELANOUS_PROMPT_CACHE_TTL env var into a valid TTL
 *  literal. Unknown / missing values fall back to '5m' (ephemeral).
 *  Exposed as a function so tests can re-query after monkey-patching
 *  process.env. */
export function getDefaultCacheTTL(): '5m' | '1h' {
  const raw = (process.env.ELANOUS_PROMPT_CACHE_TTL || '').trim().toLowerCase();
  if (raw === '1h' || raw === '1hour' || raw === '3600') return '1h';
  return '5m';
}

/** Default provider preference order (first available wins). */
export const DEFAULT_PROVIDER = process.env.DEFAULT_LLM_PROVIDER || 'auto';
