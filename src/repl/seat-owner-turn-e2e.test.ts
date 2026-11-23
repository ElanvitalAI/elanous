import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';

test('synthetic JSONL REPL: foreign cell and PR hand off before model and tool; own cell reaches both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owner-repl-e2e-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    // gh is never real: assert the exact repository and number before returning a synthetic PR.
    const gh = join(bin, 'gh');
    writeFileSync(gh, '#!/bin/sh\n[ "$*" = "pr view 42 --repo test/repo --json number,body" ] || exit 1\nprintf \'%s\\n\' \'{"number":42,"body":"칸 닫음: SYNTH-CELL"}\'\n');
    chmodSync(gh, 0o755);
    const env = { ...process.env, HOME: home, PROBE_HOME: home, ELANOUS_CONFIG_DIR: join(home, 'state'),
      ELANOUS_STATE_DIR: join(home, 'state'), XDG_CONFIG_HOME: join(home, 'xdg'), PATH: `${bin}:${process.env.PATH}`,
      ELANOUS_NEXT_TUI_STREAM: '0', ELANOUS_NEXT_TUI_BG_STATUS: '0' } as Record<string, string | undefined>;
    delete env.ELANOUS_LLM_PROVIDER;
    delete env.ELANOUS_LLM_MODEL;
    const proc = Bun.spawn(['bun', join(import.meta.dir, 'seat-owner-turn-e2e.driver.ts')],
      { cwd: join(import.meta.dir, '../..'), env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const cell = { kind: 'cell', id: 'SYNTH-CELL', version: '0.3.33' };
    const pr = { kind: 'pr', repository: 'test/repo', number: 42 };
    const own = { kind: 'cell', id: 'SYNTH-OWN', version: '0.3.33' };
    for (const [id, ref] of [['cell', cell], ['pr', pr], ['control', own]] as const)
      await proc.stdin.write(JSON.stringify({ id, prompt: `synthetic=true ${id}`, workReferences: [ref] }) + '\n');
    await proc.stdin.end();
    const [exit, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ exit, err }).toEqual({ exit: 0, err: expect.any(String) });
    const turns = out.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    expect(turns.find(x => x.turnId === 'cell')?.reply).toContain('TEST-1');
    expect(turns.find(x => x.turnId === 'pr')?.reply).toContain('TEST-1');
    expect(turns.find(x => x.turnId === 'control')?.reply).toBe('fake model');
    expect(err.match(/^MODEL .*$/gm)).toEqual(['MODEL synthetic=true control']);
    expect(err.match(/^TOOL .*$/gm)).toEqual(['TOOL synthetic=true control']);
    const store = new MsgStore(join(home, 'state', 'msg', 'messages.db'), { readOnly: true });
    try {
      expect(store.listAfter(0).map(m => ({ from: m.from, to: m.to, kind: m.kind, body: m.body }))).toEqual([
        { from: 'TEST-2', to: 'TEST-1', kind: 'evidence', body: `조사 전 인계 ${JSON.stringify([cell])} · synthetic=true cell` },
        { from: 'TEST-2', to: 'TEST-1', kind: 'evidence', body: `조사 전 인계 ${JSON.stringify([pr])} · synthetic=true pr` },
      ]);
    } finally { store.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
