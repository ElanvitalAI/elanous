import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';

setDefaultTimeout(60_000);
import { buildMsgHookOutput, seatFromCwd } from './msg-hook.js';

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-msg-hook-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const inbox = [
  { id: 11, from: 'MK', to: 'OP', kind: 'coord', body: '첫 줄\n나머지 본문' },
  { id: 14, from: 'TC', to: 'OP', body: '확인 요청' },
];

function sortSnapshotKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortSnapshotKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortSnapshotKeys(entry)]));
}

describe('msg turn hook output', () => {
  test('finds the seat from a seat worktree cwd and ignores non-seat directories', () => {
    expect(seatFromCwd('/Users/me/elanous-hq/seats/OP')).toBe('OP');
    expect(seatFromCwd('/Users/me/elanous-hq/seats/TC/tools')).toBe('TC');
    expect(seatFromCwd('/tmp/repo')).toBeNull();
    expect(seatFromCwd('/tmp/seats/OP')).toBeNull();
  });

  test('Claude prompt submit emits unread IDs, senders, first lines under hookSpecificOutput', () => {
    const output = buildMsgHookOutput({ event: 'user-prompt-submit', format: 'claude', cwd: '/repo/elanous-hq/seats/OP', sessionId: 's1', messages: inbox, stateDir: stateDir() });
    expect(JSON.parse(output!)).toEqual({ hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '📬 전달 완료: 미읽음 우편 2통 — 정본 eln msg list --to OP · 처리한 글 ID 하나씩 eln msg ack --to OP --id <id>\n- #11 MK→OP [coord] 첫 줄 나머지 본문\n- #14 TC→OP [] 확인 요청',
    } });
  });

  test('Codex session start uses its event name and Stop blocks once for a new bundle', () => {
    const dir = stateDir();
    const start = JSON.parse(buildMsgHookOutput({ event: 'session-start', format: 'codex', cwd: '/repo/elanous-hq/seats/UX', sessionId: 's2', messages: inbox, stateDir: dir })!);
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(buildMsgHookOutput({ event: 'session-start', format: 'codex', cwd: '/repo/elanous-hq/seats/UX', sessionId: 's2', messages: inbox, stateDir: dir })).toBeNull();
    const stop = JSON.parse(buildMsgHookOutput({ event: 'stop', format: 'codex', cwd: '/repo/elanous-hq/seats/UX', sessionId: 's3', messages: inbox, stateDir: dir })!);
    expect(stop).toEqual({ decision: 'block', reason: '새 우편 2통(#11, #14) — 처리 후 ack' });
    expect(buildMsgHookOutput({ event: 'stop', format: 'codex', cwd: '/repo/elanous-hq/seats/UX', sessionId: 's3', messages: inbox, stateDir: dir })).toBeNull();
    expect(buildMsgHookOutput({ event: 'session-start', format: 'codex', cwd: '/repo/elanous-hq/seats/UX', sessionId: 's2', messages: inbox, stateDir: dir })).toBeNull();
  });

  const outputSnapshot = (format: 'claude' | 'codex') => {
    const dir = stateDir();
    const render = (event: 'user-prompt-submit' | 'session-start' | 'stop') => JSON.parse(buildMsgHookOutput({
      event, format, cwd: '/repo/elanous-hq/seats/OP', sessionId: `${format}-${event}`, messages: inbox, stateDir: dir,
    })!);
    return { userPromptSubmit: render('user-prompt-submit'), sessionStart: render('session-start'), stop: render('stop') };
  };
  test('Claude hook output snapshot keeps additionalContext nested and Stop blocking', () => {
    const outputs = outputSnapshot('claude');
    expect(JSON.stringify(sortSnapshotKeys(outputs))).toMatchInlineSnapshot(`"{"sessionStart":{"hookSpecificOutput":{"additionalContext":"📬 전달 완료: 미읽음 우편 2통 — 정본 eln msg list --to OP · 처리한 글 ID 하나씩 eln msg ack --to OP --id <id>\\n- #11 MK→OP [coord] 첫 줄 나머지 본문\\n- #14 TC→OP [] 확인 요청","hookEventName":"SessionStart"}},"stop":{"decision":"block","reason":"새 우편 2통(#11, #14) — 처리 후 ack"},"userPromptSubmit":{"hookSpecificOutput":{"additionalContext":"📬 전달 완료: 미읽음 우편 2통 — 정본 eln msg list --to OP · 처리한 글 ID 하나씩 eln msg ack --to OP --id <id>\\n- #11 MK→OP [coord] 첫 줄 나머지 본문\\n- #14 TC→OP [] 확인 요청","hookEventName":"UserPromptSubmit"}}}"`);
    expect(Object.hasOwn(outputs.userPromptSubmit, 'additionalContext')).toBe(false);
    expect(Object.hasOwn(outputs.sessionStart, 'additionalContext')).toBe(false);
    expect(Object.hasOwn(outputs.stop, 'additionalContext')).toBe(false);
  });
  test('Codex hook output snapshot keeps additionalContext nested and Stop blocking', () => {
    const outputs = outputSnapshot('codex');
    expect(JSON.stringify(sortSnapshotKeys(outputs))).toMatchInlineSnapshot(`"{"sessionStart":{"hookSpecificOutput":{"additionalContext":"📬 전달 완료: 미읽음 우편 2통 — 정본 eln msg list --to OP · 처리한 글 ID 하나씩 eln msg ack --to OP --id <id>\\n- #11 MK→OP [coord] 첫 줄 나머지 본문\\n- #14 TC→OP [] 확인 요청","hookEventName":"SessionStart"}},"stop":{"decision":"block","reason":"새 우편 2통(#11, #14) — 처리 후 ack"},"userPromptSubmit":{"hookSpecificOutput":{"additionalContext":"📬 전달 완료: 미읽음 우편 2통 — 정본 eln msg list --to OP · 처리한 글 ID 하나씩 eln msg ack --to OP --id <id>\\n- #11 MK→OP [coord] 첫 줄 나머지 본문\\n- #14 TC→OP [] 확인 요청","hookEventName":"UserPromptSubmit"}}}"`);
    expect(Object.hasOwn(outputs.userPromptSubmit, 'additionalContext')).toBe(false);
    expect(Object.hasOwn(outputs.sessionStart, 'additionalContext')).toBe(false);
    expect(Object.hasOwn(outputs.stop, 'additionalContext')).toBe(false);
  });

  test('remembers every bundle and does not merge missing session IDs', () => {
    const dir = stateDir();
    const input = { event: 'user-prompt-submit' as const, format: 'claude' as const, cwd: '/repo', seat: 'OP', sessionId: 's4', stateDir: dir };
    const a = buildMsgHookOutput({ ...input, messages: [inbox[0]!] });
    const b = buildMsgHookOutput({ ...input, messages: [inbox[1]!] });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(buildMsgHookOutput({ ...input, messages: [inbox[0]!] })).toBeNull();
  });

  test('separate hook processes deliver one copy when invoked concurrently', async () => {
    const dir = stateDir();
    const hookModule = new URL('./msg-hook.js', import.meta.url).href;
    const script = `import { buildMsgHookOutput } from ${JSON.stringify(hookModule)}; const input=JSON.parse(process.env.MSG_HOOK_INPUT); const out=buildMsgHookOutput(input); if(out) process.stdout.write(out);`;
    const input = JSON.stringify({ event: 'user-prompt-submit', format: 'codex', cwd: '/repo/elanous-hq/seats/OP', sessionId: 'parallel', messages: inbox, stateDir: dir });
    const results = await Promise.all(Array.from({ length: 8 }, async () => {
      const child = Bun.spawn(['bun', '-e', script], { cwd: process.cwd(), env: { ...process.env, MSG_HOOK_INPUT: input }, stdout: 'pipe', stderr: 'pipe' });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    }));
    expect(results.every(result => result.code === 0), results.map(result => result.stderr).join('\n')).toBe(true);
    // Source: #35385 concurrent hook processes must emit exactly one message copy.
    expect(results.filter(result => result.stdout.length > 0)).toHaveLength(1);
  });

  test('K1 ack state changes unread bundles monotonically and seen bundles stay suppressed', () => {
    const dir = stateDir();
    const store = new MsgStore(':memory:');
    try {
      const first = store.post({ from: 'MK', to: 'OP', body: 'first' });
      const second = store.post({ from: 'TC', to: 'OP', body: 'second' });
      const input = { event: 'user-prompt-submit' as const, format: 'claude' as const, cwd: '/repo/elanous-hq/seats/OP', sessionId: 'ack-cycle', stateDir: dir };
      const a = store.listByRecipient('OP', store.getCursor('OP'));
      expect(buildMsgHookOutput({ ...input, messages: a })).not.toBeNull();
      store.ackMessage('OP', first.id);
      const b = store.listByRecipient('OP', store.getCursor('OP'));
      expect(b.map(message => message.id)).toEqual([second.id]);
      expect(buildMsgHookOutput({ ...input, messages: b })).not.toBeNull();
      store.post({ from: 'MK', to: 'OP', body: 'third' });
      store.ackMessage('OP', second.id);
      const c = store.listByRecipient('OP', store.getCursor('OP'));
      expect(c).toHaveLength(1);
      expect(buildMsgHookOutput({ ...input, messages: c })).not.toBeNull();
      expect(buildMsgHookOutput({ ...input, messages: a })).toBeNull();
    } finally { store.close(); }
  });

  test('reads the previous single-bundle state format after an upgrade', () => {
    const dir = stateDir();
    const sessionId = 'legacy-state';
    const path = join(dir, `${createHash('sha256').update(`claude:OP:${sessionId}`).digest('hex')}.json`);
    writeFileSync(path, JSON.stringify({ ids: [11, 14] }));
    expect(buildMsgHookOutput({ event: 'user-prompt-submit', format: 'claude', cwd: '/repo/elanous-hq/seats/OP', sessionId, messages: inbox, stateDir: dir })).toBeNull();
  });

  test('rejects malformed legacy state rather than delivering a potentially repeated bundle', () => {
    for (const [name, contents] of [['null', 'null'], ['empty', '{}']] as const) {
      const dir = stateDir();
      const sessionId = `legacy-${name}`;
      const path = join(dir, `${createHash('sha256').update(`claude:OP:${sessionId}`).digest('hex')}.json`);
      writeFileSync(path, contents);
      expect(() => buildMsgHookOutput({ event: 'user-prompt-submit', format: 'claude', cwd: '/repo/elanous-hq/seats/OP', sessionId, messages: inbox, stateDir: dir })).toThrow('prior hook delivery state');
    }
  });

  test('a missing session ID does not persist a global nosid suppression key', () => {
    const dir = stateDir();
    const input = { event: 'user-prompt-submit' as const, format: 'codex' as const, cwd: '/repo/elanous-hq/seats/OP', messages: inbox, stateDir: dir };
    expect(buildMsgHookOutput(input)).not.toBeNull();
    expect(buildMsgHookOutput(input)).not.toBeNull();
  });

  test('Stop without a session ID does not block the turn repeatedly', () => {
    expect(buildMsgHookOutput({ event: 'stop', format: 'claude', cwd: '/repo/elanous-hq/seats/OP', messages: inbox, stateDir: stateDir() })).toBeNull();
  });

  test('empty inbox and non-seat cwd produce no output and unsupported formats fail closed', () => {
    const state = stateDir();
    expect(buildMsgHookOutput({ event: 'user-prompt-submit', format: 'claude', cwd: '/repo/elanous-hq/seats/OP', sessionId: 's3', messages: [], stateDir: state })).toBeNull();
    expect(buildMsgHookOutput({ event: 'user-prompt-submit', format: 'claude', cwd: '/repo', sessionId: 's3', messages: inbox, stateDir: state })).toBeNull();
    expect(() => buildMsgHookOutput({ event: 'stop', format: 'other' as never, cwd: '/repo/elanous-hq/seats/OP', sessionId: 's3', messages: inbox, stateDir: state })).toThrow('unknown msg hook format');
  });
});
