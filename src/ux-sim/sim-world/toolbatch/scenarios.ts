import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRunShellApprovalIssuer, isRunShellApprovalCall, RUNSHELL_APPROVAL_RESULT, RUNSHELL_PUBLIC_KEY_ENV } from '../../../tui-client/next-runshell-approval.js';
import { runTrial } from '../../../../scripts/experiments/run-shell-script-trial.js';
import { dispatchRunShell } from '../../../skills/tools/shell.js';
import { scriptCommandPolicy } from '../../../skills/tools/run-shell-script.js';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { parseRecipeJson, recipeHash, recipeSigningBytes, verifySignedRecipeGrant } from '../../../skills/tools/run-shell-recipe-ledger.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

export const simWorldDevices: readonly SimWorldDeviceDef[] = [{
  id: 'RUNSHELL-FAKE-JUD', title: 'isolated fake JUD Ed25519 signer for verification only',
  create() { return generateKeyPairSync('ed25519'); },
}];

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'RUNSHELL-SCRIPT-7TASK',
  title: 'seven read-only actual eln CLI tasks, single calls versus ordered RunShell script',
  async run(ctx) {
    const report = await runTrial(join(ctx.universeRoot, 'run-shell-script-trial'));
    for (const task of report.tasks) ctx.recorder.event('runshell-script-task', {
      id: task.id, baselineTurns: task.baselineTurns, scriptTurns: task.scriptTurns,
      baselineTokensEstimated: task.baselineTokensEstimated, scriptTokensEstimated: task.scriptTokensEstimated,
      correct: task.correct, baselineFailures: task.baselineFailures, scriptFailures: task.scriptFailures,
    });
    ctx.recorder.event('runshell-script-trial', report.totals);
    return report.decision === 'simulation-go'
      ? { ok: true }
      : { ok: false, reason: 'RunShell script trial threshold missed', diff: JSON.stringify(report.totals) };
  },
}, {
  id: 'RUNSHELL-GIT-GH-READ',
  title: 'git local read and gh GET approval with a denied network request and POST refusal',
  async run(ctx) {
    const root = join(ctx.universeRoot, 'git-gh-read');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const gitCalls = join(root, 'git-calls');
    const ghCalls = join(root, 'gh-calls');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf 'git\\n' >> '${gitCalls}'\nprintf '{"kind":"git"}'\n`);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf 'gh\\n' >> '${ghCalls}'\nprintf '{"kind":"gh"}'\n`);
    chmodSync(join(bin, 'git'), 0o700);
    chmodSync(join(bin, 'gh'), 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const steps = [
        { id: 'local', command: ['git', 'log', '--oneline', 'HEAD'], select: ['kind'] },
        { id: 'network', command: ['gh', 'api', 'repos/team/repo/issues?state=open&b=2'], select: ['kind'] },
      ];
      const approved: string[] = [];
      const denied = await dispatchRunShell({ script: steps }, { scriptApproval: async (argv) => {
        approved.push(`${scriptCommandPolicy(argv)}:${argv[0]}`);
        return { allowed: argv[0] !== 'gh', priorHumanApproval: false };
      } });
      const deniedCalls = existsSync(ghCalls) ? readFileSync(ghCalls, 'utf8') : '';
      const accepted = await dispatchRunShell({ script: steps }, { scriptApproval: async (argv) => ({
        allowed: true, priorHumanApproval: argv[0] === 'gh',
      }) });
      let postRefused = false;
      try { await dispatchRunShell({ script: [{ id: 'post', command: ['gh', 'api', 'repos/team/repo', '--method', 'POST'] }] },
        { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }) }); }
      catch { postRefused = true; }
      const result = {
        denied: denied.outcome, approved,
        deniedGhCalls: deniedCalls.length,
        accepted: accepted.outcome,
        acceptedKinds: (JSON.parse(accepted.stdout) as { steps: Array<{ selected?: { kind?: string } }> }).steps.map((step) => step.selected?.kind),
        gitCalls: readFileSync(gitCalls, 'utf8').trim().split('\n').length,
        ghCalls: readFileSync(ghCalls, 'utf8').trim().split('\n').length,
        postRefused,
      };
      ctx.recorder.event('runshell-git-gh-read', result);
      return result.denied === 'denied' && result.approved.join(',') === 'read-local:git,read-network:gh'
        && result.deniedGhCalls === 0 && result.accepted === 'exit'
        && result.acceptedKinds.join(',') === 'git,gh' && result.gitCalls === 2 && result.ghCalls === 1 && postRefused
        ? { ok: true } : { ok: false, reason: 'RunShell git/gh approval boundary changed', diff: JSON.stringify(result) };
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  },
}, {
  id: 'RUNSHELL-RECIPE-SIGNED',
  title: 'fake JUD signature foundation denies missing trust, forgery, altered hash and revoke-as-grant',
  devices: ['RUNSHELL-FAKE-JUD'],
  async run(ctx) {
    const keys = ctx.device<{ publicKey: KeyObject; privateKey: KeyObject }>('RUNSHELL-FAKE-JUD');
    const trusted = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const attacker = generateKeyPairSync('ed25519');
    const recipe = Object.freeze({ id: 'op-30m', version: 1, argvTemplate: Object.freeze(['eln', 'ops', 'check-30m']) });
    const event = { v: 1 as const, kind: 'grant' as const, recipeId: recipe.id,
      recipeSha256: recipeHash(recipe), signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
    const signed = (privateKey: KeyObject, value: typeof event | (Omit<typeof event, 'kind'> & { kind: 'revoke' }) = event) => ({
      ...value, signature: sign(null, recipeSigningBytes(value), privateKey).toString('base64'),
    });
    const grant = signed(keys.privateKey);
    const absent = verifySignedRecipeGrant(recipe, grant, undefined);
    const forged = verifySignedRecipeGrant(recipe, signed(attacker.privateKey), trusted);
    const changed = verifySignedRecipeGrant(Object.freeze({ ...recipe, argvTemplate: Object.freeze(['eln', 'other']) }), grant, trusted);
    const valid = verifySignedRecipeGrant(recipe, grant, trusted);
    const revoke = verifySignedRecipeGrant(recipe, signed(keys.privateKey, { ...event, kind: 'revoke' }), trusted);
    const denied = !absent.allowed && !forged.allowed && !changed.allowed && !revoke.allowed;
    ctx.recorder.event('recipe-signature-foundation', {
      denied, valid: valid.allowed, reasons: [absent, forged, changed, revoke].map(result =>
        result.allowed ? 'unexpected-allow' : result.reason),
    });
    return denied && valid.allowed ? { ok: true }
      : { ok: false, reason: 'signature foundation accepted an injected invalid grant',
        diff: JSON.stringify({ absent, forged, changed, valid, revoke }) };
  },
}, {
  id: 'RUNSHELL-ELN-KUBE-HOST-READ',
  title: 'actual RunShell dispatch consumes local reads, gates cluster access, and rejects unsafe argv',
  async run(ctx) {
    const root = join(ctx.universeRoot, 'eln-kube-host-read');
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = join(root, 'calls');
    writeFileSync(calls, '');
    for (const binary of ['eln', 'hostname', 'kubectl']) {
      writeFileSync(join(bin, binary), `#!/bin/sh\nprintf '${binary}\\n' >> '${calls}'\nprintf '{"kind":"${binary}"}'\n`);
      chmodSync(join(bin, binary), 0o700);
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const local = await dispatchRunShell({ script: [
        { id: 'memory', command: ['eln', 'memory', 'index'], select: ['kind'] },
        { id: 'host', command: ['hostname'], select: ['kind'] },
      ] }, { scriptApproval: async (argv) => ({ allowed: true, priorHumanApproval: false }) });
      const cluster = { id: 'cluster', command: ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'], select: ['kind'] };
      const denied = await dispatchRunShell({ script: [cluster] }, {
        scriptApproval: async () => ({ allowed: false, priorHumanApproval: false }),
      });
      const noChannel = await dispatchRunShell({ script: [cluster] });
      const before = readFileSync(calls, 'utf8');
      // A policy boolean is not a spawn grant. Use an isolated synthetic parent with
      // a fresh key, exact request checking and the real IPC/grant verification path.
      const issuer = createRunShellApprovalIssuer();
      let cards = 0;
      const runChild = (allow: boolean) => new Promise<Awaited<ReturnType<typeof dispatchRunShell>>>((resolve, reject) => {
        const child = spawn(process.execPath, [join(import.meta.dir, 'runshell-approval-child.ts')], {
          env: { ...process.env, [RUNSHELL_PUBLIC_KEY_ENV]: issuer.publicKey, ELANOUS_TRACK: 'sim-seat', HOME: root, SIM_ROOT: root },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        let result: Awaited<ReturnType<typeof dispatchRunShell>> | undefined;
        child.stderr?.on('data', data => { stderr += String(data); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('simulation approval child timed out')); }, 15000);
        child.on('message', (message: unknown) => {
          if (isRunShellApprovalCall(message)) {
            const r = message.request;
            const expected = [join(bin, 'kubectl'), ...cluster.command.slice(1)];
            const valid = r.callerSeat === 'sim-seat' && r.sessionId === 'sim-runshell-session'
              && r.cwd === root && JSON.stringify(r.argv) === JSON.stringify(expected)
              && r.bytesSha256 === createHash('sha256').update(readFileSync(expected[0]!)).digest('hex');
            if (valid) cards++;
            child.send({ type: RUNSHELL_APPROVAL_RESULT, callId: message.callId, approval: valid && allow ? issuer.issue(r) : null });
          } else if (message && typeof message === 'object' && (message as { type?: string }).type === 'sim.result') {
            result = (message as { result: Awaited<ReturnType<typeof dispatchRunShell>> }).result;
          }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => {
          clearTimeout(timer);
          if (code !== 0 || !result) reject(new Error(`simulation child exit ${code} without result: ${stderr}`));
          else resolve(result);
        });
      });
      const ipcDenied = await runChild(false);
      const deniedAfter = readFileSync(calls, 'utf8');
      const approved = await runChild(true);
      let refused = false;
      try { await dispatchRunShell({ script: [
        { id: 'local', command: ['hostname'] },
        { id: 'unsafe', command: ['kubectl', 'get', 'secrets', '--raw', '/api/v1'] },
      ] }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }) }); }
      catch { refused = true; }
      const after = readFileSync(calls, 'utf8');
      const localKinds = (JSON.parse(local.stdout) as { steps: Array<{ selected?: { kind: string } }> }).steps.map((s) => s.selected?.kind);
      const clusterKind = (JSON.parse(approved.stdout) as { steps: Array<{ selected?: { kind: string } }> }).steps[0]?.selected?.kind;
      const measured = { local: local.outcome, localKinds, denied: denied.outcome, noChannel: noChannel.outcome,
        before, ipcDenied: ipcDenied.outcome, deniedAfter, approved: approved.outcome,
        clusterKind, after, refused, cards };
      ctx.recorder.event('runshell-eln-kube-host-read', measured);
      return local.outcome === 'exit' && localKinds.join(',') === 'eln,hostname' && denied.outcome === 'denied'
        && noChannel.outcome === 'denied'
        && before === 'eln\nhostname\n' && ipcDenied.outcome === 'denied' && deniedAfter === before
        && approved.outcome === 'exit' && approved.exitCode === 0 && clusterKind === 'kubectl'
        && after === 'eln\nhostname\nkubectl\n' && refused && cards === 2
        ? { ok: true } : { ok: false, reason: 'read bundle dispatch boundary changed', diff: JSON.stringify(measured) };
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  },
}, {
  id: 'RUNSHELL-RECIPE-INPUT-LIMITS',
  title: 'synthetic recipe parser and expanded graph inclusive input limits',
  devices: ['RUNSHELL-FAKE-JUD'],
  async run(ctx) {
    const keys = ctx.device<{ publicKey: KeyObject; privateKey: KeyObject }>('RUNSHELL-FAKE-JUD');
    const trusted = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const unsigned = { v: 1 as const, kind: 'grant' as const, recipeId: 'x',
      recipeSha256: recipeHash(Object.freeze({ id: 'x' })), signer: 'JUD' as const, at: '2026-11-22T00:00:00.000Z' };
    const grant = { ...unsigned, signature: sign(null, recipeSigningBytes(unsigned), keys.privateKey).toString('base64') };
    const results: Array<{ case: string; expected: string; actual: string }> = [];
    const check = (name: string, expected: string, fn: () => unknown) => {
      let actual = 'accept';
      try { fn(); } catch (e) { actual = e instanceof Error ? e.message : String(e); }
      results.push({ case: name, expected, actual });
    };
    const raw = Buffer.from('null' + ' '.repeat(1_000_000 - 4));
    const over = Buffer.concat([Buffer.from('null' + ' '.repeat(1_000_001 - 5)), Buffer.from([255])]);
    check('raw-exact-1000000', 'accept', () => parseRecipeJson(raw));
    check('raw-plus-one-1000001', 'recipe limit: raw bytes', () => parseRecipeJson(over));
    const bytes = (x: unknown) => Buffer.from(JSON.stringify(x));
    check('nodes-exact-10000', 'accept', () => parseRecipeJson(bytes(Array(9999).fill(null))));
    check('nodes-plus-one-10001', 'recipe limit: nodes', () => parseRecipeJson(bytes(Array(10000).fill(null))));
    let deep: unknown = null;
    for (let i = 0; i < 64; i++) deep = [deep];
    check('depth-exact-64', 'accept', () => parseRecipeJson(bytes(deep)));
    check('depth-plus-one-65', 'recipe limit: depth', () => parseRecipeJson(bytes([deep])));
    // Text is independently bounded for in-memory graphs: JSON adds quotes/escaping,
    // so an exact million-code-unit string cannot fit the raw JSON byte limit.
    check('text-exact-1000000', 'accept', () => recipeHash(Object.freeze({ a: 'x'.repeat(999999) })));
    check('text-plus-one-1000001', 'recipe limit: text', () => recipeHash(Object.freeze({ a: 'x'.repeat(1000000) })));
    let dag: unknown = Object.freeze({ value: 1 });
    for (let i = 0; i < 15; i++) dag = Object.freeze({ a: dag, b: dag });
    const expanded = Object.freeze({ id: 'x', dag });
    check('expanded-shared-dag', 'recipe limit: nodes', () => recipeHash(expanded));
    const verification = verifySignedRecipeGrant(expanded, grant, trusted);
    results.push({ case: 'expanded-dag-signed-verification', expected: 'recipe limit: nodes',
      actual: verification.allowed ? 'unexpected-allow' : verification.reason });
    for (const result of results) ctx.recorder.event('recipe-input-limit', result);
    const ok = results.every(result => result.actual === result.expected);
    return ok ? { ok: true } : { ok: false, reason: 'recipe input boundary mismatch', diff: JSON.stringify(results) };
  },
}];
