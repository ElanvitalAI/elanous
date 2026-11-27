// ELS-WATCH-UNBUFFERED (대표 11-27) — `els watch` with stdout piped (not a TTY) delivers each new screen line at once.
// A real child process runs runWatch with the default writer; the screen changes once, and the line must reach the
// parent's pipe within 2 s while the child is still running. Expectations are independent literals.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const peekModule = resolve(import.meta.dir, 'els-peek-cli.ts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function childScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'els-watch-unbuffered-'));
  dirs.push(dir);
  const file = join(dir, 'child.ts');
  writeFileSync(file, `
import { runWatch } from ${JSON.stringify(peekModule)};
const started = Date.now();
const row = { address: 'local:w1/t1/p1', pane: 'p1', title: 'PIPE', kind: 'shell' };
await runWatch('PIPE', { interval: '500ms' }, {
  listPanes: async () => [row],
  readScreen: async () => ({ ok: true, text: Date.now() - started < 600 ? 'alpha first line\\n' : 'alpha first line\\nbravo arrives late\\n' }),
  manifestRows: () => [], psParents: () => new Map(),
});
`);
  return file;
}

test('piped stdout: a screen change reaches the reader within 2 s, while the watch keeps running', async () => {
  const child = Bun.spawn(['bun', childScript()], { stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 2_000 + 600;
  try {
    while (!seen.includes('bravo arrives late') && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
      if (!next || next.done) break;
      seen += decoder.decode(next.value, { stream: true });
    }
    expect(seen).toContain('alpha first line');
    expect(seen).toContain('bravo arrives late');
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);

test('reader goes away: the watch ends quietly (no EPIPE trace) instead of streaming into a closed pipe', async () => {
  const child = Bun.spawn(['sh', '-c', `bun ${JSON.stringify(childScript())} | head -n 1 >/dev/null`], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 8_000);
  const code = await child.exited;
  clearTimeout(timer);
  const stderr = await new Response(child.stderr).text();
  expect(code).toBe(0);
  expect(stderr).not.toContain('EPIPE');
}, 12_000);
