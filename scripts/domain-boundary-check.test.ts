import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_CONFIRMATIONS_PATH,
  FINANCIAL_PREFIX_HYPOTHESIS,
  HUMAN_CONFIRMED,
  NO_RULE_MATCHED,
  checkDomainBoundary,
  formatDomainBoundarySummary,
  formatUnreadableEvidence,
  main,
} from './domain-boundary-check.js';

const scriptPath = join(import.meta.dir, 'domain-boundary-check.ts');
const catalogWithXai = 'resources:\n  - env: [XAI_API_KEY, GROK_API_KEY]\n';

function fixture(
  domains: Record<string, string>,
  catalog = catalogWithXai,
  confirmations?: string,
  extras: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'domain-boundary-'));
  mkdirSync(join(root, 'src', 'domains'), { recursive: true });
  mkdirSync(join(root, 'catalog'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const [name, contents] of Object.entries(domains)) {
    const full = join(root, 'src', 'domains', name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  for (const [relativePath, contents] of Object.entries(extras)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  writeFileSync(join(root, 'catalog', 'resources.yaml'), catalog);
  if (confirmations !== undefined) {
    writeFileSync(join(root, DEFAULT_CONFIRMATIONS_PATH), confirmations);
  }
  return root;
}

function runCli(root: string, argv: string[] = []): { output: string[]; exits: number[] } {
  const output: string[] = [];
  const exits: number[] = [];
  main({
    root,
    argv,
    out: { log: (line) => output.push(line) },
    setExitCode: (code) => exits.push(code),
  });
  return { output, exits };
}

describe('checkDomainBoundary', () => {
  test('classifies a credential-bearing file as company-only with that credential as evidence', () => {
    const root = fixture({ 'taste-model.ts': 'const key = process.env.XAI_API_KEY;\n' });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'company-only', evidence: 'XAI_API_KEY' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies a financial-prefix filename as company-only with that prefix as evidence', () => {
    const root = fixture({ 'trade-cycle.ts': 'export const cycle = 1;\n' });
    try {
      const result = checkDomainBoundary({ root });
      expect(FINANCIAL_PREFIX_HYPOTHESIS).toContain('trade');
      expect(result.records).toEqual([
        { path: 'src/domains/trade-cycle.ts', verdict: 'company-only', evidence: 'trade' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves unmatched files as unknown with no-rule-matched', () => {
    const root = fixture({ 'taste-model.ts': 'export const taste = true;\n' });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
      expect(result.summary).toEqual({ core: 0, 'company-only': 0, unknown: 1, total: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lets catalog credential evidence win over the financial-prefix hypothesis', () => {
    const root = fixture({ 'signal-dedup.ts': 'const key = process.env.XAI_API_KEY;\n' });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/signal-dedup.ts', verdict: 'company-only', evidence: 'XAI_API_KEY' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('follows a static relative from import through .js/.ts normalization', () => {
    const root = fixture({
      'taste-model.ts': 'import { key } from "./keys.js";\nexport const taste = key;\n',
      'keys.ts': 'export const key = process.env.XAI_API_KEY;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'company-only',
        evidence: 'XAI_API_KEY',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves an extensionless relative from import through the /index fallback', () => {
    const root = fixture({
      'taste-model.ts': 'import { key } from "./helpers";\nexport const taste = key;\n',
      'helpers/index.ts': 'export const key = process.env.XAI_API_KEY;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'company-only',
        evidence: 'XAI_API_KEY',
      });
      expect(result.records.some((record) => record.path.includes('/helpers/'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('propagates reachable credential evidence through an import cycle regardless of scan order', () => {
    const graphs: Array<{ domains: Record<string, string>; a: string; b: string }> = [
      {
        domains: {
          'alpha.ts': 'import { peer } from "./beta.js";\nimport { key } from "./keys.js";\nexport const alpha = peer;\n',
          'beta.ts': 'import { alpha } from "./alpha.js";\nexport const peer = alpha;\n',
          'keys.ts': 'export const key = process.env.XAI_API_KEY;\n',
        },
        a: 'src/domains/alpha.ts',
        b: 'src/domains/beta.ts',
      },
      {
        domains: {
          'omega.ts': 'import { peer } from "./beta.js";\nimport { key } from "./keys.js";\nexport const omega = peer;\n',
          'beta.ts': 'import { omega } from "./omega.js";\nexport const peer = omega;\n',
          'keys.ts': 'export const key = process.env.XAI_API_KEY;\n',
        },
        a: 'src/domains/omega.ts',
        b: 'src/domains/beta.ts',
      },
    ];
    for (const graph of graphs) {
      const root = fixture(graph.domains);
      try {
        const result = checkDomainBoundary({ root });
        expect(result.records.find((record) => record.path === graph.a)).toEqual({
          path: graph.a,
          verdict: 'company-only',
          evidence: 'XAI_API_KEY',
        });
        expect(result.records.find((record) => record.path === graph.b)).toEqual({
          path: graph.b,
          verdict: 'company-only',
          evidence: 'XAI_API_KEY',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('does not treat a side-effect relative import as a static relative from import', () => {
    const root = fixture({
      'taste-model.ts': "import './keys.js';\nexport const taste = true;\n",
      'keys.ts': 'export const key = process.env.XAI_API_KEY;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
      expect(result.records.find((record) => record.path === 'src/domains/keys.ts')).toEqual({
        path: 'src/domains/keys.ts',
        verdict: 'company-only',
        evidence: 'XAI_API_KEY',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat package, dynamic, or re-export specifiers as static relative from imports', () => {
    const root = fixture({
      'taste-model.ts': [
        "import { readFileSync } from 'node:fs';",
        "const loaded = await import('./keys.js');",
        "export { key } from './keys.js';",
        'export const taste = readFileSync;',
        '',
      ].join('\n'),
      'keys.ts': 'export const key = process.env.XAI_API_KEY;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not follow a static relative from import of a .test.ts file', () => {
    const root = fixture({
      'taste-model.ts': 'import { key } from "./keys.test.js";\nexport const taste = key;\n',
      'keys.test.ts': 'export const key = process.env.XAI_API_KEY;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies a human-confirmed file as core with explicit confirmation evidence', () => {
    const root = fixture({ 'core-tools.ts': 'export const core = true;\n' });
    try {
      const result = checkDomainBoundary({
        root,
        confirmations: {
          'src/domains/core-tools.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        },
      });
      expect(result.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'core', evidence: HUMAN_CONFIRMED },
      ]);
      expect(result.summary.core).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reapplies cumulative confirmations from the confirmation file without rewriting catalog or domains', () => {
    const root = fixture(
      {
        'core-tools.ts': 'export const core = true;\n',
        'taste-model.ts': 'export const taste = true;\n',
      },
      catalogWithXai,
      JSON.stringify({
        'src/domains/core-tools.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        'src/domains/taste-model.ts': { verdict: 'company-only', evidence: HUMAN_CONFIRMED },
      }),
    );
    const catalogBefore = readFileSync(join(root, 'catalog', 'resources.yaml'), 'utf8');
    const domainBefore = readFileSync(join(root, 'src', 'domains', 'core-tools.ts'), 'utf8');
    try {
      const first = checkDomainBoundary({ root });
      const second = checkDomainBoundary({ root });
      expect(first.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'core', evidence: HUMAN_CONFIRMED },
        { path: 'src/domains/taste-model.ts', verdict: 'company-only', evidence: HUMAN_CONFIRMED },
      ]);
      expect(second.records).toEqual(first.records);
      expect(second.summary).toEqual(first.summary);
      expect(readFileSync(join(root, 'catalog', 'resources.yaml'), 'utf8')).toBe(catalogBefore);
      expect(readFileSync(join(root, 'src', 'domains', 'core-tools.ts'), 'utf8')).toBe(domainBefore);
      expect(existsSync(join(root, 'extensions'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('excludes .test.ts files from the scan', () => {
    const root = fixture({
      'taste-model.ts': 'export const taste = true;\n',
      'taste-model.test.ts': 'const key = process.env.XAI_API_KEY;\n',
      'signal-gate2.market-posture.test.ts': 'export const n = 1;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.map((record) => record.path)).toEqual(['src/domains/taste-model.ts']);
      expect(result.summary.total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts all three verdicts including unknown in the complete summary', () => {
    const root = fixture({
      'core-tools.ts': 'export const core = true;\n',
      'trade-cycle.ts': 'export const cycle = 1;\n',
      'taste-model.ts': 'export const taste = true;\n',
    });
    try {
      const result = checkDomainBoundary({
        root,
        confirmations: {
          'src/domains/core-tools.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        },
      });
      expect(result.summary).toEqual({ core: 1, 'company-only': 1, unknown: 1, total: 3 });
      expect(formatDomainBoundarySummary(result.summary)).toBe('core 1 · company-only 1 · unknown 1 · 합 3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lets catalog credential evidence win over a conflicting human core confirmation', () => {
    const root = fixture({ 'signal-dedup.ts': 'const key = process.env.XAI_API_KEY;\n' });
    try {
      const result = checkDomainBoundary({
        root,
        confirmations: {
          'src/domains/signal-dedup.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        },
      });
      expect(result.records).toEqual([
        { path: 'src/domains/signal-dedup.ts', verdict: 'company-only', evidence: 'XAI_API_KEY' },
      ]);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats a missing confirmation file as optional zero confirmations, not an error', () => {
    const root = fixture({ 'taste-model.ts': 'export const taste = true;\n' });
    try {
      expect(existsSync(join(root, DEFAULT_CONFIRMATIONS_PATH))).toBe(false);
      const result = checkDomainBoundary({ root });
      expect(result.errors).toEqual([]);
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves an unreadable domain file as unknown even when a core confirmation exists', () => {
    const root = fixture({ 'core-tools.ts': 'export const core = true;\n' });
    try {
      const result = checkDomainBoundary({
        root,
        confirmations: {
          'src/domains/core-tools.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        },
        readFile: (path) => {
          if (path.endsWith('core-tools.ts')) throw new Error('domain unreadable');
          return readFileSync(path, 'utf8');
        },
      });
      expect(result.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'unknown', evidence: formatUnreadableEvidence('domain unreadable') },
      ]);
      expect(result.summary).toEqual({ core: 0, 'company-only': 0, unknown: 1, total: 1 });
      expect(result.errors).toEqual([
        { path: 'src/domains/core-tools.ts', reason: 'domain unreadable' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns the path and reason of a syntactically valid but illegal confirmation instead of dropping it', () => {
    const root = fixture(
      { 'core-tools.ts': 'export const core = true;\n' },
      catalogWithXai,
      JSON.stringify({ 'src/domains/core-tools.ts': { verdict: 'cor' } }),
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.errors).toEqual([
        {
          path: 'src/domains/core-tools.ts',
          reason: 'verdict must be \'core\' or \'company-only\' (got "cor")',
        },
      ]);
      expect(result.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces a corrupt confirmation file as an incomplete observation instead of silently dropping it', () => {
    const root = fixture({ 'taste-model.ts': 'export const taste = true;\n' }, catalogWithXai, '{not-json');
    try {
      const result = checkDomainBoundary({ root });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.path).toBe(join(root, DEFAULT_CONFIRMATIONS_PATH));
      expect(result.errors[0]!.reason).not.toBe('');
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('propagates a syntactically valid but illegal catalog resources map into errors instead of an empty credential list', () => {
    const root = fixture(
      { 'taste-model.ts': 'const key = process.env.XAI_API_KEY;\n' },
      'resources: {}\n',
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.errors).toEqual([
        {
          path: join(root, 'catalog', 'resources.yaml'),
          reason: 'resources must be an array (got {})',
        },
      ]);
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not let resources: {} confirm a credential-bearing file as core without an error', () => {
    const root = fixture(
      { 'core-tools.ts': 'const key = process.env.XAI_API_KEY;\n' },
      'resources: {}\n',
    );
    try {
      const result = checkDomainBoundary({
        root,
        confirmations: {
          'src/domains/core-tools.ts': { verdict: 'core', evidence: HUMAN_CONFIRMED },
        },
      });
      expect(result.errors).toEqual([
        {
          path: join(root, 'catalog', 'resources.yaml'),
          reason: 'resources must be an array (got {})',
        },
      ]);
      expect(result.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'core', evidence: HUMAN_CONFIRMED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces an unreadable catalog instead of substituting the prefix hypothesis as a complete scan', () => {
    const root = fixture({ 'signal-dedup.ts': 'const key = process.env.XAI_API_KEY;\n' });
    try {
      const result = checkDomainBoundary({
        root,
        readFile: (path) => {
          if (path.endsWith('catalog/resources.yaml') || path.endsWith('catalog\\resources.yaml')) {
            throw new Error('catalog unreadable');
          }
          return readFileSync(path, 'utf8');
        },
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.path).toBe(join(root, 'catalog', 'resources.yaml'));
      expect(result.errors[0]!.reason).toBe('catalog unreadable');
      expect(result.records[0]).toEqual({
        path: 'src/domains/signal-dedup.ts',
        verdict: 'company-only',
        evidence: 'signal',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails an explicit root that has no src/domains instead of reporting a successful empty scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'domain-boundary-missing-'));
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([]);
      expect(result.summary).toEqual({ core: 0, 'company-only': 0, unknown: 0, total: 0 });
      expect(result.errors).toEqual([
        { path: 'src/domains', reason: 'src/domains directory not found' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('scans the same files from a repository subdirectory as from the repository root', () => {
    const root = fixture({
      'taste-model.ts': 'export const taste = true;\n',
      'trade-cycle.ts': 'export const cycle = 1;\n',
    });
    const previous = process.cwd();
    try {
      const fromRoot = checkDomainBoundary({ root });
      process.chdir(join(root, 'scripts'));
      const fromNested = checkDomainBoundary({});
      expect(fromNested.records).toEqual(fromRoot.records);
      expect(fromNested.summary).toEqual(fromRoot.summary);
      expect(fromNested.errors).toEqual([]);
      expect(fromNested.summary.total).toBe(2);
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat a side-effect financial import as company-only evidence', () => {
    const root = fixture({
      'taste-model.ts': "import './finance-opportunity.js';\nexport const taste = true;\n",
      'finance-opportunity.ts': 'export const signal = 1;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
      expect(result.records.find((record) => record.path === 'src/domains/finance-opportunity.ts')).toEqual({
        path: 'src/domains/finance-opportunity.ts',
        verdict: 'company-only',
        evidence: 'finance',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('still classifies a static from financial import as company-only', () => {
    const root = fixture({
      'taste-model.ts': "import { signal } from './finance-opportunity.js';\nexport const taste = true;\n",
      'finance-opportunity.ts': 'export const signal = 1;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'company-only',
        evidence: 'src/domains/finance-opportunity.ts',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not treat a side-effect core-zone import as core evidence', () => {
    const root = fixture(
      { 'taste-model.ts': 'export const taste = true;\n' },
      catalogWithXai,
      undefined,
      { 'src/cli/user.ts': "import '../domains/taste-model.js';\n" },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('lets a financial-prefix domain import win over a core importer', () => {
    const root = fixture(
      {
        'overlap.ts': "import { signal } from './finance-opportunity.js';\n",
        'finance-opportunity.ts': 'export const signal = 1;\n',
      },
      catalogWithXai,
      undefined,
      { 'src/cli/overlap-user.ts': "import { overlap } from '../domains/overlap.js';\n" },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/overlap.ts')).toEqual({
        path: 'src/domains/overlap.ts',
        verdict: 'company-only',
        evidence: 'src/domains/finance-opportunity.ts',
      });
      expect(result.records.find((record) => record.path === 'src/domains/finance-opportunity.ts')).toEqual({
        path: 'src/domains/finance-opportunity.ts',
        verdict: 'company-only',
        evidence: 'finance',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a relative core import with .js stripped to a domain file', () => {
    const root = fixture(
      { 'fleet.ts': 'export const fleet = true;\n' },
      catalogWithXai,
      undefined,
      { 'src/self-dev/dev-cli.ts': "import { fleet } from '../domains/fleet.js';\n" },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/fleet.ts', verdict: 'core', evidence: 'src/self-dev/dev-cli.ts' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to a directory index when the relative specifier has no extension', () => {
    const root = fixture(
      { 'index.ts': 'export const nested = true;\n' },
      catalogWithXai,
      undefined,
      { 'src/agent/user.ts': "import { nested } from '../domains';\n" },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/index.ts', verdict: 'core', evidence: 'src/agent/user.ts' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not count a .test.ts core-zone importer as core evidence', () => {
    const root = fixture(
      { 'taste-model.ts': 'export const taste = true;\n' },
      catalogWithXai,
      undefined,
      { 'src/cli/taste-model.test.ts': "import { taste } from '../domains/taste-model.js';\n" },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores from specifiers that live only in comments or string literals', () => {
    const root = fixture({
      'taste-model.ts': [
        "// import { signal } from './finance-opportunity.js';",
        '/* import { signal } from \'./finance-opportunity.js\'; */',
        'const example = "import { signal } from \'./finance-opportunity.js\'";',
        'export const taste = true;',
        '',
      ].join('\n'),
      'finance-opportunity.ts': 'export const signal = 1;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
      expect(result.records.find((record) => record.path === 'src/domains/finance-opportunity.ts')).toEqual({
        path: 'src/domains/finance-opportunity.ts',
        verdict: 'company-only',
        evidence: 'finance',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a nested financial domain directory index without changing the population', () => {
    const root = fixture(
      { 'taste-model.ts': "import { nested } from './finance-foo';\n" },
      catalogWithXai,
      undefined,
      { 'src/domains/finance-foo/index.ts': 'export const nested = true;\n' },
    );
    try {
      const result = checkDomainBoundary({ root });
      expect(result.summary.total).toBe(1);
      expect(result.records).toEqual([
        {
          path: 'src/domains/taste-model.ts',
          verdict: 'company-only',
          evidence: 'src/domains/finance-foo/index.ts',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not resolve a missing directory index import to a sibling domain file', () => {
    const root = fixture({
      'taste-model.ts': "import { signal } from './finance-opportunity/index.js';\n",
      'finance-opportunity.ts': 'export const signal = 1;\n',
    });
    try {
      const result = checkDomainBoundary({ root });
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: NO_RULE_MATCHED,
      });
      expect(result.records.find((record) => record.path === 'src/domains/finance-opportunity.ts')).toEqual({
        path: 'src/domains/finance-opportunity.ts',
        verdict: 'company-only',
        evidence: 'finance',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reuses the first domain read and records that failure instead of retrying silently', () => {
    const root = fixture({
      'taste-model.ts': "import { signal } from './finance-opportunity.js';\n",
      'finance-opportunity.ts': 'export const signal = 1;\n',
    });
    try {
      let domainReads = 0;
      const result = checkDomainBoundary({
        root,
        readFile: (path) => {
          if (path.endsWith('taste-model.ts')) {
            domainReads += 1;
            if (domainReads === 1) throw new Error('first read failed');
          }
          return readFileSync(path, 'utf8');
        },
      });
      expect(domainReads).toBe(1);
      expect(result.errors).toEqual([{ path: 'src/domains/taste-model.ts', reason: 'first read failed' }]);
      expect(result.records.find((record) => record.path === 'src/domains/taste-model.ts')).toEqual({
        path: 'src/domains/taste-model.ts',
        verdict: 'unknown',
        evidence: formatUnreadableEvidence('first read failed'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records an unreadable core importer in errors instead of skipping it', () => {
    const root = fixture(
      { 'taste-model.ts': 'export const taste = true;\n' },
      catalogWithXai,
      undefined,
      { 'src/cli/user.ts': "import { taste } from '../domains/taste-model.js';\n" },
    );
    try {
      const result = checkDomainBoundary({
        root,
        readFile: (path) => {
          if (path.endsWith('src/cli/user.ts') || path.endsWith('src\\cli\\user.ts')) {
            throw new Error('importer unreadable');
          }
          return readFileSync(path, 'utf8');
        },
      });
      expect(result.errors).toEqual([{ path: 'src/cli/user.ts', reason: 'importer unreadable' }]);
      expect(result.records).toEqual([
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('domainBoundaryCheckCliMain', () => {
  test('prints per-file lines and a last line that always carries unknown', () => {
    const root = fixture({
      'trade-cycle.ts': 'export const cycle = 1;\n',
      'taste-model.ts': 'export const taste = true;\n',
    });
    try {
      const { output, exits } = runCli(root);
      expect(output.at(-1)).toBe('core 0 · company-only 1 · unknown 1 · 합 2');
      expect(output.at(-1)).toContain('unknown');
      expect(output).toContain('src/domains/taste-model.ts  unknown  no-rule-matched');
      expect(output).toContain('src/domains/trade-cycle.ts  company-only  trade');
      expect(exits).toEqual([0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prints the same records and complete summary as --json', () => {
    const root = fixture({
      'core-tools.ts': 'export const core = true;\n',
      'trade-cycle.ts': 'export const cycle = 1;\n',
      'taste-model.ts': 'export const taste = true;\n',
    });
    try {
      const { output, exits } = runCli(root, ['--json']);
      const parsed = JSON.parse(output[0]!);
      expect(exits).toEqual([0]);
      expect(parsed.summary).toEqual({ core: 0, 'company-only': 1, unknown: 2, total: 3 });
      expect(parsed.records).toEqual([
        { path: 'src/domains/core-tools.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
        { path: 'src/domains/taste-model.ts', verdict: 'unknown', evidence: NO_RULE_MATCHED },
        { path: 'src/domains/trade-cycle.ts', verdict: 'company-only', evidence: 'trade' },
      ]);
      expect(parsed.errors).toEqual([]);
      expect(Object.keys(parsed.summary)).toEqual(['core', 'company-only', 'unknown', 'total']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps unknown 0 visible in the last line when every file matched a rule', () => {
    const root = fixture({ 'trade-cycle.ts': 'export const cycle = 1;\n' });
    try {
      const { output } = runCli(root);
      expect(output.at(-1)).toBe('core 0 · company-only 1 · unknown 0 · 합 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exits unsuccessfully and names the missing domains directory instead of printing a successful empty total', () => {
    const root = mkdtempSync(join(tmpdir(), 'domain-boundary-cli-missing-'));
    try {
      const { output, exits } = runCli(root);
      expect(exits).toEqual([1]);
      expect(output[0]).toMatch(/^error: src\/domains \(src\/domains directory not found\)$/);
      expect(output.at(-1)).toBe('core 0 · company-only 0 · unknown 0 · 합 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exits unsuccessfully for a syntactically valid but illegal confirmation item', () => {
    const root = fixture(
      { 'core-tools.ts': 'export const core = true;\n' },
      catalogWithXai,
      JSON.stringify({ 'src/domains/core-tools.ts': { verdict: 'cor' } }),
    );
    try {
      const { output, exits } = runCli(root);
      expect(exits).toEqual([1]);
      expect(output[0]).toBe('error: src/domains/core-tools.ts (verdict must be \'core\' or \'company-only\' (got "cor"))');
      expect(output).toContain('src/domains/core-tools.ts  unknown  no-rule-matched');
      expect(output.at(-1)).toBe('core 0 · company-only 0 · unknown 1 · 합 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exits unsuccessfully for a syntactically valid but illegal catalog resources map', () => {
    const root = fixture(
      { 'taste-model.ts': 'const key = process.env.XAI_API_KEY;\n' },
      'resources: {}\n',
    );
    try {
      const { output, exits } = runCli(root);
      expect(exits).toEqual([1]);
      expect(output[0]).toBe(
        `error: ${join(root, 'catalog', 'resources.yaml')} (resources must be an array (got {}))`,
      );
      expect(output).toContain('src/domains/taste-model.ts  unknown  no-rule-matched');
      expect(output.at(-1)).toBe('core 0 · company-only 0 · unknown 1 · 합 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exits unsuccessfully for a corrupt confirmation file while still printing the incomplete observation', () => {
    const root = fixture({ 'taste-model.ts': 'export const taste = true;\n' }, catalogWithXai, '{not-json');
    try {
      const { output, exits } = runCli(root);
      expect(exits).toEqual([1]);
      expect(output[0]).toMatch(/^error: .*domain-boundary-confirmations\.json /);
      expect(output).toContain('src/domains/taste-model.ts  unknown  no-rule-matched');
      expect(output.at(-1)).toBe('core 0 · company-only 0 · unknown 1 · 합 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repository scan', () => {
  test('scans the real repository without creating extensions/ or changing catalog or domains', () => {
    const catalogPath = join(process.cwd(), 'catalog', 'resources.yaml');
    const domainPath = join(process.cwd(), 'src', 'domains', 'signal-dedup.ts');
    const catalogBefore = readFileSync(catalogPath, 'utf8');
    const domainBefore = readFileSync(domainPath, 'utf8');
    const extensionsBefore = existsSync(join(process.cwd(), 'extensions'));

    const result = checkDomainBoundary({});
    const { output } = runCli(process.cwd());

    const domainFiles = readdirSync(join(process.cwd(), 'src', 'domains'))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(result.summary.total).toBe(domainFiles.length);
    expect(result.records.map((record) => record.path)).toEqual(
      domainFiles.map((name) => `src/domains/${name}`).sort((left, right) => left.localeCompare(right)),
    );
    expect(result.summary.core).toBeGreaterThan(0);
    expect(result.summary.unknown).toBeLessThan(109);
    expect(result.summary.core + result.summary['company-only'] + result.summary.unknown).toBe(result.summary.total);
    expect(result.summary.unknown).toBeGreaterThan(0);
    expect(result.records.some((record) => record.verdict === 'unknown' && record.evidence === NO_RULE_MATCHED)).toBe(true);
    const fleet = result.records.find((record) => record.path === 'src/domains/fleet.ts');
    expect(fleet?.verdict).toBe('core');
    expect(fleet?.evidence.startsWith('src/')).toBe(true);
    expect(result.records.find((record) => record.path === 'src/domains/opportunity-analysis.ts')?.verdict).toBe(
      'company-only',
    );
    expect(result.records.find((record) => record.path === 'src/domains/acp-backend-sessions.ts')).toEqual({
      path: 'src/domains/acp-backend-sessions.ts',
      verdict: 'unknown',
      evidence: NO_RULE_MATCHED,
    });
    const prefixed = result.records.find(
      (record) => record.path === 'src/domains/trade-cycle.ts' && record.verdict === 'company-only',
    );
    expect(prefixed?.evidence).toBe('trade');
    expect(FINANCIAL_PREFIX_HYPOTHESIS).toContain('trade');
    expect(result.records.find((record) => record.path === 'src/domains/signal-dedup.ts')).toEqual({
      path: 'src/domains/signal-dedup.ts',
      verdict: 'company-only',
      evidence: 'XAI_API_KEY',
    });
    expect(result.records.some((record) => record.path.endsWith('.test.ts'))).toBe(false);
    expect(result.records.every((record) => record.path.split('/').length === 3)).toBe(true);
    expect(output.at(-1)).toBe(formatDomainBoundarySummary(result.summary));
    expect(output.at(-1)).toContain(`unknown ${result.summary.unknown}`);
    expect(readFileSync(catalogPath, 'utf8')).toBe(catalogBefore);
    expect(readFileSync(domainPath, 'utf8')).toBe(domainBefore);
    expect(existsSync(join(process.cwd(), 'extensions'))).toBe(extensionsBefore);
  }, 15_000);

  test('wires import.meta.main as the runtime caller of main', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('export function main(');
    expect(source).toContain('if (import.meta.main) main();');
    expect(source.match(/if \(import\.meta\.main\) main\(\);/g)).toHaveLength(1);
    const mainIndex = source.lastIndexOf('export function main(');
    const guardIndex = source.lastIndexOf('if (import.meta.main) main();');
    expect(mainIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(mainIndex);
  });

  test('runs the import.meta.main entrypoint against a fixture', () => {
    const root = fixture({
      'taste-model.ts': 'export const taste = true;\n',
      'trade-cycle.ts': 'export const cycle = 1;\n',
    });
    try {
      const child = Bun.spawnSync([process.execPath, scriptPath], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const output = new TextDecoder().decode(child.stdout).trimEnd().split('\n');
      expect(child.exitCode).toBe(0);
      expect(output.at(-1)).toBe('core 0 · company-only 1 · unknown 1 · 합 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs the import.meta.main entrypoint unsuccessfully for a structurally invalid catalog', () => {
    const root = fixture(
      { 'taste-model.ts': 'const key = process.env.XAI_API_KEY;\n' },
      'resources: {}\n',
    );
    try {
      const child = Bun.spawnSync([process.execPath, scriptPath], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
      const output = new TextDecoder().decode(child.stdout);
      expect(child.exitCode).toBe(1);
      expect(output).toContain('resources must be an array (got {})');
      expect(output).toContain('src/domains/taste-model.ts  unknown  no-rule-matched');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs the import.meta.main entrypoint from a repository subdirectory', () => {
    const root = fixture({
      'taste-model.ts': 'export const taste = true;\n',
      'trade-cycle.ts': 'export const cycle = 1;\n',
    });
    try {
      const child = Bun.spawnSync([process.execPath, scriptPath], {
        cwd: join(root, 'scripts'),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = new TextDecoder().decode(child.stdout).trimEnd().split('\n');
      expect(child.exitCode).toBe(0);
      expect(output.at(-1)).toBe('core 0 · company-only 1 · unknown 1 · 합 2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
