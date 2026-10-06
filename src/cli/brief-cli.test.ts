import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriefItemsLedger } from '../briefing/brief-items.js';
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'brief-cli-'));
  const output: string[] = [];
  const errors: string[] = [];
  const exit = process.exitCode;
  process.exitCode = 0;
  const program = new FakeCommand('root');
  const ledger = new BriefItemsLedger({ stateDir: root, now: () => new Date('2026-10-05T00:00:00Z'), log: () => {} });
  registerBriefCommands(program as unknown as Parameters<typeof registerBriefCommands>[0], {
    ledger,
    output: (line) => { output.push(line); },
    error: (line) => { errors.push(line); },
  });
  const brief = program.children.find(child => child.name === 'brief');
  const run = (verb: string, opts: Record<string, string | boolean | undefined>) => {
    const command = brief?.children.find(child => child.name === verb);
    if (!command?.handler) throw new Error(`missing brief ${verb}`);
    command.handler(opts);
  };
  return {
    root, ledger, run, output, errors, brief,
    cleanup: () => { process.exitCode = exit; rmSync(root, { recursive: true, force: true }); },
  };
}

test('brief add|list|compose: five items, P0 first, one duplicate, three domain heads, later slot item omitted', () => {
  const f = fixture();
  try {
    expect(f.brief?.children.map(child => child.name)).toEqual(['add', 'list', 'compose']);
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
