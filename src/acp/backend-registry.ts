// ACP backend registry — each entry describes how to spawn an ACP-
// speaking subprocess. Mirrors zed's `crates/agent_servers/src/custom.rs:17-20`
// approach: a small constant list of agent IDs, each mapped to a
// command + args. Adding a new backend is one entry here plus an npm
// install — no per-backend code path required.
//
// The packages we depend on wrap the underlying CLI / SDK and expose
// ACP over stdio so we can stay on the client side.

import { isGrokAvailable } from './grok-auth-probe.js';

export interface AcpBackendSpec {
  /** Stable identifier used across config + chat commands.
   *  Sticky to one chat once chosen via `/agent <id>`. */
  id: string;
  /** Human-friendly label for menus + help text. */
  label: string;
  /** Executable to spawn — the npm bin name or absolute path. */
  command: string;
  /** Extra args (the bin usually needs none for ACP mode). */
  args: string[];
  /** npm package providing the binary. `elanous acp init` uses this
   *  to auto-install on first use. */
  npmPackage: string;
  /** Pinned version range — kept in lockstep with our SDK pin so a
   *  protocol-version mismatch never silently lands. */
  npmVersion: string;
  /** How elanous drives this backend.
   *  - 'acp' (default): spawn `command args` and speak ACP JSON-RPC
   *    over stdio via `AcpAgent`.
   *  - 'codex-app-server': direct JSON-RPC v2 to a persistent `codex
   *    app-server` subprocess via `CodexAppServerAgent`. `command`/
   *    `args` are unused for this transport. */
  transport?: 'acp' | 'codex-app-server';
  /** Env-var gate. When set, this backend is only selectable if the
   *  named env var is truthy. Absent = always available. */
  requiresEnv?: string;
  /** Optional probe — when present, `listAcpBackends()` filters by this
   *  in addition to `requiresEnv`. Returns true when the backend is
   *  reachable (binary installed + auth configured). Used by backends
   *  whose availability isn't expressible as a single env var
   *  (e.g. grok: `XAI_API_KEY` OR `~/.grok/auth.json` written by
   *  `grok login`). Sync because listAcpBackends() is sync — use
   *  `existsSync` / env lookups, not network calls. */
  probeAvailable?: (env: NodeJS.ProcessEnv) => boolean;
  /** Extra absolute paths to probe before falling back to PATH search.
   *  Used by backends that install outside `node_modules/.bin/`
   *  (e.g. grok: xAI install.sh writes to `~/.grok/bin/grok`). Tilde
   *  (`~`) is expanded to `os.homedir()` at resolve time. */
  extraBinCandidates?: string[];
  /** Present when upstream has retired this backend's supported path.
   *  Its text is shown in the registry listing and returned by the
   *  lookup gate before a child can be spawned. */
  unsupportedReason?: string;
}

export const ACP_BACKENDS: Record<string, AcpBackendSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code (Anthropic)',
    command: 'claude-agent-acp',
    args: [],
    npmPackage: '@agentclientprotocol/claude-agent-acp',
    // This adapter pins @agentclientprotocol/sdk@1.5.0; match our SDK pin.
    npmVersion: '0.81.2',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    // Gemini's CLI serves dual-purpose (interactive chat + ACP
    // agent) — the --experimental-acp flag toggles ACP mode on
    // stdio, matching zed's invocation (agent_servers/src/acp.rs
    // strips the flag during auth terminal spawns).
    command: 'gemini',
    args: ['--experimental-acp'],
    npmPackage: '@google/gemini-cli',
    npmVersion: '0.38.0',
    // ⛔⭐ 2026-08-19 라이브 «확증» — 이 문면은 더 이상 「관측」이 아니라 «재현되는 사실»이다.
    //   `gemini -p "…"` ⇒ IneligibleTierError · ineligibleTiers=[{ reasonCode:'UNSUPPORTED_CLIENT',
    //     tierId:'free-tier', tierName:'Gemini Code Assist for individuals' }]
    //   ⚠️ 그런데 «인증만» 보면 산다 — cloudcode-pa.googleapis.com:loadCodeAssist 가 HTTP 200.
    //     ⇒ 200 을 보고 「된다」고 읽지 마라. 「인증이 산다」와 「쓸 수 있다」는 다른 값이다.
    //   ⛔ 그리고 Antigravity CLI(`agy`)는 ACP 를 «안 낸다»(바이너리 문자열 0건) — 그래서 이 자리를
    //     agy 로 «바꿀 수도 없다». PTY backend 쪽만 agy 로 옮겼다(agent-mission/driver.ts).
    //   🔵 재개 조건: zed ACP 레지스트리에 Antigravity 가 등재되면 이 항목을 다시 연다.
    //   📄 내부 문서 `RFC-gemini-to-antigravity-cli-migration-2026-08-18` §2b·§4e-0
    unsupportedReason:
      'Confirmed live 2026-08-19 (first observed 2026-08-12): gemini-cli is rejected with '
      + 'IneligibleTierError (free-tier UNSUPPORTED_CLIENT). Antigravity CLI (agy) replaces it but does '
      + 'NOT speak ACP, so this ACP entry has no successor yet — use the PTY backend (--backend gemini) instead.',
  },
  'codex-app-server': {
    id: 'codex-app-server',
    label: 'OpenAI Codex (app-server RPC)',
    // Binary resolved via PATH inside CodexAppServerClient.spawn
    // factory · `codex app-server` subcommand. These fields are
    // unused for transport='codex-app-server' but kept for shape
    // parity.
    command: 'codex',
    args: ['app-server'],
    npmPackage: 'codex',
    npmVersion: '*',
    transport: 'codex-app-server',
    // Canonical codex path. Approval adapter + MCP bridge wired
    // (sprint 1-4) · plan mode · file ops · elanous/ui parity ·
    // streaming backpressure · daemon idle hibernate · MCP policy
    // persistence. Sprint 5A (D1) made `/acp codex` resolve here;
    // sprint 5B (D2) removed the legacy `codex` (Zed shim) and
    // `codex-native` entries.
  },
  grok: {
    id: 'grok',
    label: 'xAI Grok (Build CLI · ACP)',
    // xAI 의 공식 Grok Build CLI · `grok agent stdio` subcommand 가
    // 표준 ACP transport. claude/gemini 와 동일 path — 단 npm 이 아닌
    // xAI install.sh 로 install (`curl -fsSL https://x.ai/cli/install.sh
    // | bash` → `~/.grok/bin/grok` · PATH 통해 resolve).
    command: 'grok',
    args: ['agent', 'stdio'],
    // sentinel — xAI install.sh 사용 · npm install 시도 X. `elanous acp
    // init` (future · plan G2) 의 install 안내가 별도 처리한다.
    npmPackage: '',
    npmVersion: '0.1.210+',
    // Standard ACP transport (claude/gemini 와 동일) — codex-app-server
    // 같은 custom transport 아니다.
    transport: 'acp',
    // grok 의 auth 는 두 source 중 하나 충족: (1) `XAI_API_KEY` /
    // `GROK_CODE_XAI_API_KEY` env, (2) `~/.grok/auth.json` (browser
    // OAuth via `grok login`). 단일 `requiresEnv` 로 표현 못하므로
    // probeAvailable 로 위임 — grok-auth-probe.ts 의 `isGrokAvailable`
    // 가 둘 다 detect.
    probeAvailable: isGrokAvailable,
    // xAI install.sh 의 표준 install path. install.sh 가 보통 PATH
    // 도 추가하지만 사용자 shell rc 가 안 reload 됐을 경우의 fallback.
    extraBinCandidates: ['~/.grok/bin/grok'],
  },
};

/** Look up a backend by id. Throws when unknown so the caller
 *  surfaces a clear error to the user instead of a silent bad spawn.
 *
 *  H4 phase 1 — if the spec has `requiresEnv`, we also throw when
 *  that env var is unset / falsy so the user gets a clear "this
 *  backend needs ELANOUS_X=1" message rather than a cryptic spawn
 *  failure deeper in the stack. Tests / advanced callers can pass
 *  `{ skipEnvGate: true }` to ignore the gate. */
/** Friendly aliases → canonical backend id. `codex-app-server` is the
 *  internal canonical name (it doubles as the transport type, and is what
 *  persisted acp-sessions / codex threadIndex are keyed by), but users +
 *  the `/cdx` slash + several call sites say the short `codex` (and `cx` /
 *  `cas`). Normalizing here — the single lookup choke point — lets every
 *  consumer speak the friendly name without a codebase-wide rename. */
/** Public compatibility vocabulary for every ACP entry surface.  Keep aliases
 * here rather than re-declaring them in dashboard/channel parsers: a stale
 * parser must reject an alias, never create a second session namespace. */
export const ACP_BACKEND_ALIASES: Readonly<Record<string, string>> = {
  cc: 'claude',
  codex: 'codex-app-server',
  cx: 'codex-app-server',
  cas: 'codex-app-server',
  gm: 'gemini',
};

/** Resolve a friendly alias to the canonical backend id (id-through when
 *  already canonical / unknown). Use at any boundary that keys by backend
 *  (agent cache, session store) so an alias and its canonical don't split
 *  into two agents / two sessions. */
export function canonicalizeBackendId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return ACP_BACKEND_ALIASES[normalized] ?? normalized;
}

export function getAcpBackend(
  id: string,
  opts: { skipEnvGate?: boolean; env?: NodeJS.ProcessEnv } = {},
): AcpBackendSpec {
  const spec = ACP_BACKENDS[canonicalizeBackendId(id)];
  if (!spec) {
    const known = listAcpBackends().map((b) => b.id).join(', ');
    throw new Error(`Unknown ACP backend "${id}". Known: ${known}`);
  }
  if (spec.unsupportedReason) {
    throw new Error(`ACP backend "${id}" is unsupported. ${spec.unsupportedReason}`);
  }
  if (!opts.skipEnvGate && spec.requiresEnv) {
    const env = opts.env ?? process.env;
    const val = env[spec.requiresEnv];
    if (!isTruthyEnv(val)) {
      throw new Error(
        `ACP backend "${id}" requires env ${spec.requiresEnv}=1. Set it and restart elanous to enable.`,
      );
    }
  }
  return spec;
}

/** List backends that are available in the current environment. By
 *  default, gated backends (with `requiresEnv`) are filtered out when
 *  the env var isn't set — so LLM tool descriptions don't advertise a
 *  backend the user can't actually use. Pass `includeGated: true` to
 *  see all entries regardless. */
export function listAcpBackends(
  opts: { includeGated?: boolean; env?: NodeJS.ProcessEnv } = {},
): AcpBackendSpec[] {
  const env = opts.env ?? process.env;
  const all = Object.values(ACP_BACKENDS);
  if (opts.includeGated) return all;
  return all.filter((spec) => {
    if (spec.requiresEnv && !isTruthyEnv(env[spec.requiresEnv])) return false;
    if (spec.probeAvailable && !spec.probeAvailable(env)) return false;
    return true;
  });
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
