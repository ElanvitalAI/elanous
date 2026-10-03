import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { debug } from '../debug/log.js';
import { HOOK_EXPOSURE_REF, hookExposurePlan, hookExposureStatus, startPublicHookIngress, turnHookExposureOff, turnHookExposureOn, closeIngressAndExposure, parseFunnelTarget } from './expose.js';
import { startHookReceiver } from './receiver.js';

const root = () => mkdtempSync(join(tmpdir(), 'hook-exposure-'));
const version = () => ({ released: null, dev: null, codename: null });

test('plan is read-only; only a decided human 켬 choice runs one command and persists its decision and time; off needs no decision', async () => {
  const stateDir = root();
  const commands: string[] = [];
  const records: Array<{ event: string; data: unknown }> = [];
  const offLog = debug.registerSink({ name: 'hooks-expose-test', emit: record => {
    if (record.category === 'hooks.expose') records.push({ event: record.event, data: record.data });
  } });
  const deps = { stateDir, now: () => new Date('2026-10-03T00:00:00Z'),
    execute: (binary: string, args: readonly string[]) => { commands.push([binary, ...args].join(' ')); } };
  let ingress: ReturnType<typeof startPublicHookIngress> | undefined;
  let receiver: ReturnType<typeof startHookReceiver> | undefined;
  try {
    const plan = hookExposurePlan();
    expect(plan.path).toBe('/hooks/linear');
    expect(plan.decisionRef).toBe(HOOK_EXPOSURE_REF);
    expect(plan.local).toBe('http://127.0.0.1:31481');
    expect(plan.on).toBe('tailscale funnel --bg --https=8443 31481');
    expect(commands).toEqual([]);
    await expect(turnHookExposureOn(undefined, deps)).rejects.toThrow('valid --decision');
    await expect(turnHookExposureOn('D-20261003-99', deps)).rejects.toThrow('decision not found');
    expect(commands).toEqual([]);
    const ledger = new DecisionLedger({ stateDir, now: deps.now, resolveVersion: version });
    const raise = () => ledger.raise({ title: 'Open webhook?', category: 'security', scqa: { s: 'Local receiver exists.', c: 'Public access requires approval.' },
      options: [{ key: 'a', label: '켬', consequence: 'Publish webhook' }, { key: 'b', label: '끔', consequence: 'Keep private' }],
      recommendation: { skipped: true, reason: 'Owner chooses' }, raisedBy: { agent: 'test' }, refs: [HOOK_EXPOSURE_REF] });
    const pending = raise();
    await expect(turnHookExposureOn(pending.id, deps)).rejects.toThrow('not decided');
    const denied = raise();
    ledger.decide(denied.id, 'b', { kind: 'human' });
    await expect(turnHookExposureOn(denied.id, deps)).rejects.toThrow('not 켬');
    const unrelated = ledger.raise({ title: 'Unrelated publication?', category: 'publish', scqa: { s: 'Draft exists.', c: 'Publishing needs approval.' },
      options: [{ key: 'a', label: '켬', consequence: 'Publish' }, { key: 'b', label: '끔', consequence: 'Hold' }],
      recommendation: { skipped: true, reason: 'Owner chooses' }, raisedBy: { agent: 'test' } });
    ledger.decide(unrelated.id, 'a', { kind: 'human' });
    await expect(turnHookExposureOn(unrelated.id, deps)).rejects.toThrow('not for hooks exposure');
    const auto = raise();
    ledger.decide(auto.id, 'a', { kind: 'auto', agent: 'test', delegation: 'test only' });
    await expect(turnHookExposureOn(auto.id, deps)).rejects.toThrow('owner decision required');
    expect(commands).toEqual([]);
    ledger.decide(pending.id, 'a', { kind: 'human' });
    await expect(turnHookExposureOn(pending.id, deps)).rejects.toThrow('dedicated hooks ingress not running');
    const impostor = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('impostor') });
    try {
      await expect(turnHookExposureOn(pending.id, { ...deps, ingressPort: impostor.port })).rejects.toThrow('identity mismatch');
    } finally { impostor.stop(); }
    expect(commands).toEqual([]);
    receiver = startHookReceiver({ port: 0, root: stateDir, secrets: { linear: 'test-secret' }, forward: async () => 503 });
    ingress = startPublicHookIngress(receiver.url, 0, stateDir);
    const live = { ...deps, ingressPort: Number(new URL(ingress.url).port) };
    const identityPath = join(stateDir, 'hooks', 'ingress-identity.json');
    const identity = JSON.parse(await Bun.file(identityPath).text()) as { port: number; secret: string };
    writeFileSync(identityPath, JSON.stringify({ ...identity, secret: '0'.repeat(64) }));
    await expect(turnHookExposureOn(pending.id, live)).rejects.toThrow('identity mismatch');
    expect(commands).toEqual([]);
    writeFileSync(identityPath, JSON.stringify(identity));
    await expect(turnHookExposureOn(pending.id, { ...live, execute: () => { throw new Error('tailscale failed'); } })).rejects.toThrow('tailscale failed');
    expect(hookExposureStatus({ stateDir })).toBeNull();
    expect(await turnHookExposureOn(pending.id, live)).toEqual({ path: '/hooks/linear', decisionId: pending.id, openedAt: '2026-10-03T00:00:00.000Z' });
    expect(commands).toEqual([plan.on]);
    await expect(turnHookExposureOff({ stateDir, execute: () => { throw new Error('tailscale failed'); } })).rejects.toThrow('tailscale failed');
    expect(hookExposureStatus({ stateDir })?.decisionId).toBe(pending.id);
    expect(hookExposureStatus({ stateDir })).toEqual({ path: '/hooks/linear', decisionId: pending.id, openedAt: '2026-10-03T00:00:00.000Z' });
    await expect(turnHookExposureOn(pending.id, deps)).rejects.toThrow('already on');
    await turnHookExposureOff(deps);
    expect(commands).toEqual([plan.on, plan.off]);
    expect(hookExposureStatus({ stateDir })).toBeNull();
    const livePort = live.ingressPort;
    ingress.stop();
    ingress = undefined;
    const occupant = Bun.serve({ hostname: '127.0.0.1', port: livePort, fetch: () => new Response('other service') });
    try {
      await expect(turnHookExposureOn(pending.id, live)).rejects.toThrow('dedicated hooks ingress not running');
      expect(commands).toEqual([plan.on, plan.off]);
    } finally { occupant.stop(); }
    expect(records.map(record => record.event)).toEqual(['plan', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'on', 'refused', 'off', 'refused']);
    expect(JSON.stringify(records)).not.toContain('test only');
  } finally { ingress?.stop(); receiver?.stop(); offLog(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('failed exposure state save rolls back funnel; failed rollback reports uncertain public exposure', async () => {
  const stateDir = root();
  const ledger = new DecisionLedger({ stateDir, now: () => new Date('2026-10-03T00:00:00Z'), resolveVersion: version });
  const entry = ledger.raise({ title: 'Expose hook?', category: 'security', scqa: { s: 'Local listener exists.', c: 'Owner approval needed.' },
    options: [{ key: 'a', label: '켬', consequence: 'Expose' }, { key: 'b', label: '끔', consequence: 'Private' }],
    recommendation: { skipped: true, reason: 'Owner chooses' }, raisedBy: { agent: 'test' }, refs: [HOOK_EXPOSURE_REF] });
  ledger.decide(entry.id, 'a', { kind: 'human' });
  const receiver = startHookReceiver({ port: 0, root: stateDir, secrets: { linear: 'test-secret' }, forward: async () => 503 });
  const ingress = startPublicHookIngress(receiver.url, 0, stateDir);
  const commands: string[] = [];
  const blockedDir = join(stateDir, 'hooks', `exposure.json.${process.pid}.tmp`);
  mkdirSync(blockedDir);
  const deps = { stateDir, ingressPort: Number(new URL(ingress.url).port),
    execute: (binary: string, args: readonly string[]) => { commands.push([binary, ...args].join(' ')); } };
  try {
    await expect(turnHookExposureOn(entry.id, deps)).rejects.toThrow();
    expect(commands).toEqual([hookExposurePlan().on, hookExposurePlan().off]);
    rmSync(blockedDir, { recursive: true });
    expect(hookExposureStatus({ stateDir })).toBeNull();
    mkdirSync(blockedDir);
    commands.length = 0;
    await expect(turnHookExposureOn(entry.id, { ...deps, execute: (binary, args) => {
      commands.push([binary, ...args].join(' '));
      if (commands.length === 2) throw new Error('rollback failed');
    } })).rejects.toThrow('rollback failed; public exposure may still be open');
    expect(commands).toEqual([hookExposurePlan().on, hookExposurePlan().off]);
  } finally { ingress.stop(); receiver.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('separate CLI processes serialize off command, on command, and recorded state', async () => {
  const stateDir = root();
  const receiver = startHookReceiver({ port: 0, root: stateDir, secrets: { linear: 'test-secret' }, forward: async () => 503 });
  const ingress = startPublicHookIngress(receiver.url, 0, stateDir);
  const ledger = new DecisionLedger({ stateDir, now: () => new Date('2026-10-03T00:00:00Z'), resolveVersion: version });
  const entry = ledger.raise({ title: 'Expose?', category: 'security', scqa: { s: 'Local.', c: 'Requires approval.' },
    options: [{ key: 'a', label: '켬', consequence: 'Public' }, { key: 'b', label: '끔', consequence: 'Private' }],
    recommendation: { skipped: true, reason: 'Owner chooses' }, raisedBy: { agent: 'test' }, refs: [HOOK_EXPOSURE_REF] });
  ledger.decide(entry.id, 'a', { kind: 'human' });
  const commands = join(stateDir, 'commands');
  const release = join(stateDir, 'release');
  const onStarted = join(stateDir, 'on-started');
  const moduleUrl = new URL('./expose.ts', import.meta.url).href;
  const childCode = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { turnHookExposureOn, turnHookExposureOff } from ${JSON.stringify(moduleUrl)};
    const [mode, stateDir, port, decisionId, commands, release, onStarted] = process.argv.slice(1);
    if (mode === 'on') writeFileSync(onStarted, 'ready');
    const execute = (_binary, args) => {
      appendFileSync(commands, args[0] + ' ' + args.at(-1) + '\\n');
      if (mode === 'off') while (!existsSync(release)) Bun.sleepSync(10);
    };
    if (mode === 'off') await turnHookExposureOff({ stateDir, execute, funnelTarget: () => 31481 });
    else await turnHookExposureOn(decisionId, { stateDir, ingressPort: Number(port), execute });
  `;
  const launch = (mode: string) => Bun.spawn([process.execPath, '-e', childCode, mode, stateDir,
    String(new URL(ingress.url).port), entry.id, commands, release, onStarted], { stdout: 'pipe', stderr: 'pipe' });
  const off = launch('off');
  let on: ReturnType<typeof launch> | undefined;
  try {
    for (let i = 0; i < 200 && !Bun.file(commands).size; i++) await Bun.sleep(10);
    expect(readFileSync(commands, 'utf8')).toBe('funnel off\n');
    on = launch('on');
    for (let i = 0; i < 200 && !existsSync(onStarted); i++) await Bun.sleep(10);
    expect(existsSync(onStarted)).toBe(true);
    await Bun.sleep(100);
    expect(readFileSync(commands, 'utf8')).toBe('funnel off\n');
    writeFileSync(release, 'go');
    expect(await off.exited).toBe(0);
    expect(await on.exited).toBe(0);
    expect(readFileSync(commands, 'utf8')).toBe('funnel off\nfunnel 31481\n');
    expect(hookExposureStatus({ stateDir })?.decisionId).toBe(entry.id);
  } finally {
    writeFileSync(release, 'go');
    off.kill();
    on?.kill();
    ingress.stop(); receiver.stop(); rmSync(stateDir, { recursive: true, force: true });
  }
});

test('public ingress isolates every other route and delegates signed POST to the existing receiver queue', async () => {
  const stateDir = root();
  const now = 1_700_000_000_000;
  const receiver = startHookReceiver({ port: 0, root: stateDir, now: () => now, secrets: { linear: 'local-secret' }, forward: async () => 503, retryBaseMs: 100_000 });
  const ingress = startPublicHookIngress(receiver.url, 0, stateDir);
  try {
    for (const path of ['/', '/hooks/health', '/hooks/asana', '/v1/reports', '/v1/tasks', '/hooks/linear/', '/.hooks-ingress-identity']) {
      expect((await fetch(new URL(path, ingress.url))).status).toBe(404);
      expect((await fetch(new URL(path, ingress.url), { method: 'POST' })).status).toBe(404);
    }
    expect((await fetch(new URL('/hooks/linear', ingress.url))).status).toBe(405);
    expect((await fetch(new URL('/hooks/linear', ingress.url), { method: 'POST', body: '{}' })).status).toBe(401);
    expect(receiver.queue.count()).toBe(0);
    const raw = JSON.stringify({ type: 'Issue', action: 'create', webhookTimestamp: now, data: { id: 'issue-1', identifier: 'ELA-1', title: 'Task' } });
    const signature = createHmac('sha256', 'local-secret').update(raw).digest('hex');
    const accepted = await fetch(new URL('/hooks/linear', ingress.url), { method: 'POST', headers: { 'Linear-Signature': signature, 'Linear-Delivery': 'delivery-1' }, body: raw });
    expect(accepted.status).toBe(200);
    expect(receiver.queue.count()).toBe(1);
  } finally { ingress.stop(); receiver.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('off only turns off a Funnel this tool owns: recorded, or 8443 proxying to the hook ingress, or --force', async () => {
  const stateDir = root();
  const commands: string[] = [];
  const execute = (binary: string, args: readonly string[]) => { commands.push([binary, ...args].join(' ')); };
  try {
    expect(await turnHookExposureOff({ stateDir, execute, funnelTarget: () => null })).toEqual({ changed: false, reason: 'not-ours' });
    expect(await turnHookExposureOff({ stateDir, execute, funnelTarget: () => 8080 })).toEqual({ changed: false, reason: 'not-ours' });
    expect(commands).toEqual([]);
    expect(await turnHookExposureOff({ stateDir, execute, funnelTarget: () => 31481 })).toEqual({ changed: true, reason: 'funnel-targets-hook-ingress' });
    expect(await turnHookExposureOff({ stateDir, execute, funnelTarget: () => null }, { force: true })).toEqual({ changed: true, reason: 'forced' });
    expect(commands).toEqual([hookExposurePlan().off, hookExposurePlan().off]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('serve shutdown closes a recorded exposure before the ingress, under the exposure lock', async () => {
  const stateDir = root();
  const order: string[] = [];
  const execute = (_binary: string, args: readonly string[]) => { order.push(`tailscale ${args.at(-1)}`); };
  try {
    await closeIngressAndExposure({ stop: () => order.push('ingress stop') }, { stateDir, execute, funnelTarget: () => null });
    expect(order).toEqual(['ingress stop']);
    order.length = 0;
    mkdirSync(join(stateDir, 'hooks'), { recursive: true });
    writeFileSync(join(stateDir, 'hooks', 'exposure.json'), JSON.stringify({ path: '/hooks/linear', decisionId: 'D-20261003-01', openedAt: '2026-10-03T00:00:00.000Z' }));
    await closeIngressAndExposure({ stop: () => order.push('ingress stop') }, { stateDir, execute, funnelTarget: () => null });
    expect(order).toEqual(['tailscale off', 'ingress stop']);
    expect(hookExposureStatus({ stateDir })).toBeNull();
    order.length = 0;
    writeFileSync(join(stateDir, 'hooks', 'exposure.json'), JSON.stringify({ path: '/hooks/linear', decisionId: 'D-20261003-01', openedAt: '2026-10-03T00:00:00.000Z' }));
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: unknown) => { errors.push(String(message)); };
    try {
      await closeIngressAndExposure({ stop: () => order.push('ingress stop') }, { stateDir, execute: () => { throw new Error('tailscale down'); }, funnelTarget: () => null });
    } finally { console.error = original; }
    expect(order).toEqual(['ingress stop']);
    expect(errors.join('\n')).toContain('public exposure may still be open');
    expect(hookExposureStatus({ stateDir })?.decisionId).toBe('D-20261003-01');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('funnel status parsing finds the loopback port behind 8443 only', () => {
  expect(parseFunnelTarget(JSON.stringify({ Web: { 'host.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:31481' } } } } }))).toBe(31481);
  expect(parseFunnelTarget(JSON.stringify({ Web: { 'host.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:31481' } } } } }))).toBeNull();
  expect(parseFunnelTarget(JSON.stringify({ Web: { 'host.ts.net:8443': { Handlers: { '/': { Proxy: 'http://10.0.0.5:31481' } } } } }))).toBeNull();
  expect(parseFunnelTarget('not json')).toBeNull();
  expect(parseFunnelTarget('{}')).toBeNull();
});

test('a lock left by a dead process is taken over (portable mkdir lock — no flock binary needed)', async () => {
  const stateDir = root();
  try {
    const lock = join(stateDir, 'hooks', 'exposure.lock.d');
    mkdirSync(lock, { recursive: true });
    const dead = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(String(process.pid))']);
    writeFileSync(join(lock, 'owner'), dead.stdout.toString());
    const commands: string[] = [];
    expect(await turnHookExposureOff({ stateDir, execute: (_b, args) => { commands.push(String(args.at(-1))); }, funnelTarget: () => 31481 }))
      .toEqual({ changed: true, reason: 'funnel-targets-hook-ingress' });
    expect(commands).toEqual(['off']);
    expect(existsSync(lock)).toBe(false);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
