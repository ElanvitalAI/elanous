import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodebaseGrounding } from '../autopilot/codebase-grounding.js';
import { authorGoal, tracedPathReferences, writeAuthoredGoal } from './goal-author.js';

const empty: CodebaseGrounding = {
  grounded: true, context: '', files: [], persistentEvidence: [], codeFacts: [],
  skillFacts: [], memoryFacts: [], documentFacts: [], refFacts: [], ptyFacts: [],
};

async function authoredPaths(ask: string, files: readonly string[], evidence: readonly string[], existing: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'goal-author-traced-valid-'));
  try {
    for (const path of existing) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, 'export {};\n');
    }
    const authored = await authorGoal(ask, {
      repositoryRoot: root,
      ground: async () => ({ ...empty, files: [...files], persistentEvidence: [...evidence] }),
      enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
      slugFn: async () => 'traced-valid',
    });
    return {
      paths: tracedPathReferences(authored.document).map(({ path }) => path),
      section: authored.document.slice(authored.document.indexOf('## TRACED PATHS'), authored.document.indexOf('## SCOPE BOUNDARY')),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('ENT-REGISTRY: declared repository paths survive an unresolved bare evidence filename', async () => {
  const targets = ['src/market/signed-index.ts', 'src/plugins/core/trust-store.ts'];
  const result = await authoredPaths(
    `대상 경로: ${targets.join(' · ')}\n서명 레지스트리를 구현한다.`,
    targets, ['plugin-trust.json — grounding named a basename only'], targets,
  );
  expect(result.paths).toEqual(targets);
  expect(result.section).toContain('미해석: plugin-trust.json');
});

test('decision cards: unique known full test paths replace bare filenames', async () => {
  const paths = ['src/decisions/decision-ledger.test.ts', 'src/web/web-push-decision-cards.test.ts'];
  const result = await authoredPaths(
    '대상 경로: src/decisions/decision-ledger.test.ts\n결정 카드를 검증한다.',
    paths, ['decision-ledger.test.ts and web-push-decision-cards.test.ts were read'], paths,
  );
  expect(result.paths).toEqual(paths);
  expect(result.section).not.toContain('미해석:');
});

test('a full path in grounding resolves its bare twin even when files is empty', async () => {
  const path = 'src/decisions/decision-ledger.test.ts';
  const result = await authoredPaths('결정 원장의 회귀를 검사한다.', [], [`${path} was Read; decision-ledger.test.ts was also named`], [path]);
  expect(result.paths).toEqual([path]);
  expect(result.section).not.toContain('미해석:');
});

test('an ambiguous basename stays unresolved when two real paths share it', async () => {
  const files = ['src/first/decision-ledger.test.ts', 'src/second/decision-ledger.test.ts'];
  const result = await authoredPaths('두 결정 원장 구현을 비교한다.', files, ['decision-ledger.test.ts was named without a directory'], files);
  expect(result.paths).toEqual([]);
  expect(result.section).toContain('미해석: decision-ledger.test.ts');
});

test('local-only cycle: absent ask target remains unresolved when no new file is declared', async () => {
  const result = await authoredPaths('대상 경로: scripts/local-only-cycle-e2e.ts\n로컬 사이클을 검사한다.', [], [], []);
  expect(result.paths).toEqual([]);
  expect(result.section).toContain('미해석: scripts/local-only-cycle-e2e.ts');
});

test('proact meter: an existing ask target remains traced without a path in evidence', async () => {
  const target = 'src/decisions/proact-meter.ts';
  const result = await authoredPaths(`대상 경로: ${target}\n측정기를 고친다.`, [], ['Read verified current behavior without a path'], [target]);
  expect(result.paths).toEqual([target]);
});

test('ELN-CLI warm path: a sole unlabeled ask path survives absent path evidence', async () => {
  const target = 'bin/elanous.mjs';
  const result = await authoredPaths(`Warm the ${target} entrypoint before launch.`, [], ['Read verified boot behavior without a path'], [target]);
  expect(result.paths).toEqual([target]);
});

test('a bare mention does not cancel the sole full path in an unlabeled ask', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-author-unlabeled-writer-'));
  try {
    const target = 'bin/elanous.mjs';
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, target), 'export {};\n');
    const written = await writeAuthoredGoal(`Warm ${target}; elanous.mjs is also mentioned.`, root, {
      ground: async () => ({ ...empty, persistentEvidence: ['Read verified boot behavior without a path'] }),
      enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
      slugFn: async () => 'unlabeled-writer',
    });
    expect(tracedPathReferences(written.authored.document).map(({ path }) => path)).toEqual([target]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a comma inside a declared filename is not a target separator', async () => {
  const result = await authoredPaths('대상 경로: src/a,b.ts\n쉼표 파일을 고친다.', [], [], ['src/a,b.ts']);
  expect(result.paths).toEqual(['src/a,b.ts']);
  expect(result.section).not.toContain('미해석:');
});

test('an unparsed target label does not promote an unrelated ask path', async () => {
  const result = await authoredPaths('대상 경로: ???\nsrc/other.ts를 참고한다.', [], [], ['src/other.ts']);
  expect(result.paths).toEqual([]);
  expect(result.section).toContain('미해석: ???');
});

test('an empty target label does not promote a reference path', async () => {
  const result = await authoredPaths('대상 경로:\nsrc/other.ts를 참고한다.', [], [], ['src/other.ts']);
  expect(result.paths).toEqual([]);
  expect(result.section).toContain('미해석: (빈 대상 경로)');
});

test('a partially parsed target label keeps its unparsed piece visible', async () => {
  const result = await authoredPaths('대상 경로: src/a.ts · ???\n두 대상을 고친다.', [], [], ['src/a.ts']);
  expect(result.paths).toEqual(['src/a.ts']);
  expect(result.section).toContain('미해석: ???');
});

test('a path and unknown text in the same target piece keep the unknown text visible', async () => {
  const result = await authoredPaths('대상 경로: src/a.ts ???\n대상을 고친다.', [], [], ['src/a.ts']);
  expect(result.paths).toEqual(['src/a.ts']);
  expect(result.section).toContain('미해석: ???');
});

test('only an explicit new-file declaration permits a missing traced target', async () => {
  const target = 'scripts/new-cycle-e2e.ts';
  const result = await authoredPaths(`대상 경로: ${target}\n신설: ${target}\n새 시험을 만든다.`, [], [], []);
  expect(result.paths).toEqual([target]);
  expect(result.section).not.toContain(`미해석: ${target}`);
});

test('a bare evidence filename cannot borrow an explicitly new path as if it existed', async () => {
  const target = 'scripts/new-cycle-e2e.ts';
  const result = await authoredPaths(`대상 경로: ${target}\n신설: ${target}\n새 시험을 만든다.`, [], ['new-cycle-e2e.ts was named without a directory'], []);
  expect(result.paths).toEqual([target]);
  expect(result.section).toContain('미해석: new-cycle-e2e.ts');
});

test('authoring without a repository root preserves the existing evidence rendering contract', async () => {
  const authored = await authorGoal('대상 경로: src/plugins/core/trust-store.ts\n고립된 근거를 기록한다.', {
    ground: async () => ({ ...empty, persistentEvidence: ['src/plugins/core/trust-store.ts was named; plugin-trust.json was also named'] }),
    enhance: async (original) => ({ original, checklist: [], verbatimPreserved: true }),
    slugFn: async () => 'unresolved-bare',
  });
  expect(tracedPathReferences(authored.document).map(({ path }) => path)).toEqual([
    'src/plugins/core/trust-store.ts', 'plugin-trust.json',
  ]);
  expect(authored.document).not.toContain('미해석:');
});
