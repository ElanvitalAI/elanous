import { CHROME_NO_KEYCHAIN_FLAGS } from '../browser-cdp/chrome-flags.js';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { discoverChromeBinary, createCdpClientFromEndpoint, resolveDebuggerUrl, type CdpClient } from '../browser-cdp/client.js';
import { debug } from '../debug/log.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';
import { listPtyManifestRows } from '../pty-shell/pty-manifest.js';
import { resolvePtyRef } from '../pty-shell/pty-ref.js';
import { runPtySnapshot, runPtyText } from '../cli/pty-takeover-cli.js';

export type LoginProvider = 'codex' | 'claude';
export type LoginReason = 'no-backend' | 'host-not-allowed' | 'password' | 'two-factor' | 'captcha' | 'passkey' | 'account-choice' | 'unknown-page' | 'timeout';
export interface LoginSnapshot {
  url: string;
  text: string;
  inputs: { type: string; name?: string; autocomplete?: string }[];
  buttons: string[];
}
export type LoginClassification = { headless: true; action: 'click' | 'enter-code' | 'read-code'; target: string } | { headless: false; reason: LoginReason };

function allowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && (
      ['auth.openai.com', 'chatgpt.com', 'claude.ai', 'console.anthropic.com'].includes(u.hostname.toLowerCase())
      || (u.hostname.toLowerCase() === 'github.com' && u.pathname === '/login/device')
    );
  } catch { return false; }
}

const APPROVE = /^(?:authorize|allow|continue|approve|승인|허용|계속)$/i;
const CODE_MARKER = /\[login-code\]([^\[\]\r\n]{4,512})\[\/login-code\]/;
export function classifyLoginPage(snapshot: LoginSnapshot): LoginClassification {
  if (!allowed(snapshot.url)) return { headless: false, reason: 'host-not-allowed' };
  const fields = snapshot.inputs.map(i => `${i.type} ${i.name ?? ''} ${i.autocomplete ?? ''}`.toLowerCase());
  const text = snapshot.text.toLowerCase();
  if (fields.some(f => /password|email|username/i.test(f))) return { headless: false, reason: 'password' };
  if (fields.some(f => /one-time-code|otp|totp/.test(f)) || /verification code|2-step|two.factor/.test(text)) return { headless: false, reason: 'two-factor' };
  if (/captcha|recaptcha|hcaptcha|turnstile/.test(text)) return { headless: false, reason: 'captcha' };
  if (/passkey|webauthn|security key/.test(text)) return { headless: false, reason: 'passkey' };
  if (/choose an account|select an account|계정 선택/.test(text)) return { headless: false, reason: 'account-choice' };
  const approvals = snapshot.buttons.filter(b => APPROVE.test(b.trim()));
  if (approvals.length > 1) return { headless: false, reason: 'account-choice' };
  if (snapshot.inputs.length === 1 && fields.filter(f => /code|device/.test(f)).length === 1) return { headless: true, action: 'enter-code', target: 'device-code' };
  const host = new URL(snapshot.url).hostname;
  const code = CODE_MARKER.exec(snapshot.text)?.[1]?.trim();
  if (['claude.ai', 'console.anthropic.com'].includes(host) && code) {
    return { headless: true, action: 'read-code', target: code };
  }
  if (approvals.length === 1) return { headless: true, action: 'click', target: approvals[0]!.trim() };
  return { headless: false, reason: 'unknown-page' };
}

// Read only rendered DOM. No cookie, localStorage, credential file or storageState access.
const SNAPSHOT_JS = `(() => ({
  url: location.href,
  text: (document.body?.innerText || '').slice(0, 12000) + '\\n' + [...document.querySelectorAll('pre,code')].map(e => '[login-code]' + (e.textContent || '').trim().slice(0,512) + '[/login-code]').join('\\n'),
  inputs: [...document.querySelectorAll('input')].map(e => ({type:e.type,name:e.name,autocomplete:e.autocomplete})),
  buttons: [...document.querySelectorAll('button,input[type=submit],a[role=button]')].filter(e => e.getClientRects().length > 0).map(e => (e.innerText || e.value || '').trim())
}))()`;

export interface LoginDeps {
  profileDir?: string;
  profileExists?: (path: string) => boolean;
  chromeBinary?: () => string | null;
  spawnChrome?: (binary: string, args: string[]) => ChildProcess;
  resolveChromePort?: (port: number) => Promise<unknown>;
  connect?: (port: number) => Promise<CdpClient>;
  log?: (event: string, data: Record<string, unknown>) => void;
  decide?: (event: DecisionEvent) => unknown;
  sleep?: (ms: number) => Promise<void>;
}

export function browserProfileDir(): string { return join(elanousStateRoot(), 'browser-profile'); }
export function browserProfileStatus(dir = browserProfileDir()): { exists: boolean; lastUse: string | null } {
  try {
    const stat = statSync(dir);
    return { exists: stat.isDirectory(), lastUse: stat.isDirectory() ? stat.mtime.toISOString() : null };
  } catch { return { exists: false, lastUse: null }; }
}
export function launchBrowserProfileLogin(deps: Pick<LoginDeps, 'profileDir' | 'chromeBinary' | 'spawnChrome'> = {}): boolean {
  const binary = (deps.chromeBinary ?? discoverChromeBinary)();
  if (!binary) return false;
  const dir = deps.profileDir ?? browserProfileDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  (deps.spawnChrome ?? ((b, a) => spawn(b, a, { detached: true, stdio: 'ignore' })))(binary, [`--user-data-dir=${dir}`, ...CHROME_NO_KEYCHAIN_FLAGS, '--no-first-run', 'https://chatgpt.com']);
  return true;
}

export type ApprovalResult = { outcome: 'approved'; code?: string } | { outcome: 'ask-human'; reason: LoginReason };
export async function approveCliLogin(input: { url: string; code?: string; provider: LoginProvider }, deps: LoginDeps = {}): Promise<ApprovalResult> {
  const log = (event: string, data: Record<string, unknown>) => (deps.log ?? ((e, d) => debug.log('agent-mission.browser-login', e, d)))(event, data);
  const decide = (kind: DecisionEvent['kind'], reason: string, target: string) =>
    (deps.decide ?? emitDecision)({ kind, what: 'CLI browser login', reason, purpose: 'approve existing session only', target });
  const escalate = (reason: LoginReason): ApprovalResult => {
    log('escalated', { reason }); decide('ESCALATE', reason, 'human');
    return { outcome: 'ask-human', reason };
  };
  log('backend', { stage: 'start' });
  decide('ROUTE', 'login = browser; use existing session', 'browser');
  if (!allowed(input.url)) return escalate('host-not-allowed');
  const connect = deps.connect ?? createCdpClientFromEndpoint;
  let client: CdpClient | undefined;
  let child: ChildProcess | undefined;
  let backend = '';
  const dir = deps.profileDir ?? browserProfileDir();
  const hasProfile = (deps.profileExists ?? ((path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } }))(dir);
  const binary = hasProfile ? (deps.chromeBinary ?? discoverChromeBinary)() : null;
  if (hasProfile && binary) {
    // An owned Chrome must have its own loopback CDP port, separate from the user's 9222 session.
    const port = 20000 + Math.floor(Math.random() * 30000);
    try {
      child = (deps.spawnChrome ?? ((b, a) => spawn(b, a, { stdio: 'ignore' })))(binary, [
        '--headless=new', `--user-data-dir=${dir}`, ...CHROME_NO_KEYCHAIN_FLAGS, `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1', '--no-first-run', 'about:blank',
      ]);
      await (deps.resolveChromePort ?? ((p) => resolveDebuggerUrl(p, { attachTimeoutMs: 4000 })))(port);
      client = await connect(port);
      backend = 'profile';
    } catch { try { await client?.close(); } catch { /* fail-soft */ } child?.kill(); child = undefined; client = undefined; }
  }
  if (!client) {
    try { client = await connect(9222); backend = 'cdp-9222'; } catch { return escalate('no-backend'); }
  }
  log('backend', { backend });
  try {
    const navigation = await client.navigate(input.url);
    if (navigation.errorText) return escalate('unknown-page');
    const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
    await sleep(400);
    let acted = false;
    let enteredCode = false;
    for (let step = 1; step <= 4; step++) {
      const snapshot = await client.evaluate(SNAPSHOT_JS) as LoginSnapshot;
      if (!snapshot || !Array.isArray(snapshot.inputs) || !Array.isArray(snapshot.buttons) || typeof snapshot.text !== 'string') return escalate('unknown-page');
      const classified = classifyLoginPage(snapshot);
      log('classified', { backend, step, action: classified.headless ? classified.action : 'escalate', reason: classified.headless ? undefined : classified.reason });
      if (!classified.headless) {
        if (acted && classified.reason === 'unknown-page' && allowed(snapshot.url)) {
          log('done', { backend, steps: step - 1 }); decide('VERIFY', 'approval action completed', backend);
          return { outcome: 'approved' };
        }
        return escalate(classified.reason);
      }
      if (classified.action === 'enter-code' && enteredCode) return escalate('timeout');
      decide('ROUTE', `step ${step}: ${classified.action}`, backend);
      if (classified.action === 'read-code') {
        const fresh = classifyLoginPage(await client.evaluate(SNAPSHOT_JS) as LoginSnapshot);
        if (!fresh.headless || fresh.action !== 'read-code' || fresh.target !== classified.target) return escalate(fresh.headless ? 'unknown-page' : fresh.reason);
        log('acted', { backend, step, action: 'read-code', codeLength: classified.target.length });
        log('done', { backend, steps: step }); decide('VERIFY', 'code transferred to caller', backend);
        return { outcome: 'approved', code: classified.target };
      }
      if (classified.action === 'enter-code' && !input.code) return escalate('unknown-page');
      // Re-observe immediately before mutation; never act if a dangerous signal appeared meanwhile.
      const fresh = classifyLoginPage(await client.evaluate(SNAPSHOT_JS) as LoginSnapshot);
      if (!fresh.headless || fresh.action !== classified.action || fresh.target !== classified.target) return escalate(fresh.headless ? 'unknown-page' : fresh.reason);
      const action = classified.action;
      const target = classified.target;
      const code = input.code;
      const result = await client.evaluate(`(() => {
        const snapshot = ${SNAPSHOT_JS};
        const candidates = [...document.querySelectorAll('button,input[type=submit],a[role=button]')];
        const fields = [...document.querySelectorAll('input')];
        if (snapshot.url !== ${JSON.stringify(snapshot.url)} || snapshot.inputs.some(i => /password|email|username|one-time-code|otp|totp/i.test(i.type+' '+i.name+' '+i.autocomplete)) || /captcha|recaptcha|hcaptcha|turnstile|passkey|webauthn|security key|verification code|2-step|choose an account|select an account/i.test(snapshot.text)) return false;
        if (${JSON.stringify(action)} === 'click') {
          const matches = candidates.filter(e => e.getClientRects().length > 0 && (e.innerText || e.value || '').trim() === ${JSON.stringify(target)});
          if (matches.length !== 1 || candidates.filter(e => e.getClientRects().length > 0 && /^(authorize|allow|continue|approve|승인|허용|계속)$/i.test((e.innerText || e.value || '').trim())).length !== 1) return false;
          matches[0].click(); return true;
        }
        const matches = fields.filter(e => e.getClientRects().length > 0 && /code|device/i.test(e.type+' '+e.name+' '+e.autocomplete));
        if (fields.length !== 1 || matches.length !== 1 || !${JSON.stringify(!!code)}) return false;
        matches[0].value = ${JSON.stringify(code ?? '')};
        matches[0].dispatchEvent(new Event('input', {bubbles:true}));
        matches[0].dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      })()`);
      if (result !== true) return escalate('unknown-page');
      acted = true;
      if (action === 'enter-code') enteredCode = true;
      log('acted', { backend, step, action, ...(action === 'enter-code' ? { codeLength: code!.length } : {}) });
      await sleep(400);
    }
    return escalate('timeout');
  } catch { return escalate('timeout'); }
  finally {
    try { await client.close(); } catch { /* closed by owner */ }
    child?.kill();
  }
}

export interface LoginPtyDeps extends LoginDeps {
  snapshot?: (ref: string) => Promise<string | null>;
  text?: (ref: string, text: string) => Promise<boolean>;
  codexStatus?: () => string;
}
export type BrowserLoginResult = { outcome: 'verified'; provider: LoginProvider } | { outcome: 'ask-human'; url: string; code?: string; reason: LoginReason };
export async function loginViaBrowser(ptyRef: string, provider: LoginProvider, deps: LoginPtyDeps = {}): Promise<BrowserLoginResult> {
  const rows = deps.snapshot ? [] : listPtyManifestRows().filter(row => row.alive && row.terminalOriginCategory !== 'external-tool');
  const resolved = resolvePtyRef(ptyRef, rows.map(row => ({ id: row.id, kind: row.kind, nickname: row.nickname })));
  const ref = resolved.match?.id ?? ptyRef;
  if (!deps.snapshot && (!resolved.match || resolved.reason === 'ambiguous')) {
    return { outcome: 'ask-human', url: '', reason: 'unknown-page' };
  }
  const snapshot = deps.snapshot ?? (async (id: string) => {
    if (!resolved.match || resolved.reason === 'ambiguous') return null;
    const r = await runPtySnapshot(id);
    return r.exitCode === 0 && r.message.startsWith('PtyShellSnapshot ') && !r.message.split('\n', 1)[0]?.includes('source=frame') ? r.message : null;
  });
  let screen: string | null;
  try { screen = await snapshot(ref); } catch { screen = null; }
  const url = screen?.match(/https:\/\/[^\s<>"'\x1b]+/)?.[0]?.replace(/[),.;]+$/, '') ?? '';
  const code = provider === 'codex' ? screen?.match(/(?:one.time code|device code|enter the code|code:)\s*(?:is\s+)?([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?)/i)?.[1] : undefined;
  if (!url || !allowed(url)) return { outcome: 'ask-human', url, ...(code ? { code } : {}), reason: url ? 'host-not-allowed' : 'unknown-page' };
  const approved = await approveCliLogin({ url, code, provider }, deps);
  if (approved.outcome === 'ask-human') return { ...approved, url, ...(code ? { code } : {}) };
  const text = deps.text ?? (async (id: string, value: string) => {
    if (!resolved.match || resolved.reason === 'ambiguous') return false;
    const r = await runPtyText(id, value, true, undefined, 'agent');
    return r.exitCode === 0;
  });
  if (provider === 'claude' && approved.code) {
    try { if (!(await text(ref, approved.code))) return { outcome: 'ask-human', url, reason: 'timeout' }; }
    catch { return { outcome: 'ask-human', url, reason: 'timeout' }; }
  }
  const sleep = deps.sleep ?? (ms => Bun.sleep(ms));
  for (let i = 0; i < 5; i++) {
    if (provider === 'codex') {
      try {
        if (/^logged in\b/i.test((deps.codexStatus ?? (() => execFileSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 5000 })))().trim())) return { outcome: 'verified', provider };
      } catch { /* not yet logged in */ }
    } else {
      try { if (/Login successful/i.test((await snapshot(ref)) ?? '')) return { outcome: 'verified', provider }; }
      catch { /* PTY unavailable: report timeout to caller */ }
    }
    await sleep(400);
  }
  return { outcome: 'ask-human', url, ...(code ? { code } : {}), reason: 'timeout' };
}
