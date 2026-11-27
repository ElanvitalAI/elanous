// `eln proxy` — grant · status · revoke the CEO-proxy principal (CLAUDE-OP-PROXY-IDENTITY · 내부 문서 `CLAUDE-OP-PROXY` §A2).
// grant runs only in a person's terminal (TTY · no agent ancestor · typed confirm code); status/revoke are plain reads/writes.
import type { Command } from 'commander';
import {
  PROXY_PRINCIPAL, grantConfirmCode, grantPreflight, proxyStateRoot, readProxyGrant, revokeProxyGrant, verifyProxyCaller, writeProxyGrant,
  defaultProcLookup, defaultProcMeta, type ProcLookup, type ProcMetaLookup,
} from '../proxy/proxy-identity.js';

export interface ProxyCliDeps {
  readonly stateRoot?: () => string;
  readonly lookup?: () => ProcLookup;
  readonly meta?: () => ProcMetaLookup;
  readonly stdinIsTTY?: () => boolean;
  readonly selfPid?: () => number;
  readonly ask?: (prompt: string) => Promise<string>;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly notifyOp?: (line: string) => void;
  readonly now?: () => number;
}

async function askLine(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try { return await new Promise<string>((resolve) => rl.question(prompt, resolve)); } finally { rl.close(); }
}

function notifyOpDefault(line: string): void {
  const { openMsgStore, defaultMsgStorePath } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
  const store = openMsgStore(defaultMsgStorePath());
  try { store.post({ from: PROXY_PRINCIPAL, to: 'OP', kind: 'notice', body: line }); } finally { store.close(); }
}

export function registerProxyCommands(program: Command, deps: ProxyCliDeps = {}): void {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const exit = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const root = () => deps.stateRoot?.() ?? proxyStateRoot();
  const lookup = () => deps.lookup?.() ?? defaultProcLookup();
  const now = () => deps.now?.() ?? Date.now();
  const notify = (line: string) => { try { (deps.notifyOp ?? notifyOpDefault)(line); } catch { /* the audit row is the record */ } };
  const proxy = program.command('proxy').description('CEO proxy principal (CLAUDE-OP): grant once from your own terminal · status · revoke');

  proxy.command('grant <principal>').description('Grant the CEO-proxy role to one live Claude Code process (run it yourself in a terminal)')
    .requiredOption('--runtime <pid>', 'the Claude Code (claude) process of the proxy session')
    .action(async (principal: string, opts: { runtime: string }) => {
      if (principal.trim().toUpperCase() !== PROXY_PRINCIPAL) { err(`eln proxy grant: only ${PROXY_PRINCIPAL} can hold the proxy role`); exit(2); return; }
      const runtimePid = Number(opts.runtime);
      if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) { err('eln proxy grant: --runtime must be a process id'); exit(2); return; }
      const pre = grantPreflight({ selfPid: deps.selfPid?.() ?? process.pid, stdinIsTTY: deps.stdinIsTTY?.() ?? process.stdin.isTTY === true, runtimePid, lookup: lookup(), meta: deps.meta?.() ?? (deps.lookup ? undefined : defaultProcMeta()) });
      if (!pre.ok) { err(pre.line); exit(1); return; }
      const code = grantConfirmCode();
      const typed = (await (deps.ask ?? askLine)(`Grant ${PROXY_PRINCIPAL} = CEO proxy with OP operator authority to ${pre.runtime.name} pid ${pre.runtime.pid} for 7 days?\n(money · secrets · JUD veto · destructive git · pkill stay closed)\nType ${code} to grant: `)).trim().toUpperCase();
      if (typed !== code) { err('eln proxy grant: not granted (code mismatch)'); exit(1); return; }
      const grant = writeProxyGrant(root(), pre.runtime, now());
      notify(`[Claude OP 대행] proxy grant issued · runtime pid ${grant.runtime.pid} · until ${grant.expiresAt}`);
      out(`granted ${PROXY_PRINCIPAL} → pid ${grant.runtime.pid} until ${grant.expiresAt} (grant ${grant.grantId.slice(0, 8)})`);
    });

  proxy.command('status [principal]').description('Show the proxy grant and whether this process verifies as the proxy')
    .option('--json', 'machine-readable')
    .action((principal: string | undefined, opts: { json?: boolean }) => {
      const p = (principal ?? PROXY_PRINCIPAL).toUpperCase();
      const { grant, unsafe } = readProxyGrant(root(), p);
      const v = verifyProxyCaller({ stateRoot: root(), principal: p, lookup: lookup(), now: now() });
      const row = { principal: p, granted: grant !== null, unsafe, ...(grant ? { runtimePid: grant.runtime.pid, expiresAt: grant.expiresAt, grantId: grant.grantId.slice(0, 8) } : {}),
        thisProcess: v.ok ? 'proxy' : v.reason };
      if (opts.json) out(JSON.stringify(row));
      else out(grant ? `${p}: granted to pid ${grant.runtime.pid} until ${grant.expiresAt} · this process: ${v.ok ? 'verified proxy' : v.line}` : `${p}: ${unsafe ? 'grant file unsafe (ignored)' : 'no grant'} · ${v.ok ? '' : v.line}`);
    });

  proxy.command('revoke [principal]').description('Revoke the proxy grant (audited · noticed to OP)')
    .action((principal: string | undefined) => {
      const p = (principal ?? PROXY_PRINCIPAL).toUpperCase();
      const done = revokeProxyGrant(root(), p, now());
      if (done) notify(`[Claude OP 대행] proxy grant revoked`);
      out(done ? `revoked ${p}` : `${p}: no grant`);
    });
}
