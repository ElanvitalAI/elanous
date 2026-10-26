import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, entryBudgetAffected, INDEX_MODULE_LIMIT } from './next-tui-entry-budget';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-tui-entry-budget-'));
  roots.push(root);
  mkdirSync(join(root, 'src/tui'), { recursive: true });
  mkdirSync(join(root, 'src/dashboard'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' } }));
  writeFileSync(join(root, 'src/tui/entry.ts'), "import './local';\nimport '../dashboard/loop-scheduler';\n");
  writeFileSync(join(root, 'src/tui/local.ts'), 'export const local = true;\n');
  writeFileSync(join(root, 'src/tui.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/index.ts'), 'export {};\n');
  writeFileSync(join(root, 'src/dashboard/loop-scheduler.ts'), 'export {};\n');
  writeFileSync(join(root, 'bin/elanous.mjs'), "await import('../src/index.ts');\n");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Next TUI entry budget', () => {
  test('selects every source change and the budget ratchet itself', () => {
    const root = fixture();
    expect(entryBudgetAffected(['docs/readme.md'])).toBe(false);
    expect(entryBudgetAffected(['src/tui/local.ts'])).toBe(true);
    expect(entryBudgetAffected(['src/index.ts'])).toBe(true);
    writeFileSync(join(root, 'src/index.ts'), "import './shared';\n");
    writeFileSync(join(root, 'src/shared.ts'), 'export const shared = true;\n');
    expect(entryBudgetAffected(['src/shared.ts'])).toBe(true);
    expect(entryBudgetAffected(['src/unrelated.ts'])).toBe(true);
    expect(entryBudgetAffected(['bin/elanous.mjs'])).toBe(true);
    expect(entryBudgetAffected(['scripts/ratchets/next-tui-entry-budget.ts'])).toBe(true);
  });

  test('detects a real 1,265-module index closure overflow from an indirect source change', () => {
    const root = fixture();
    const count = INDEX_MODULE_LIMIT;
    writeFileSync(join(root, 'src/index.ts'), "import './budget-0000';\\n");
    for (let i = 0; i < count; i += 1) {
      writeFileSync(join(root, `src/budget-${String(i).padStart(4, '0')}.ts`),
        i + 1 < count ? `import './budget-${String(i + 1).padStart(4, '0')}';\\n` : 'export const last = true;\\n');
    }
    expect(entryBudgetAffected(['src/budget-0000.ts'])).toBe(true);
    const result = audit(root);
    expect(result.indexModules).toBe(count + 1); // index entry plus the 1,264-module imported chain
    expect(result.errors).toContain('bin --tui next index static module count 1265 exceeds 1264');
  });

  test('audits the real repository tree so source budgets are part of the gate', { timeout: 30_000 }, () => {
    const root = join(import.meta.dir, '../..');
    const result = audit(root);
    expect(result.errors).toEqual([]);
    expect(result.entryModules).toBeGreaterThan(0);
    // This remains nonzero until NEXT-TUI-EXTRACT-FROM-INDEX changes the deployment route.
    expect(result.indexModules).toBeGreaterThan(0);
  });

  test('passes the current measured baseline and treats the one dashboard edge as temporary', () => {
    const result = audit(fixture());
    expect(result.errors).toEqual([]);
    expect(result.entryModules).toBe(3);
    expect(result.notes.join('\n')).toContain('NEXT-TUI-EXTRACT-FROM-INDEX');
  });

  test('rejects a 4,001-line TUI entry source file', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/tui/oversized.ts'), '// line\n'.repeat(4_001));
    expect(audit(root).errors).toContain('src/tui/oversized.ts: 4001 lines exceeds 4000');
  });

  test('rejects every dashboard edge beyond the fixed temporary baseline and rejects index import', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/dashboard/injected.ts'), 'export {};\n');
    writeFileSync(join(root, 'src/tui/entry.ts'), "import '../dashboard/loop-scheduler';\nimport '../dashboard/injected';\nimport '../index';\n");
    const errors = audit(root).errors.join('\n');
    expect(errors).toContain('forbidden dashboard static imports: src/dashboard/injected.ts');
    expect(errors).toContain('Next entry statically imports forbidden src/index.ts');
  });

  test('does not count a dynamic dashboard import as a static edge', () => {
    const root = fixture();
    writeFileSync(join(root, 'src/tui/entry.ts'), "void import('../dashboard/injected');\n");
    writeFileSync(join(root, 'src/dashboard/injected.ts'), 'export {};\n');
    expect(audit(root).errors).toEqual([]);
  });
});
