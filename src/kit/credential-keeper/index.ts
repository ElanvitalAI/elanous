// kit/credential-keeper — KEYS-PROACTIVE-REFRESH (0.3.39 P0 · 대표 11-28 12:3x «토큰 자동 갱신은 가정이 아니라 증명»).
// S: three codex homes run every seat; their refresh was assumed (the CLI refreshes only when it is used) — a home nobody used
//    for 10 days expires silently, and `eln usage` showed a reset-credit expiry that read like the token's.
// C: the guardian 열쇠지기 only carded a token that had ALREADY stopped (refresh > 7 d and expired) — after the outage.
// Q: how is «the token will not expire» proven every hour, not assumed — with no per-agent TS (plugin-first)?
// A: this kit (shared · values never leave it): credential-home metadata (JWT exp · last_refresh · refresh token present),
//    the due rule (policies come from the caller's agent.yaml), the CLI's own refresh (`codex app-server` account/read
//    refreshToken:true) VERIFIED by last_refresh on disk, the relogin HITL card, and the homes the llm-accounts pack declares.
//
// Measured 11-28 in a synthetic test universe (fake JWTs · a local fake OAuth server via the CLI's
// CODEX_REFRESH_TOKEN_URL_OVERRIDE · codex-cli 0.172.0):
//   `codex login status`                                  → 0 refresh calls · last_refresh unchanged (it only reads auth.json)
//   `codex app-server` ⊕ account/read {refreshToken:true} → the refresh-token grant ran · the CLI rewrote auth.json
//                                                           (last_refresh now · access exp +10 d) — even with last_refresh 1 d old
// stdin must stay open until the reply (EOF first = the server exits before it answers — measured). Success is NOT the RPC
// answer (account/read may fail after the refresh, e.g. a workspace lookup) but last_refresh moving forward on disk.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** Credential metadata (times only). */
export interface CredentialMeta { readonly connected: boolean; readonly expiresAt: number | null; readonly lastRefresh: string | null; readonly refreshable: boolean }
/** One credential as the keeper sees it — `home` = the CLI credential home (CODEX_HOME) when there is one. */
export interface KeptCredential { readonly provider: string; readonly expiresAt: number | null; readonly lastRefresh: string | null; readonly home?: string | null; readonly refreshable?: boolean }
export interface RefreshPolicy { readonly beforeH: number; readonly afterDays: number }

/** `<codexHome>/auth.json` → {connected · expiresAt (JWT exp ms) · lastRefresh · refreshable} — null when unreadable. The access
 *  JWT payload is decoded for its `exp` only; no token value is returned. */
export function codexAuthMeta(home: string, read: (p: string) => string = p => readFileSync(p, 'utf8')): CredentialMeta | null {
  try {
    const j = JSON.parse(read(`${home.replace(/\/+$/u, '')}/auth.json`)) as { last_refresh?: unknown; tokens?: { access_token?: unknown; refresh_token?: unknown } };
    const tok = typeof j.tokens?.access_token === 'string' ? j.tokens.access_token : null;
    let exp: number | null = null;
    if (tok) { try { const c = JSON.parse(Buffer.from(tok.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }; exp = typeof c.exp === 'number' ? c.exp * 1000 : null; } catch { exp = null; } }
    return { connected: !!tok, expiresAt: exp, lastRefresh: typeof j.last_refresh === 'string' ? j.last_refresh : null, refreshable: typeof j.tokens?.refresh_token === 'string' && j.tokens.refresh_token.length > 0 };
  } catch { return null; }
}

/** `oauth:<provider>` — a pack-declared home without an elanous row is `codex-home:<account>:<dir name>`. */
export const credentialId = (c: Pick<KeptCredential, 'provider'>): string => (c.provider.startsWith('codex-home:') ? c.provider : `oauth:${c.provider}`);


/** Pure: the credentials the 열쇠지기 must refresh now (a home with a refresh token, near expiry or long unrefreshed). */
export function refreshDue(c: KeptCredential, nowMs: number, p: RefreshPolicy): string | null {
  if (!c.home || c.refreshable === false) return null;
  const leftMs = c.expiresAt === null ? null : c.expiresAt - nowMs;
  if (leftMs !== null && leftMs < p.beforeH * 3_600_000) return `access ${leftMs <= 0 ? 'expired' : `${(leftMs / 3_600_000).toFixed(1)}h left`} < ${p.beforeH}h`;
  const refreshedMs = c.lastRefresh ? Date.parse(c.lastRefresh) : NaN;
  if (Number.isFinite(refreshedMs) && nowMs - refreshedMs > p.afterDays * 86_400_000) return `last refresh ${((nowMs - refreshedMs) / 86_400_000).toFixed(1)}d ago > ${p.afterDays}d`;
  return null;
}
/** Pure: KPI — known access expiry inside key_refresh_before_h (after this spawn's refreshes). */
export const unrefreshedSoon = <C extends KeptCredential>(creds: readonly C[], nowMs: number, beforeH: number): C[] =>
  creds.filter(c => c.expiresAt !== null && c.expiresAt - nowMs < beforeH * 3_600_000);

/** What one refresh did — metadata only (times), never a value. */
export interface KeyRefreshResult { readonly ok: boolean; readonly before: { lastRefresh: string | null; expiresAt: number | null }; readonly after: { lastRefresh: string | null; expiresAt: number | null }; readonly line: string }
/** Verified = last_refresh moved forward (the CLI wrote a new login) — an rpc «ok» alone proves nothing. */
export const refreshAdvanced = (r: Pick<KeyRefreshResult, 'before' | 'after'>): boolean => {
  const a = r.after.lastRefresh ? Date.parse(r.after.lastRefresh) : NaN; const b = r.before.lastRefresh ? Date.parse(r.before.lastRefresh) : NaN;
  return Number.isFinite(a) && (!Number.isFinite(b) || a > b);
};

/** A decisions-ledger card (`eln decisions raise` shape) — category secret: relogin is the token owner's act. */
export interface KeyCard {
  readonly title: string; readonly category: 'secret';
  readonly scqa: { readonly s: string; readonly c: string; readonly q: string; readonly a: string };
  readonly options: ReadonlyArray<{ readonly key: string; readonly label: string; readonly consequence: string }>;
  readonly recommendation: { readonly option: string; readonly why: string };
  readonly raisedBy: { readonly agent: string }; readonly refs: readonly string[];
}
/** The HITL card when the CLI could not refresh a home: exact relogin steps at the token's single owner (`ownerHost` = the
 *  credential-owner ledger's codex slot · the login link via aside → telegram). Times only — never a value. */
export function reloginCard(id: string, home: string, why: string, line: string, ownerHost: string): KeyCard {
  return {
    title: `열쇠지기: ${id} 자동 갱신 실패 — 재로그인 필요`, category: 'secret',
    scqa: {
      s: `${id} (CODEX_HOME=${home}) — ${why}.`,
      c: `수호자가 CLI 자체 갱신(codex app-server account/read refreshToken)을 돌렸지만 last_refresh 가 그대로다: ${line}.`,
      q: '토큰이 끊기기 전에 누가 어디서 다시 로그인하나?',
      a: [`토큰 주인 = ${ownerHost} 한 곳 · 값은 옮기지 않는다. 1) ${ownerHost} 에서 CODEX_HOME=${home} codex login`,
        '2) 뜬 로그인 링크는 aside 로 연다(대표 계정) — 손이 없으면 그 링크를 텔레그램으로 👑 에',
        `3) 확인: CODEX_HOME=${home} codex login status · 다음 열쇠지기 점검에 last_refresh 가 앞으로 간다`,
        '⛔ 다른 홈의 auth.json 복사 금지(갱신 토큰은 한 번만 쓰인다 — 복사본이 원본을 끊는다).'].join(' · '),
    },
    options: [
      { key: 'a', label: '재로그인 완료', consequence: '다음 점검이 last_refresh 전진을 확인하고 사건을 닫는다' },
      { key: 'b', label: '이 홈 은퇴', consequence: '정책 overlay 의 homes 에서 뺀다 — 그 홈을 쓰는 자리는 다른 홈으로' },
    ],
    recommendation: { option: 'a', why: '자리가 이 홈으로 돈다 — 만료되면 그 자리 턴이 멈춘다' },
    raisedBy: { agent: 'guardian' }, refs: [],
  };
}

// The bound on one app-server run is the caller's policy (guardian agent.yaml key_refresh_timeout_sec) — the app-server answers in
// < 1 s on a live home (measured 0.3–0.6 s, synthetic universe 11-28).
const metaOf = (home: string) => { const m = codexAuthMeta(home); return { lastRefresh: m?.lastRefresh ?? null, expiresAt: m?.expiresAt ?? null, refreshable: m?.refreshable ?? false, connected: m?.connected ?? false }; };

export async function refreshCodexHome(home: string, o: { codexBin?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<KeyRefreshResult> {
  const b = metaOf(home);
  const before = { lastRefresh: b.lastRefresh, expiresAt: b.expiresAt };
  if (!b.connected) return { ok: false, before, after: before, line: 'no auth.json login in this home' };
  if (!b.refreshable) return { ok: false, before, after: before, line: 'no refresh token in this home (access-only copy) — refresh its owner home' };
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), CODEX_HOME: home };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY; // the ChatGPT login in auth.json, never an API key
  const rpc = await new Promise<string>((resolve) => {
    let out = ''; let settled = false;
    const child = spawn(o.codexBin ?? 'codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (line: string) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGTERM'); } catch { /* gone */ } resolve(line); };
    const timer = setTimeout(() => done(`timeout ${Math.round(o.timeoutMs / 1000)}s`), o.timeoutMs);
    child.on('error', (e) => done(`spawn failed (${(e as NodeJS.ErrnoException).code ?? e.message.slice(0, 40)})`));
    child.on('exit', (code) => done(`app-server exited ${code ?? '?'} before answering`));
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        type RpcLine = { id?: unknown; error?: { message?: unknown } };
        let m: RpcLine | null;
        try { m = JSON.parse(line) as RpcLine | null; } catch { continue; }
        if (m && m.id === 2) done(m.error ? `account/read error: ${String(m.error.message ?? '').slice(0, 100)}` : 'account/read ok');
      }
    });
    const lines = [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'elanous-guardian-keys', version: '1' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/read', params: { refreshToken: true } },
    ].map(x => JSON.stringify(x)).join('\n');
    try { child.stdin.write(`${lines}\n`); } catch (e) { done(`stdin write failed (${String(e).slice(0, 40)})`); }
  });
  const a = metaOf(home);
  const after = { lastRefresh: a.lastRefresh, expiresAt: a.expiresAt };
  const ok = refreshAdvanced({ before, after });
  return { ok, before, after, line: `${rpc} · last_refresh ${before.lastRefresh ?? '-'} → ${after.lastRefresh ?? '-'}${ok ? '' : ' (not advanced)'}` };
}

/** Every `homes:` entry of the llm-accounts pack (repo ⊕ live overlay), `~` expanded — the homes the seats actually run on. */
export function packCredentialHomes(): Array<{ provider: string; account: string; home: string }> {
  try {
    const { loadLlmAccountPack } = require('../resource-facts/llm-accounts.js') as typeof import('../resource-facts/llm-accounts.js');
    const pack = loadLlmAccountPack().pack;
    if (!pack) return [];
    return Object.entries(pack.providers).flatMap(([p, pp]) => Object.entries(pp.accounts).flatMap(([a, ap]) => ap.homes.map(h => ({ provider: p, account: a, home: h.replace(/^~(?=\/|$)/u, homedir()) }))));
  } catch { return []; }
}
