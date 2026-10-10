import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriefItemsLedger, BRIEF_REACTIONS } from '../briefing/brief-items.js';
import { registerBriefCommands } from './brief-cli.js';

type Handler = (opts: Record<string, string | boolean | undefined>) => void;

class FakeCommand {
  readonly children: FakeCommand[] = [];
  readonly opts: Record<string, { required: boolean }> = {};
  handler: Handler | undefined;
  constructor(readonly name: string) {}
  description(): this { return this; }
  requiredOption(flags: string): this { return this.remember(flags, true); }
  option(flags: string): this { return this.remember(flags, false); }
  action(fn: Handler): this { this.handler = fn; return this; }
  command(name: string): FakeCommand {
    const child = new FakeCommand(name);
    this.children.push(child);
    return child;
  }
  private remember(flags: string, required: boolean): this {
    const flag = flags.split(' ')[0]?.replace(/^--/, '') ?? flags;
    this.opts[flag] = { required };
    return this;
  }
}

function fixture(options: { now?: () => Date; send?: (markdown: string) => number | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brief-cli-'));
  const output: string[] = [];
  const errors: string[] = [];
  const exit = process.exitCode;
  process.exitCode = 0;
  const program = new FakeCommand('root');
  const ledger = new BriefItemsLedger({ stateDir: root, now: options.now ?? (() => new Date('2026-10-05T00:00:00Z')), log: () => {} });
  registerBriefCommands(program as unknown as Parameters<typeof registerBriefCommands>[0], {
    ledger,
    ...(options.send ? { send: options.send } : {}),
    output: (line) => { output.push(line); },
    error: (line) => { errors.push(line); },
  });
  const brief = program.children.find(child => child.name === 'brief');
  const run = (verb: string, opts: Record<string, string | boolean | undefined>) => {
    const command = verb === '' ? brief : brief?.children.find(child => child.name === verb);
    if (!command?.handler) throw new Error(`missing brief ${verb}`);
    command.handler(opts);
  };
  return {
    root, ledger, run, output, errors, brief,
    cleanup: () => { process.exitCode = exit; rmSync(root, { recursive: true, force: true }); },
  };
}

test('bare brief prints exactly one weekly acted/sent line, leaving subcommands and item state unchanged', () => {
  const f = fixture();
  try {
    const empty = f.output.length;
    f.run('', {});
    expect(f.output.slice(empty)).toEqual(['이번 주 브리핑 중 대표가 움직인 것 0/0']);
    const acted = f.ledger.add({ text: '결정', domain: '판', priority: 'P0', source: 'test' });
    const ignored = f.ledger.add({ text: '읽음', domain: '시장', priority: 'P1', source: 'test' });
    f.ledger.add({ text: '미발송', domain: '운영', priority: 'P1', source: 'test' });
    f.ledger.markSent([acted.id, ignored.id], '08:30');
    f.ledger.recordReaction(acted.id, '버튼');
    f.ledger.recordReaction(acted.id, '정정');
    f.ledger.recordReaction(ignored.id, '열람');
    const before = f.ledger.list();
    const lines = f.output.length;
    f.run('', {});
    expect(f.output.slice(lines)).toEqual(['이번 주 브리핑 중 대표가 움직인 것 1/2']);
    expect(f.ledger.list()).toEqual(before);
    f.run('list', { json: true });
    expect(JSON.parse(f.output.at(-1)!)).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

test('brief react records all five reactions on sent items through the CLI and keeps weekly action counts distinct', () => {
  const f = fixture();
  try {
    expect(f.brief?.children.find(child => child.name === 'react')?.opts).toMatchObject({
      'item-id': { required: true }, reaction: { required: true },
    });
    const item = f.ledger.add({ text: '원장 응답', domain: '판', priority: 'P0', source: 'test' });
    const unsent = f.ledger.add({ text: '미발송', domain: '시장', priority: 'P1', source: 'test' });
    const before = f.ledger.list();
    f.run('react', { itemId: String(unsent.id), reaction: '버튼' });
    expect(f.errors.at(-1)).toBe('brief react: item was not sent');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    f.ledger.markSent([item.id], '08:30');
    for (const reaction of BRIEF_REACTIONS) f.run('react', { itemId: String(item.id), reaction });
    expect(f.output.slice(-BRIEF_REACTIONS.length)).toEqual(BRIEF_REACTIONS.map(reaction => `reacted ${item.id} ${reaction}`));
    const db = new Database(f.ledger.path);
    try {
      expect(db.query('SELECT item_id, reaction FROM reactions ORDER BY id').all()).toEqual(
        BRIEF_REACTIONS.map(reaction => ({ item_id: item.id, reaction })),
      );
    } finally { db.close(); }
    f.run('', {});
    expect(f.output.at(-1)).toBe('이번 주 브리핑 중 대표가 움직인 것 1/1');
    expect(f.ledger.list()).toEqual(before.map(row => row.id === item.id ? { ...row, sent_at: '2026-10-05T00:00:00.000Z' } : row));
    f.run('react', { itemId: '1x', reaction: '버튼' });
    expect(f.errors.at(-1)).toBe('brief react: invalid item id');
    f.run('react', { itemId: String(item.id), reaction: 'unknown' });
    expect(f.errors.at(-1)).toBe('brief react: invalid reaction');
    f.run('react', { itemId: '999', reaction: '버튼' });
    expect(f.errors.at(-1)).toBe('brief react: item was not sent');
    expect(f.ledger.weeklyActions()).toMatchObject({ acted: 1, total: 1 });
  } finally { f.cleanup(); }
});

test('brief add|list|compose: five items, P0 first, one duplicate, three domain heads, later slot item omitted', () => {
  const f = fixture();
  try {
    expect(f.brief?.children.map(child => child.name)).toEqual(['add', 'react', 'list', 'compose', 'send']);
    expect(f.brief?.children[0]?.opts).toMatchObject({ text: { required: true }, domain: { required: true }, priority: { required: true }, source: { required: true }, deadline: { required: false } });
    const at = '2026-10-04T23:00:00Z';
    f.run('add', { text: '흡수 대기', domain: '흡수', priority: 'P1', source: '흡수', createdAt: at, json: true });
    const added = JSON.parse(f.output.at(-1)!) as { id: number; text: string };
    expect(added).toMatchObject({ id: 1, text: '흡수 대기', domain: '흡수', priority: 'P1', sent_at: null, created_at: at });
    f.run('add', { text: '판 컷 확인', domain: '판', priority: 'P1', source: '자리', createdAt: '2026-10-04T23:05:00Z' });
    f.run('add', { text: '시장 급변', domain: '시장', priority: 'P2', source: '루프', evidence: 'https://example.test/m', createdAt: '2026-10-04T23:10:00Z' });
    f.run('add', { text: '  흡수   대기 ', domain: '운영', priority: 'P2', source: '루프', createdAt: '2026-10-04T23:15:00Z' });
    f.run('add', { text: '오늘 결정', domain: '행정', priority: 'P0', source: '코나투스', deadline: '2026-10-06', createdAt: '2026-10-04T23:20:00Z' });
    const db = new BriefItemsLedger({ stateDir: f.root, now: () => new Date('2026-10-05T00:00:00Z'), log: () => {} });
    db.add({ text: '슬롯 이후', domain: '운영', priority: 'P0', source: '루프', createdAt: '2026-10-04T23:30:00Z' });
    const before = f.ledger.list();
    f.run('list', { json: true });
    const listed = JSON.parse(f.output.at(-1)!) as Array<{ text: string }>;
    expect(listed).toHaveLength(6);
    expect(listed[0]?.text).toBe('흡수 대기');
    expect(listed[3]?.text).toBe('  흡수   대기 ');
    f.run('list', { domain: '행정' });
    expect(f.output.at(-1)).toContain('오늘 결정');
    const composedAt = f.output.length;
    f.run('compose', { slot: '08:30' });
    const page = f.output.slice(composedAt).join('\n');
    const lines = page.split('\n');
    expect(lines[0]).toBe('# 브리핑 — 08:30');
    const body = lines.filter(line => line.startsWith('- '));
    expect(body[0]).toStartWith('- [P0] 오늘 결정');
    expect(page.split('흡수 대기').length - 1).toBe(1);
    expect(lines.filter(line => line.startsWith('## ') && line !== '## 결정이 필요한 것')).toEqual(['## 판', '## 흡수', '## 시장']);
    expect(page).not.toContain('슬롯 이후');
    expect(f.ledger.list()).toEqual(before);
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

const sendNow = () => new Date('2026-10-06T08:31:00+09:00');
const itemAt = '2026-10-06T07:00:00+09:00';

function addTwo(f: ReturnType<typeof fixture>): void {
  f.run('add', { text: '결정 필요', domain: '판', priority: 'P0', source: '자리', createdAt: itemAt });
  f.run('add', { text: '동향 원문', domain: '시장', priority: 'P1', source: '동향', createdAt: itemAt });
}

function listedSentAt(f: ReturnType<typeof fixture>): Array<string | null> {
  f.run('list', { json: true });
  return (JSON.parse(f.output.at(-1)!) as Array<{ sent_at: string | null }>).map(item => item.sent_at);
}

test('brief send delivers one page, marks composed ids only after message id 77, and skips the next send', () => {
  const sent: string[] = [];
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return 77; } });
  try {
    expect(f.brief?.children.find(child => child.name === 'send')?.opts).toMatchObject({ slot: { required: false }, realtime: { required: false }, 'dry-run': { required: false } });
    f.run('send', { slot: '08:30' });
    expect(f.output.at(-1)).toBe('(보낼 항목 없음)');
    expect(sent).toHaveLength(0);
    addTwo(f);
    f.run('compose', { slot: '08:30' });
    const composed = f.output.at(-1)!;
    expect(listedSentAt(f)).toEqual([null, null]);
    f.run('send', { slot: '08:30' });
    expect(sent).toEqual([composed]);
    expect(sent[0]).toContain('## 결정이 필요한 것');
    expect(sent[0]).toContain('결정 필요');
    expect(sent[0]).toContain('동향 원문');
    const sentAt = listedSentAt(f);
    expect(sentAt).toHaveLength(2);
    expect(sentAt.every(at => at !== null)).toBe(true);
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(1);
    expect(f.output.at(-1)).toBe('(보낼 항목 없음)');
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

test('brief send leaves both rows unsent on missing message id', () => {
  const sent: string[] = [];
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return null; } });
  try {
    addTwo(f);
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(listedSentAt(f)).toEqual([null, null]);
    expect(f.errors.at(-1)).toContain('brief send: 발송 실패');
  } finally { f.cleanup(); }
});

test('brief send does not mark rows for a nonpositive message id', () => {
  const f = fixture({ now: sendNow, send: () => 0 });
  try {
    addTwo(f);
    f.run('send', { slot: '08:30' });
    expect(process.exitCode).toBe(1);
    expect(listedSentAt(f)).toEqual([null, null]);
  } finally { f.cleanup(); }
});

test('brief send --dry-run prints the same single page without sending or marking', () => {
  const sent: string[] = [];
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return 77; } });
  try {
    addTwo(f);
    f.run('compose', { slot: '08:30' });
    const composed = f.output.at(-1)!;
    const before = f.output.length;
    f.run('send', { slot: '08:30', dryRun: true });
    expect(f.output.slice(before)).toEqual([composed]);
    expect(sent).toHaveLength(0);
    expect(listedSentAt(f)).toEqual([null, null]);
    expect(f.errors).toEqual([]);
  } finally { f.cleanup(); }
});

test('brief send validates slot and marks only ids actually printed after deduplication', () => {
  const sent: string[] = [];
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return 77; } });
  try {
    addTwo(f);
    f.run('add', { text: '  동향  원문  ', domain: '운영', priority: 'P2', source: '루프', createdAt: itemAt });
    f.run('send', { slot: 'invalid' });
    expect(process.exitCode).toBe(2);
    expect(sent).toHaveLength(0);
    process.exitCode = 0;
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('  동향  원문  ');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([true, true, false]);
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(1);
    expect(f.output.at(-1)).toBe('(보낼 항목 없음)');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([true, true, false]);
    f.run('add', { text: '동향 원문', domain: '시장', priority: 'P0', source: '새 출처', createdAt: itemAt });
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(1);
    expect(f.output.at(-1)).toBe('(보낼 항목 없음)');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([true, true, false, false]);
  } finally { f.cleanup(); }
});

test('brief send --realtime sends only urgent unsent rows once; failed sender leaves P0 for the next slot', () => {
  const sent: string[] = [];
  let succeeds = true;
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return succeeds ? 77 : null; } });
  try {
    addTwo(f);
    f.run('send', { realtime: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('결정 필요');
    expect(sent[0]).not.toContain('동향 원문');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([true, false]);
    const db = new Database(f.ledger.path);
    try {
      expect(db.query('SELECT item_id, slot FROM sends').all()).toEqual([{ item_id: 1, slot: 'realtime' }]);
    } finally { db.close(); }
    f.run('send', { realtime: true });
    expect(f.output.at(-1)).toBe('(보낼 항목 없음)');
    expect(sent).toHaveLength(1);
    f.run('send', { slot: '08:30' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('동향 원문');
    expect(sent[1]).not.toContain('결정 필요');

    f.run('add', { text: '재시도 P0', domain: '판', priority: 'P0', source: '자리', createdAt: itemAt });
    succeeds = false;
    f.run('send', { realtime: true });
    expect(f.errors.at(-1)).toContain('brief send: 발송 실패');
    expect(listedSentAt(f).at(-1)).toBeNull();
    const failedDb = new Database(f.ledger.path);
    try {
      expect(failedDb.query('SELECT COUNT(*) AS count FROM sends WHERE item_id = 3').get()).toEqual({ count: 0 });
    } finally { failedDb.close(); }
    succeeds = true;
    f.run('send', { slot: '08:30' });
    expect(sent.at(-1)).toContain('재시도 P0');
    expect(listedSentAt(f).every(at => at !== null)).toBe(true);
  } finally { f.cleanup(); }
});

test('brief add --priority P0 --send-now uses realtime delivery immediately and retains failed additions', () => {
  const sent: string[] = [];
  let succeeds = false;
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return succeeds ? 77 : null; } });
  try {
    f.run('add', { text: '일반', domain: '운영', priority: 'P1', source: '자리', createdAt: itemAt });
    f.run('add', { text: '즉시 결정', domain: '판', priority: 'P0', source: '자리', sendNow: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('즉시 결정');
    expect(sent[0]).not.toContain('일반');
    expect(f.errors.at(-1)).toContain('brief add: 발송 실패');
    expect(listedSentAt(f)).toEqual([null, null]);
    succeeds = true;
    f.run('send', { realtime: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('즉시 결정');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([false, true]);
    f.run('add', { text: '다음 즉시 결정', domain: '판', priority: 'P0', source: '자리', sendNow: true });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain('- [P0] 다음 즉시 결정 (');
    expect(sent[2]).not.toContain('- [P0] 즉시 결정 (');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([false, true, true]);
    const count = f.ledger.list().length;
    f.run('add', { text: '불가', domain: '판', priority: 'P1', source: '자리', sendNow: true });
    expect(f.ledger.list()).toHaveLength(count);
    expect(f.errors.at(-1)).toContain('--send-now requires --priority P0');
  } finally { f.cleanup(); }
});

test('brief send --realtime includes due-today P1 but not tomorrow KST; dry-run does not mark', () => {
  const sent: string[] = [];
  const f = fixture({ now: sendNow, send: markdown => { sent.push(markdown); return 77; } });
  try {
    f.run('add', { text: '오늘 마감', domain: '판', priority: 'P1', source: '자리', deadline: '2026-10-05T15:30:00Z' });
    f.run('add', { text: '내일 마감', domain: '판', priority: 'P1', source: '자리', deadline: '2026-10-06T15:00:00Z' });
    f.run('send', { realtime: true, dryRun: true });
    expect(f.output.at(-1)).toContain('오늘 마감');
    expect(f.output.at(-1)).not.toContain('내일 마감');
    expect(sent).toHaveLength(0);
    expect(listedSentAt(f)).toEqual([null, null]);
    f.run('send', { realtime: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('오늘 마감');
    expect(sent[0]).not.toContain('내일 마감');
    expect(listedSentAt(f).map(at => at !== null)).toEqual([true, false]);
    f.run('send', {});
    expect(f.errors.at(-1)).toContain('--slot is required unless --realtime');
    f.run('send', { realtime: true, slot: '08:30' });
    expect(f.errors.at(-1)).toContain('--realtime cannot be combined with --slot');
  } finally { f.cleanup(); }
});

test('concurrent brief send serializes across processes; a failed sender releases the ledger lock without marking', async () => {
  const f = fixture({ now: sendNow });
  try {
    addTwo(f);
    const marker = join(f.root, 'sending');
    const deliveries = join(f.root, 'deliveries');
    const worker = join(f.root, 'worker.ts');
    writeFileSync(worker, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { BriefItemsLedger } from ${JSON.stringify(join(import.meta.dir, '../briefing/brief-items.ts'))};
import { registerBriefCommands } from ${JSON.stringify(join(import.meta.dir, 'brief-cli.ts'))};
class Command {
  children = [];
  constructor(name) { this.name = name; }
  description() { return this; }
  requiredOption() { return this; }
  option() { return this; }
  action(fn) { this.handler = fn; return this; }
  command(name) { const child = new Command(name); this.children.push(child); return child; }
}
const [root, deliveries, marker, result] = process.argv.slice(2);
const command = new Command('root');
registerBriefCommands(command, {
  ledger: new BriefItemsLedger({ stateDir: root, now: () => new Date('2026-10-06T08:31:00+09:00'), log: () => {} }),
  send: () => {
    appendFileSync(deliveries, result + '\\n');
    if (result === 'first' || result === 'null') { writeFileSync(marker, 'ready'); Bun.sleepSync(500); }
    return result === 'null' ? null : 77;
  },
  output: line => console.log(line),
  error: line => console.error(line),
});
command.children[0].children.find(child => child.name === 'send').handler({ slot: '08:30' });
`);
    const spawn = (result: string) => Bun.spawn(['bun', 'run', worker, f.root, deliveries, marker, result], { stdout: 'pipe', stderr: 'pipe' });
    const first = spawn('first');
    for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(10);
    if (!existsSync(marker)) {
      first.kill();
      throw new Error(`worker did not start: ${await new Response(first.stderr).text()} ${await new Response(first.stdout).text()}`);
    }
    const second = spawn('second');
    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
    const secondOutput = await new Response(second.stdout).text();
    expect([firstExit, secondExit]).toEqual([0, 0]);
    expect(secondOutput.trim()).toBe('(보낼 항목 없음)');
    expect(readFileSync(deliveries, 'utf8').trim().split('\n')).toEqual(['first']);
    expect(listedSentAt(f).every(at => at !== null)).toBe(true);

    rmSync(marker);
    rmSync(deliveries);
    f.ledger.add({ text: '재시도 항목', domain: '운영', priority: 'P1', source: '자리', createdAt: itemAt });
    // Start the failing sender first; while it holds the lock the succeeding sender must wait.
    const failing = spawn('null');
    for (let i = 0; i < 200 && !existsSync(marker); i++) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    expect(listedSentAt(f).at(-1)).toBeNull();
    const succeeding = spawn('second');
    expect(await Promise.all([failing.exited, succeeding.exited])).toEqual([1, 0]);
    expect(readFileSync(deliveries, 'utf8').trim().split('\n')).toEqual(['null', 'second']);
    expect(listedSentAt(f).every(at => at !== null)).toBe(true);
  } finally { f.cleanup(); }
});

test('brief add and compose reject unknown domain, priority, and slot without writing', () => {
  const f = fixture();
  try {
    f.run('add', { text: 'x', domain: 'ops', priority: 'P0', source: '루프' });
    expect(f.errors.at(-1)).toBe('brief add: invalid domain');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    f.run('add', { text: 'x', domain: '운영', priority: 'high', source: '루프' });
    expect(f.errors.at(-1)).toBe('brief add: invalid priority');
    f.run('compose', { slot: 'morning' });
    expect(f.errors.at(-1)).toBe('brief compose: invalid slot');
    f.run('list', {});
    expect(f.output.at(-1)).toBe('(항목 없음)');
    expect(f.ledger.list()).toEqual([]);
  } finally { f.cleanup(); }
});
