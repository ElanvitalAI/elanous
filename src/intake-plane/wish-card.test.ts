import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { createNexusState } from '../nexus/state/state.js';
import { TabRegistry } from '../nexus/state/tab-registry.js';
import { NexusEventBus } from '../nexus/api/event-bus.js';
import { startNexusHttpServer } from '../nexus/api/http-server.js';
import { createWishCard, replySection } from './wish-card.js';
import { recordWishBenchmarkSample, wishBenchmarkLedgerPath } from './wish-benchmark-ledger.js';

const roots: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;
function isolatedWishRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  return root;
}
afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('new Telegram wish creates the canonical card and intake section; retry and other sources stay distinct', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-card-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  try {
    const text = `${'가'.repeat(85)}\n뒤의 본문`;
    const first = createWishCard({ text, source: 'telegram', ref: '42:7' }, store);
    expect(first).toEqual({ cardId: expect.any(String), title: '가'.repeat(80), created: true });
    const card = store.getCard(first.cardId)!;
    expect(card.goalId).toBe('wish:telegram:42:7');
    expect(card.sections.map((section) => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
    expect(card.sections[0]).toMatchObject({ key: 'intake:wish:0', owner: 'steward' });
    expect(JSON.parse(card.sections[0]!.content)).toEqual({
      source: 'telegram', ref: '42:7', replyTo: { surface: 'telegram', chatId: '42' }, title: '가'.repeat(80), text, at: expect.any(String),
    });
    const ledger = wishBenchmarkLedgerPath(root);
    const originalSample = JSON.parse(readFileSync(ledger, 'utf8').trim());
    expect(originalSample).toEqual({ id: first.cardId, at: expect.any(String), surface: 'telegram', text, chars: Array.from(text).length, op_cells: [], note: 'wish-card' });
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    const dir = join(root, 'bench');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const second = createWishCard({ text: '다른 글', source: 'telegram', ref: '42:7' }, store);
    expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(ledger, 'utf8')).not.toContain('다른 글');
    expect(second).toEqual({ cardId: first.cardId, title: first.title, created: false });
    expect(store.getCard(first.cardId)?.sections).toEqual(card.sections);
    expect(store.listCards()).toHaveLength(1);
    expect(JSON.parse(readFileSync(ledger, 'utf8').trim()).text).toBe(text);
    expect(createWishCard({ text: 'PWA 소원', source: 'pwa', ref: '42:7', replyTo: { surface: 'pwa', sessionId: 'session-7' } }, store).created).toBe(true);
    expect(store.listCards()).toHaveLength(2);
    const group = createWishCard({ text: '그룹 요청', source: 'telegram', ref: '-10042:8', replyTo: { surface: 'telegram', chatId: '-10042', threadId: '5' } }, store);
    expect(JSON.parse(store.getCard(group.cardId)!.sections[0]!.content).replyTo).toEqual({ surface: 'telegram', chatId: '-10042', threadId: '5' });
  } finally { store.close(); }
});

test('private ledger keeps existing shared state root permissions while protecting dedicated descendants', () => {
  const root = isolatedWishRoot('wish-shared-state-');
  chmodSync(root, 0o755);
  const originalMode = statSync(root).mode & 0o777;
  recordWishBenchmarkSample({ cardId: 'shared-root', at: '2026-01-01T00:00:00Z', surface: 'tui', text: 'private body' });
  expect(statSync(root).mode & 0o777).toBe(originalMode);
  expect(statSync(join(root, 'bench')).mode & 0o777).toBe(0o700);
  expect(statSync(wishBenchmarkLedgerPath(root)).mode & 0o777).toBe(0o600);
});

test('private ledger refuses symlinked parent components without writing the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-ledger-link-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const target = join(root, 'checkout');
  mkdirSync(target);
  writeFileSync(join(target, '.git'), 'checkout marker');
  symlinkSync(target, join(root, 'bench'));
  const sample = { cardId: 'link', at: new Date().toISOString(), surface: 'tui', text: 'private body' };
  expect(() => recordWishBenchmarkSample(sample)).toThrow('Unsafe wish benchmark directory');
  expect(() => readFileSync(join(target, 'goal-bench-requirements.jsonl'))).toThrow();
  rmSync(join(root, 'bench'));
  rmSync(target, { recursive: true });
  symlinkSync(join(root, 'checkout'), join(root, 'state-link'));
  process.env.ELANOUS_STATE_DIR = join(root, 'state-link');
  expect(() => recordWishBenchmarkSample(sample)).toThrow('Unsafe wish benchmark directory');
  expect(existsSync(join(root, 'checkout', 'bench'))).toBe(false);
});

test('two processes recording the same card append exactly one private sample', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-ledger-race-'));
  roots.push(root);
  const modulePath = join(import.meta.dir, 'wish-benchmark-ledger.ts');
  const child = () => new Promise<void>((resolve, reject) => {
    const processChild = spawn(process.execPath, ['-e', `import { recordWishBenchmarkSample } from ${JSON.stringify(modulePath)}; recordWishBenchmarkSample({ cardId: 'shared', at: '2026-01-01T00:00:00Z', surface: 'tui', text: 'private body' });`], {
      env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: 'ignore',
    });
    processChild.once('error', reject);
    processChild.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`sample writer exited ${code}`)));
  });
  await Promise.all(Array.from({ length: 8 }, child));
  expect(readFileSync(wishBenchmarkLedgerPath(root), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('killed ledger writer releases its lock while a live writer keeps other writers waiting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-ledger-kill-'));
  roots.push(root);
  const modulePath = join(import.meta.dir, 'wish-benchmark-ledger.ts');
  const holder = spawn(process.execPath, ['-e', `
    import { recordWishBenchmarkSample } from ${JSON.stringify(modulePath)};
    recordWishBenchmarkSample({ cardId: 'interrupted', at: '2026-01-01T00:00:00Z', surface: 'tui',
      text: { toJSON() { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); return 'never written'; } } });
  `], { env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout!.once('data', data => String(data).includes('locked') ? resolve() : reject(new Error('holder did not acquire lock')));
      holder.once('exit', code => reject(new Error(`holder exited before locking: ${code}`)));
    });
    const dir = join(root, 'bench');
    expect(statSync(join(dir, '.wish-cards.lock')).mode & 0o777).toBe(0o600);
    const contender = spawn(process.execPath, ['-e', `import { recordWishBenchmarkSample } from ${JSON.stringify(modulePath)}; recordWishBenchmarkSample({ cardId: 'after-kill', at: '2026-01-01T00:00:01Z', surface: 'pwa', text: 'original private body' });`], {
      env: { ...process.env, ELANOUS_STATE_DIR: root }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      let exited = false;
      const finished = new Promise<number | null>((resolve, reject) => {
        contender.once('error', reject);
        contender.once('exit', code => { exited = true; resolve(code); });
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(exited).toBe(false);
      expect(readFileSync(wishBenchmarkLedgerPath(root), 'utf8')).toBe('');
      holder.kill('SIGKILL');
      const code = await Promise.race([
        finished,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale ledger lock not recovered')), 2_000)),
      ]);
      expect(code).toBe(0);
      expect(readFileSync(wishBenchmarkLedgerPath(root), 'utf8').trim().split('\n').map(line => JSON.parse(line).id)).toEqual(['after-kill']);
    } finally { contender.kill('SIGKILL'); }
  } finally { holder.kill('SIGKILL'); }
});

test('TUI wish creates one card and one intake section across repeated requests with the same ref', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-tui-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  try {
    const input = { text: 'TUI 소원\n자세한 내용', source: 'tui' as const, ref: 'session:7' };
    const first = createWishCard(input, store);
    expect(first).toEqual({ cardId: expect.any(String), title: 'TUI 소원', created: true });
    const card = store.getCard(first.cardId)!;
    expect(card.goalId).toBe('wish:tui:session:7');
    expect(card.sections.map((section) => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
    expect(card.sections[0]).toMatchObject({ key: 'intake:wish:0', owner: 'steward' });
    expect(JSON.parse(card.sections[0]!.content)).toEqual({
      source: 'tui', ref: 'session:7', replyTo: { surface: 'tui' }, title: 'TUI 소원', text: input.text, at: expect.any(String),
    });
    const second = createWishCard(input, store);
    expect(second).toEqual({ cardId: first.cardId, title: first.title, created: false });
    expect(store.listCards()).toHaveLength(1);
    expect(store.getCard(first.cardId)?.sections).toEqual(card.sections);
  } finally { store.close(); }
});

test('retry restores a missing intake section after an interrupted create without duplicating the card', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-retry-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  const input = { text: '중단된 소원', source: 'telegram' as const, ref: '42:interrupt' };
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('interrupted'); });
  try {
    expect(() => createWishCard(input, store)).toThrow('interrupted');
    expect(store.listCards()).toHaveLength(1);
    expect(store.listCards()[0]?.sections).toHaveLength(0);
    append.mockRestore();
    const restartedStore = new CardStore(root);
    try {
      const result = createWishCard(input, restartedStore);
      expect(result).toMatchObject({ title: input.text, created: false });
      expect(restartedStore.listCards()).toHaveLength(1);
      expect(restartedStore.getCard(result.cardId)?.sections).toMatchObject([{ key: 'intake:wish:0', owner: 'steward' }, { key: 'intake:reply:0', owner: 'steward' }]);
      expect(createWishCard(input, restartedStore)).toEqual(result);
      expect(restartedStore.getCard(result.cardId)?.sections).toHaveLength(2);
    } finally { restartedStore.close(); }
  } finally { append.mockRestore(); store.close(); }
});

test('a retry with the same ref but a different text keeps the first title and records no contradicting body (review must-fix)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-mismatch-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('interrupted'); });
  try {
    expect(() => createWishCard({ text: '첫 소원', source: 'telegram', ref: '42:same' }, store)).toThrow('interrupted');
    append.mockRestore();
    const result = createWishCard({ text: '다른 소원', source: 'telegram', ref: '42:same' }, store);
    expect(result).toMatchObject({ title: '첫 소원', created: false });
    const section = JSON.parse(store.getCard(result.cardId)!.sections[0]!.content) as Record<string, unknown>;
    expect(section).toMatchObject({ title: '첫 소원', text: null, recovered: true, mismatch: true });
    expect(JSON.stringify(section)).not.toContain('다른 소원');
  } finally { append.mockRestore(); store.close(); }
});

test('POST /v1/task-cards/wish requires owner auth and yields 201/200/400 while GET stays readable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-http-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({
    state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'wish-token', noAuth: false },
    startPort: 47000 + Math.floor(Math.random() * 2000),
  });
  const headers = { authorization: 'Bearer wish-token', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' };
  const url = `${server.url}/v1/task-cards/wish`;
  try {
    const denied = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ text: 'no', ref: 'no' }) });
    expect(denied.status).toBe(401);
    const post = (text: string, ref: string) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ text, ref, sessionId: 'pwa-session-7' }) });
    const first = await post('새 소원', 's:123');
    expect(first.status).toBe(201);
    const card = await first.json() as { cardId: string; title: string; created: boolean };
    expect(card).toEqual({ cardId: expect.any(String), title: '새 소원', created: true });
    const retry = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: '다른 본문', ref: 's:123', sessionId: 'different-session' }) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ...card, created: false });
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: 'session missing', ref: 's:125' }) })).status).toBe(400);
    const empty = await post('   ', 's:124');
    expect(empty.status).toBe(400);
    expect((await fetch(`${server.url}/v1/task-cards`, { headers })).status).toBe(200);
    const store = new CardStore(root);
    try {
      expect(store.listCards()).toHaveLength(1);
      expect(store.getCard(card.cardId)?.goalId).toBe('wish:pwa:s:123');
      expect(JSON.parse(store.getCard(card.cardId)!.sections[0]!.content).replyTo).toEqual({ surface: 'pwa', sessionId: 'pwa-session-7' });
    } finally { store.close(); }
  } finally { server.stop(); }
});

test('a PWA or Linear ref alone cannot masquerade as a reply destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-target-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  try {
    expect(() => createWishCard({ text: '소원', source: 'pwa', ref: 'request-id' }, store)).toThrow('소원 회신 대상을 명시하세요');
    expect(() => createWishCard({ text: '소원', source: 'linear', ref: 'UX-2' }, store)).toThrow('소원 회신 대상을 명시하세요');
    expect(store.listCards()).toHaveLength(0);
  } finally { store.close(); }
});

test('empty wish rejects without creating cards', () => {
  const root = mkdtempSync(join(tmpdir(), 'wish-card-'));
  roots.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  const store = new CardStore(root);
  try {
    expect(() => createWishCard({ text: ' \n  ', source: 'pwa', ref: 'r', replyTo: { surface: 'pwa', sessionId: 'session-r' } }, store)).toThrow();
    expect(store.listCards()).toHaveLength(0);
  } finally { store.close(); }
});

// FLOW1 원장 약속(TC 21:15): 카드마다 `intake:reply:0 {surface, address}` 가 한 번만 붙는다.
test('wish card carries the agreed intake:reply:0 section once', () => {
  const root = isolatedWishRoot('wish-reply0-');
  const store = new CardStore(root);
  const { cardId } = createWishCard({ text: '회신 약속', source: 'pwa', ref: 'r1', replyTo: { surface: 'pwa', sessionId: 's-1' } }, store);
  createWishCard({ text: '회신 약속', source: 'pwa', ref: 'r1', replyTo: { surface: 'pwa', sessionId: 's-1' } }, store);
  const sections = store.getCard(cardId)!.sections.filter((section) => section.key === 'intake:reply:0');
  expect(sections).toHaveLength(1);
  expect(JSON.parse(sections[0]!.content)).toEqual({ surface: 'pwa', address: 's-1' });
  expect(replySection({ surface: 'telegram', chatId: '42', threadId: '7' })).toEqual({ surface: 'telegram', address: '42:7' });
  expect(replySection({ surface: 'tui' })).toEqual({ surface: 'tui', address: null });
  store.close();
});
