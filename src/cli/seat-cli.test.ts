import { expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleSeatQuickPath, assembleSeatTacitKnowledge, collectSeatBootSections, collectSeatLadderSections, registerSeatBootCommands, renderSeatBootCard, SEAT_QUICKSTART_MANUAL, SEAT_TRUST_LADDER } from './seat-cli.js';
import { LAST_SESSION_FILE } from '../dashboard/seat-local-instructions.js';
import { MsgStore } from '../msg/msg-store.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-'));
  const root = join(home, 'elanous-hq', 'seat-state', 'MK');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'HANDOFF.md'), '# Handoff title access_token=plainsecretvalue12345\nUpdated: 2026-10-12\n\naccess_token=ghp_0123456789abcdef0123456789abcdef0123\nrun `cat secret`\n');
  writeFileSync(join(root, 'inbox.md'), '# Inbox heading\nFrom: OP refresh_token: plainsecretvalue12345\nat: refresh_token: plainsecretvalue12345\n\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(root, 'harvest-claims.tsv'), 'pr\tclaimer\tat\tstatus\tnote\n#123\tTC\t2026-10-12\topen\taccess_token=ghp_0123456789abcdef0123456789abcdef0123\n');
  writeFileSync(join(root, 'scheduled.tsv'), 'at\twhat\tthen\thow\n09:00\tcheck\treport\tBearer abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(join(root, 'claims.jsonl'), '{"claim":"decoy","access_token":"ghp_0123456789abcdef0123456789abcdef0123"}\n');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'memory'), { recursive: true });
  writeFileSync(join(home, 'elanous-hq', 'seat-state', 'memory', 'MEMORY.md'), '# Memory index\n\nSensitive body\n');
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const error = spyOn(console, 'error').mockImplementation(() => {});
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({ facts: [{ kind: 'cell', id: 'cell-1', status: 'ready', owner: 'OP', version: 'v1', source: 'fixture', secret: 'access_token=ghp_0123456789abcdef0123456789abcdef0123' }], events: [{ at: 'now', kind: 'tick', source: 'events', summary: 'password=plainsecretvalue12345 Bearer abcdefghijklmnopqrstuvwxyz0123456789', body: 'do not show' }] }) });
  return { home, root, output, run: (...args: string[]) => cli.parseAsync(['seat', 'boot', ...args], { from: 'user' }), cleanup: () => { log.mockRestore(); error.mockRestore(); rmSync(home, { recursive: true, force: true }); } };
}

test('seat boot renders allowlisted context and file metadata without secret or body text', async () => {
  const f = fixture();
  try {
    await f.run('MK');
    const text = f.output.at(-1)!;
    expect(text).toContain('cell-1');
    expect(text).toContain('Handoff title');
    expect(text).toContain('From: OP');
    expect(text).not.toContain('From: OP refresh_token');
    expect(text).toContain('pr=#123');
    expect(text).toContain('what=check');
    expect(text).toContain('Memory index');
    expect(text).not.toContain('Sensitive body');
    expect(text).not.toContain('run `cat secret`');
    expect(text).not.toContain('access_token=ghp_0123456789abcdef0123456789abcdef0123');
    expect(text).not.toContain('plainsecretvalue12345');
    expect(text).toContain('access_token=***');
    expect(text).toContain('refresh_token: ***');
    expect(text).toContain('password=***');
    expect(text).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    expect(text).toContain('출처:');
    expect(text).toContain('갱신:');
    expect(text).not.toContain('decoy');
    expect(readFileSync(join(f.root, 'HANDOFF.md'), 'utf8')).toContain('access_token=');
  } finally { f.cleanup(); }
});

test('seat boot reads DM and ALL unread counts without creating or acknowledging messages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-msg-'));
  const msgPath = join(home, 'state', 'msg', 'messages.db');
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}), msgPath: () => msgPath });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).toContain('안 읽은 msg 미관측 (MK)');
    expect(existsSync(msgPath)).toBe(false);
    const store = new MsgStore(msgPath);
    try {
      store.post({ from: 'OP', to: 'MK', body: 'private-direct-body' });
      const broadcast = store.post({ from: 'OP', to: 'ALL', body: 'private-broadcast-body' });
      store.post({ from: 'MK', to: 'ALL', body: 'own-broadcast-body' });
      await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
      expect(output.at(-1)).toContain('안 읽은 msg 2 (MK)');
      expect(output.at(-1)).not.toContain('private-direct-body');
      expect(output.at(-1)).not.toContain('private-broadcast-body');
      expect(store.getCursor('MK')).toBe(0);
      store.ack('MK', broadcast.id);
      await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
      expect(output.at(-1)).toContain('안 읽은 msg 0 (MK)');
      expect(store.getCursor('MK')).toBe(broadcast.id);
    } finally { store.close(); }
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

test('collectSeatBootSections — 안 읽은 우편 수·자리·HANDOFF·예약·지난 세션을 카드에 담는다(공용 조립)', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-last-session-'));
  const seatState = join(home, 'elanous-hq', 'seat-state', 'OP');
  const seatWork = join(home, 'elanous-hq', 'seats', 'OP');
  mkdirSync(seatState, { recursive: true });
  mkdirSync(seatWork, { recursive: true });
  writeFileSync(join(seatState, 'HANDOFF.md'), '# OP 인계 문서\n');
  writeFileSync(join(seatWork, 'AGENTS.local.md'), '역할 = 그림자 OP · 판정 제안\n비밀 본문은 카드에 복사하지 않는다\n');
  writeFileSync(join(seatState, 'scheduled.tsv'), 'at\twhat\tthen\n09:00\tcheck\tdashboard\n');
  writeFileSync(join(seatWork, LAST_SESSION_FILE), '## 지난 세션 (TUI 가 대화 끝마다 갈아 쓴다 · 사람이 고치지 않는 파일)\n- 끝: 2026-10-18T09:00:00.000Z · exit · 사람 턴 1\n- 마지막 요청: 세션 정리해줘\n- 마지막 답 요지: 정리했다. 다음 점검 10:30 에 깨운다\n- 열린 일: 정리했다. 다음 점검 10:30 에 깨운다\n- 다음 점검 시각(답에서): 10:30\n');
  const msgPath = join(home, 'state', 'msg', 'messages.db');
  const store = new MsgStore(msgPath);
  try {
    store.post({ from: 'TC', to: 'OP', body: 'private-dm-body-stays-out' });
    store.post({ from: 'TC', to: 'ALL', body: 'private-broadcast-body-stays-out' });
    const { sections, unread } = collectSeatBootSections('OP', { home, msgPath });
    expect(unread).toBe(2);
    const card = renderSeatBootCard('OP', sections, null);
    expect(card).toContain('# OP 자리 부팅 카드');
    expect(card).toContain('안 읽은 msg 2 (OP)');
    expect(card).toContain('## 자리 역할');
    expect(card).toContain('역할: 그림자 OP · 판정 제안');
    expect(card).not.toContain('비밀 본문은 카드에 복사하지 않는다');
    expect(card).toContain('## HANDOFF');
    expect(card).toContain('## 예약');
    expect(card).toContain('## 지난 세션');
    expect(card).toContain('마지막 요청: 세션 정리해줘');
    expect(card).toContain('열린 일: 정리했다. 다음 점검 10:30 에 깨운다');
    expect(card).not.toContain('private-dm-body-stays-out');
    expect(card).not.toContain('private-broadcast-body-stays-out');
  } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('seat boot does not follow a linked seat directory outside the seat-state root', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-linked-'));
  const root = join(home, 'elanous-hq', 'seat-state');
  const outside = mkdtempSync(join(tmpdir(), 'seat-boot-outside-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(outside, 'HANDOFF.md'), '# Outside private heading\n');
  symlinkSync(outside, join(root, 'MK'));
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).not.toContain('Outside private heading');
    expect(output.at(-1)).toContain('미관측: 일반 경로가 아님');
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('seat boot does not follow a linked HQ ancestor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-linked-hq-'));
  const outside = mkdtempSync(join(tmpdir(), 'seat-boot-outside-hq-'));
  const outsideSeat = join(outside, 'seat-state', 'MK');
  mkdirSync(outsideSeat, { recursive: true });
  writeFileSync(join(outsideSeat, 'HANDOFF.md'), '# Outside HQ heading\n');
  symlinkSync(outside, join(home, 'elanous-hq'));
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).not.toContain('Outside HQ heading');
    expect(output.at(-1)).toContain('미관측: 일반 경로가 아님');
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('CLI entry writes the local boot card to stdout only', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-entry-'));
  const seatDir = join(home, 'elanous-hq', 'seat-state', 'MK');
  mkdirSync(seatDir, { recursive: true });
  writeFileSync(join(seatDir, 'HANDOFF.md'), '# Local handoff heading\n');
  try {
    const run = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'seat', 'boot', 'MK'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new TextDecoder().decode(run.stdout);
    const stderr = new TextDecoder().decode(run.stderr);
    expect(run.exitCode).toBe(0);
    expect(stdout).toContain('Local handoff heading');
    expect(stderr).toBe('');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);

test('seat boot marks absent sources as unobserved and rejects non-seat values', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-empty-'));
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const error = spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
  const prior = process.exitCode;
  process.exitCode = 0;
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}) });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).toContain('미관측: 파일 없음');
    await cli.parseAsync(['seat', 'boot', 'NOPE'], { from: 'user' });
    expect(errors.at(-1)).toContain('unknown seat');
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = prior ?? 0; log.mockRestore(); error.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

const MANUAL = [
  '# MANUAL',
  '## 0. 세 줄 원칙',
  '| 하려는 것 | 명령 | ⛔ 하지 말 것 |',
  '## 1. 무엇을 하려면 → 명령',
  '| 하려는 것 | 명령 | ⛔ 하지 말 것 |',
  '|---|---|---|',
  '| 받은 메시지 보기 | `eln msg list --to <자리>` · ⚠️ codex·elanous 세션은 **스스로 안 깨어난다** — `tmux.target` 등록 | Claude Monitor 를 가정 |',
  '| 시뮬 기록 | `sim-log.sh <S1|S2> <pass|fail>` | 원장에 안 적기 |',
  '| 착지 | `eln pr land --pr <N>` · `… --dry-run` | `gh pr merge` 직접 |',
  '## 2. 막히면',
  '| 묻기 | `eln msg post` | 손으로 |',
].join('\n');

test('L1 assembles the «무엇→명령» quick path and keeps agent notes only for the named agents', () => {
  const codex = assembleSeatQuickPath(MANUAL, 'codex');
  expect(codex).toEqual([
    '받은 메시지 보기 → eln msg list --to <자리> · ⚠️ codex·elanous 세션은 스스로 안 깨어난다 — tmux.target 등록 ⛔ Claude Monitor 를 가정',
    '시뮬 기록 → sim-log.sh <S1|S2> <pass|fail> ⛔ 원장에 안 적기',
    '착지 → eln pr land --pr <N> · … --dry-run ⛔ `gh pr merge` 직접',
  ]);
  expect(assembleSeatQuickPath(MANUAL, 'elanous')[0]).toContain('스스로 안 깨어난다');
  expect(assembleSeatQuickPath(MANUAL, 'claude')[0]).toBe('받은 메시지 보기 → eln msg list --to <자리> ⛔ Claude Monitor 를 가정');
  expect(assembleSeatQuickPath('# 표 없음\n| a | `b` | c |', 'codex')).toEqual([]);
});

const card = (n: number, verified: string, status = 'active') => `## K-MK-${String(n).padStart(2, '0')} 항목 ${n}${n === 3 ? ' codex 함정' : ''}\n- 상태: ${status}\n- 검증: ${verified}\n`;

test('L3 orders visible seat KNOWHOW before top-N memories (지시>코드>문서>기억), each ranked by recency then hits', () => {
  const knowhow = ['# MK KNOWHOW', card(1, '2026-10-01 참'), card(2, '2026-10-10 참'), card(3, '2026-10-10 참'), card(4, '2026-10-12 참', 'superseded-by K-MK-05'), card(5, '2026-10-02 못잼', 'unproven')].join('\n');
  const rows = assembleSeatTacitKnowledge({
    seat: 'MK', agent: 'codex', knowhow, now: new Date('2026-10-15T00:00:00Z'), limit: 3,
    memories: [
      { title: '옛 기억', hook: '오래됨', updated: '2026-09-01T00:00:00Z' },
      { title: '오늘 일반', hook: '무관', updated: '2026-10-14T01:00:00Z' },
      { title: '오늘 codex', hook: 'MK 자리 함정', updated: '2026-10-14T00:00:00Z' },
      { title: '어제', hook: '', updated: '2026-10-13T00:00:00Z' },
    ],
  });
  expect(rows).toEqual([
    SEAT_TRUST_LADDER,
    '[문서] K-MK-03 항목 3 codex 함정',
    '[문서] K-MK-02 항목 2',
    '[문서·검증 안 됨] K-MK-05 항목 5',
    '[문서] K-MK-01 항목 1',
    '[기억] 오늘 codex — MK 자리 함정 (갱신 2026-10-14)',
    '[기억] 오늘 일반 — 무관 (갱신 2026-10-14)',
    '[기억] 어제 (갱신 2026-10-13)',
  ]);
  expect(SEAT_TRUST_LADDER).toContain('지시 > 코드 > 문서 > 기억');
  expect(assembleSeatTacitKnowledge({ seat: 'MK', agent: 'claude', knowhow: '', memories: [], now: new Date() })).toEqual([SEAT_TRUST_LADDER]);
});

test('L3 includes KNOWHOW advice and keeps top memories visible when KNOWHOW exceeds the card budget', async () => {
  const now = new Date('2026-10-15T00:00:00Z');
  const make = (advice: string) => ['# MK KNOWHOW', ...Array.from({ length: 20 }, (_, i) =>
    `${card(i + 1, '2026-10-10 참')}- 처방(힐링): 먼저 로그를 본다\n- 재는 명령: ${i === 0 ? advice : `조치 ${i + 1}`}\n`)].join('\n');
  const memories = Array.from({ length: 5 }, (_, i) => ({ title: `기억 ${i + 1}`, hook: `명령 ${i + 1}`, updated: '2026-10-11T00:00:00Z' }));
  const rows = assembleSeatTacitKnowledge({ seat: 'MK', agent: 'codex', knowhow: make('원격 게이트부터 재측정'), memories, now });
  const changed = assembleSeatTacitKnowledge({ seat: 'MK', agent: 'codex', knowhow: make('로컬 게이트부터 재측정'), memories, now });
  expect(rows.filter(row => /^\[문서(?:·검증 안 됨)?\] K-MK-/.test(row))).toHaveLength(5);
  expect(rows).toContain('[문서] 나머지 15항목은 원문 KNOWHOW 참고');
  expect(rows.filter(row => row.startsWith('[기억]'))).toHaveLength(5);
  expect(rows.some(row => row.includes('먼저 로그를 본다'))).toBe(true);
  expect(rows.some(row => row.includes('원격 게이트부터 재측정'))).toBe(true);
  expect(changed.some(row => row.includes('로컬 게이트부터 재측정'))).toBe(true);
  const rendered = renderSeatBootCard('MK', [{ title: 'L3 암묵지', source: 'fixture', updated: '2026-10-15', rows }], null);
  expect(rendered).toContain('원격 게이트부터 재측정');
  expect(rendered).toContain('[기억] 기억 5');

  // The actual Commander boot path renders every L3 row; MAX_ROWS limits L0 metadata collection only.
  const home = mkdtempSync(join(tmpdir(), 'seat-ladder-many-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'seat-ladder-many-repo-'));
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  try {
    mkdirSync(join(repo, 'docs', 'roles', 'MK'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'), make('원격 게이트부터 재측정'));
    const memoryDir = join(home, 'elanous-hq', 'seat-state', 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), memories.map((entry, i) => `- [${entry.title}](memory-${i}.md) — ${entry.hook}`).join('\n'));
    for (let i = 0; i < memories.length; i++) {
      const path = join(memoryDir, `memory-${i}.md`);
      writeFileSync(path, 'memory detail\n');
      utimesSync(path, new Date(memories[i]!.updated), new Date(memories[i]!.updated));
    }
    const cli = new Command();
    registerSeatBootCommands(cli.command('seat'), { home: () => home, repoRoot: () => repo, contextNow: () => ({}), now: () => now });
    await cli.parseAsync(['seat', 'boot', 'MK', '--agent', 'codex'], { from: 'user' });
    const cardText = output.at(-1)!;
    expect(cardText).toContain('원격 게이트부터 재측정');
    expect(cardText).toContain('나머지 15항목은 원문 KNOWHOW 참고');
    expect(cardText.match(/^- \[기억\] 기억 /gm)).toHaveLength(5);
    expect(cardText.indexOf('[문서] K-MK-01')).toBeLessThan(cardText.indexOf('[기억] 기억 1'));
  } finally { log.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('L1 and L3 assemble rows from the repository manual and TC KNOWHOW', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-ladder-real-'));
  try {
    const repoRoot = join(import.meta.dir, '..', '..');
    const sections = collectSeatLadderSections('TC', 'codex', { home, repoRoot, now: new Date('2026-10-16T00:00:00Z') });
    expect(sections[0]!.rows.some(row => row.includes('→'))).toBe(true);
    expect(sections[1]!.rows.some(row => row.startsWith('[문서] K-TC-'))).toBe(true);
    expect(sections[1]!.rows.some(row => row.includes('↳') && row.includes('처방'))).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('seat boot --agent appends L1 and L3 after the L0 card; without --agent the card stays L0 only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-boot-ladder-'));
  const repo = mkdtempSync(join(tmpdir(), 'seat-boot-repo-'));
  mkdirSync(join(repo, 'docs', 'manual'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'roles', 'MK'), { recursive: true });
  writeFileSync(join(repo, SEAT_QUICKSTART_MANUAL), MANUAL);
  writeFileSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'), card(2, '2026-10-10 참'));
  const memory = join(home, 'elanous-hq', 'seat-state', 'memory');
  mkdirSync(memory, { recursive: true });
  writeFileSync(join(memory, 'MEMORY.md'), '# Memory index\n- [사라진 기억](gone.md) — 깨진 링크\n- [착지 슬롯](land-slots.md) — 전 자리 합 2\n');
  writeFileSync(join(memory, 'land-slots.md'), 'body stays private\n');
  utimesSync(join(memory, 'land-slots.md'), new Date('2026-10-09T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
  const output: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => output.push(line));
  const error = spyOn(console, 'error').mockImplementation((line: string) => errors.push(line));
  const prior = process.exitCode;
  const cli = new Command();
  registerSeatBootCommands(cli.command('seat'), { home: () => home, contextNow: () => ({}), repoRoot: () => repo, now: () => new Date('2026-10-15T00:00:00Z') });
  try {
    await cli.parseAsync(['seat', 'boot', 'MK'], { from: 'user' });
    expect(output.at(-1)).toContain('## HANDOFF');
    expect(output.at(-1)).not.toContain('## L1');
    await cli.parseAsync(['seat', 'boot', 'MK', '--agent', 'claude'], { from: 'user' });
    const text = output.at(-1)!;
    expect(text.indexOf('## 공통 메모리 색인')).toBeLessThan(text.indexOf('## L1 빠른 길 (claude)'));
    expect(text.indexOf('## L1 빠른 길 (claude)')).toBeLessThan(text.indexOf('## L3 암묵지 (claude)'));
    expect(text).toContain('- 착지 → eln pr land --pr <N>');
    expect(text).not.toContain('스스로 안 깨어난다');
    expect(text).toContain(`- ${SEAT_TRUST_LADDER}`);
    expect(text).toContain('- [문서] K-MK-02 항목 2');
    expect(text).toContain('- [기억] 착지 슬롯 — 전 자리 합 2 (갱신 2026-10-09)');
    expect(text).not.toContain('사라진 기억');
    expect(text).not.toContain('body stays private');
    await cli.parseAsync(['seat', 'boot', 'MK', '--agent', 'codex'], { from: 'user' });
    expect(output.at(-1)).toContain('스스로 안 깨어난다');
    process.exitCode = 0;
    await cli.parseAsync(['seat', 'boot', 'MK', '--agent', 'gemini'], { from: 'user' });
    expect(errors.at(-1)).toContain('unknown agent');
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = prior ?? 0; log.mockRestore(); error.mockRestore(); rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('L3 marks a missing KNOWHOW and a missing memory index as 미관측 instead of showing only the trust ladder', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-ladder-absent-'));
  const repo = mkdtempSync(join(tmpdir(), 'seat-ladder-repo-'));
  const l3 = () => collectSeatLadderSections('MK', 'codex', { home, repoRoot: repo, now: new Date('2026-10-15T00:00:00Z') }).find(section => section.title.startsWith('L3'))!.rows;
  try {
    expect(l3()).toEqual([SEAT_TRUST_LADDER, '미관측: KNOWHOW 파일 없음', '미관측: 기억 색인 파일 없음']);
    mkdirSync(join(repo, 'docs', 'roles', 'MK'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'), card(2, '2026-10-10 참'));
    expect(l3()).toEqual([SEAT_TRUST_LADDER, '[문서] K-MK-02 항목 2', '미관측: 기억 색인 파일 없음']);
    const memory = join(home, 'elanous-hq', 'seat-state', 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory index\n- [사라진 기억](gone.md) — 깨진 링크\n');
    expect(l3()).toEqual([SEAT_TRUST_LADDER, '[문서] K-MK-02 항목 2', '미관측: 기억 색인에 읽을 항목 없음']);
    writeFileSync(join(memory, 'MEMORY.md'), '- [착지 슬롯](land-slots.md) — 전 자리 합 2\n');
    writeFileSync(join(memory, 'land-slots.md'), 'body\n');
    utimesSync(join(memory, 'land-slots.md'), new Date('2026-10-09T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
    writeFileSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'), '# MK KNOWHOW\n');
    expect(l3()).toEqual([SEAT_TRUST_LADDER, '미관측: KNOWHOW 에 읽을 항목 없음', '[기억] 착지 슬롯 — 전 자리 합 2 (갱신 2026-10-09)']);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test('L1·L3 read the manual and KNOWHOW inside the repo but not through a link that leaves the repo', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-ladder-link-'));
  const repo = mkdtempSync(join(tmpdir(), 'seat-ladder-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'seat-ladder-outside-'));
  const sections = () => collectSeatLadderSections('MK', 'claude', { home, repoRoot: repo, now: new Date('2026-10-15T00:00:00Z') });
  try {
    mkdirSync(join(repo, 'docs', 'manual'), { recursive: true });
    mkdirSync(join(repo, 'docs', 'roles', 'MK'), { recursive: true });
    writeFileSync(join(outside, 'manual.md'), MANUAL.replace('착지', '바깥 착지'));
    writeFileSync(join(outside, 'KNOWHOW.md'), card(1, '2026-10-10 바깥'));
    symlinkSync(join(outside, 'manual.md'), join(repo, SEAT_QUICKSTART_MANUAL));
    symlinkSync(join(outside, 'KNOWHOW.md'), join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'));
    const [linkedL1, linkedL3] = sections();
    expect(linkedL1!.rows).toEqual([]);
    expect(linkedL1!.reason).toBe('미관측: 파일 없음');
    expect(linkedL3!.rows).toContain('미관측: KNOWHOW 파일 없음');
    expect(JSON.stringify([linkedL1, linkedL3])).not.toContain('바깥');
    rmSync(join(repo, SEAT_QUICKSTART_MANUAL));
    rmSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'));
    writeFileSync(join(repo, SEAT_QUICKSTART_MANUAL), MANUAL);
    writeFileSync(join(repo, 'docs', 'roles', 'MK', 'KNOWHOW.md'), card(2, '2026-10-10 참'));
    const [l1, l3] = sections();
    expect(l1!.rows).toContain('착지 → eln pr land --pr <N> · … --dry-run ⛔ `gh pr merge` 직접');
    expect(l3!.rows).toContain('[문서] K-MK-02 항목 2');
  } finally { for (const dir of [home, repo, outside]) rmSync(dir, { recursive: true, force: true }); }
});
