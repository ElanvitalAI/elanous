import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// 🩸 10-09: `scripts/openai-relay-server.ts` registered the log sink without a retention policy, so every restart
//   ran startup retention with the 500MB default against a 1.1GB logs.db (operational config: 4000MB) and dropped
//   up to half of the rows. Every caller must pass the configured retention explicitly.
describe('registerLogStoreSink callers', () => {
  test('every call passes a retention policy (no silent 500MB default)', () => {
    const r = spawnSync('git', ['grep', '-n', '-E', 'registerLogStoreSink\\(', '--', 'src', 'scripts', 'bin', ':!*.test.ts'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const calls = r.stdout.split('\n').filter((line) => line && !line.includes('export function registerLogStoreSink'));
    expect(calls.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const line of calls) {
      const [file, lineNo] = line.split(':');
      const source = spawnSync('git', ['show', `:${file}`], { encoding: 'utf8' }).stdout.split('\n');
      const text = source.slice(Number(lineNo) - 1, Number(lineNo) + 8).join('\n');
      const open = text.indexOf('registerLogStoreSink(') + 'registerLogStoreSink('.length;
      // count top-level arguments up to the matching close paren
      let depth = 0; let args = 1; let end = -1;
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) { end = i; break; } depth--; }
        else if (ch === ',' && depth === 0) args++;
      }
      if (end < 0 || args < 3) missing.push(`${file}:${lineNo}`);
    }
    expect(missing).toEqual([]);
  });
});
