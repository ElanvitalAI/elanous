import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 🩸 09-29: docs/live/s44-corpus/probe-free-vs-bound.ts imported the operator's checkout by absolute path
//    (/Users/…/pilot/monad-agent/src/…). tsconfig.pwa-env.json («**/*.ts») pulled that tree in, and the
//    changed-file tsc gate reported ~2,000 TS6059 errors from another checkout — blocking unrelated PRs.
//    A tracked source file must never import by absolute path.
describe('tracked TypeScript sources import by relative or package path only', () => {
  test('no `from "/…"` or `import("/…")` in tracked .ts/.tsx/.mts/.cts files', () => {
    const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders = files.filter((file) => {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { return false; }
      // Only real module specifiers: `import … from '/…'`, `export … from '/…'`, `import '/…'`, `import('/…')`
      // (an error-message fixture like «Cannot find module … from '/tmp/…'» is text, not an import).
      return /^\s*(?:import|export)\b[^\n;]*?\bfrom\s*['"]\/|^\s*import\s*['"]\/|\bimport\s*\(\s*['"]\//m.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
