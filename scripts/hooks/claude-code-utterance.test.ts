import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('UserPromptSubmit reaches the human Claude Code utterance query', async () => {
  const root = join(import.meta.dir, '../..');
  const temp = mkdtempSync(join(tmpdir(), 'claude-utterance-hook-'));
  const prompt = `hook-human-${crypto.randomUUID()}`;
  const from = new Date(Date.now() - 60_000).toISOString();
  const env = { ...process.env, ELANOUS_BIN: join(root, 'bin/elanous.mjs'), ELANOUS_STATE_DIR: temp };
  try {
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
      cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ prompt, session_id: 'hook-test', cwd: root })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode).toBe(0);
    const dbPath = join(temp, 'surface_events.db');
    let recorded = false;
    const deadline = Date.now() + 10_000;
    while (!recorded && Date.now() < deadline) {
      if (existsSync(dbPath)) {
        try {
          const db = new Database(dbPath, { readonly: true });
          try { recorded = Boolean(db.query('SELECT id FROM events WHERE text = ?').get(prompt)); }
          finally { db.close(); }
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
        }
      }
      if (!recorded) await Bun.sleep(50);
    }
    expect(recorded).toBe(true);
    const to = new Date(Date.now() + 60_000).toISOString();
    const read = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterances', '--from', from, '--to', to, '--origin', 'human',
      '--surface', 'ext:claude-code', '--json'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    expect(read.exitCode, new TextDecoder().decode(read.stdout) + new TextDecoder().decode(read.stderr)).toBe(0);
    const utterances = JSON.parse(new TextDecoder().decode(read.stdout)).utterances as Array<{ text: string; origin: string }>;
    expect(utterances.filter(row => row.text === prompt).map(row => [row.text, row.origin])).toEqual([[prompt, 'human']]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 20_000);
