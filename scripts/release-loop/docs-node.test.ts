import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { runDocs } from './docs-node.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-node-'));
  scratch.push(root);
  const state = join(root, 'state');
  const notesDir = join(root, 'release/public/docs/releases');
  const docsDir = join(root, 'release/public/docs');
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(join(root, 'website'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({
    version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: 'cut' },
    in: [{ sha: 'one', title: 'Title', line: 'New behavior', kind: 'feat', docs: 'present', prNumber: 42 }],
    deferred: [{ sha: 'later', reason: 'release-target-later' }], escalate: [],
  }));
  writeFileSync(join(root, 'website/pages.json'), JSON.stringify({ categories: [], pages: [
    { id: 'intro', title: 'Intro' }, { id: 'releases/9.9.8', title: '9.9.8' }, { id: 'other', title: 'Other' },
  ] }, null, 2) + '\n');
  writeFileSync(join(docsDir, 'architecture.md'), '🟡 on main — next release\n🔄 in progress\n📋 designed\n');
  writeFileSync(join(docsDir, 'harness.md'), '🟡 on main, in the next release\n');
  writeFileSync(join(docsDir, 'intro.md'), 'No marker here.\n');
  mkdirSync(join(docsDir, 'guides/deep'), { recursive: true });
  writeFileSync(join(docsDir, 'guides/deep/tutorial.md'), '🟡 on main — next release\n🔄 in progress\n');
  const context = join(root, 'context.json');
  writeFileSync(context, JSON.stringify({ input: { version: '9.9.9', base: root } }));
  const run = (args: string[], graph: 'file' | 'inline' | false = false) => {
    const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'docs-node.ts'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: state, ELANOUS_GRAPH_CONTEXT: graph === 'file' ? context : graph === 'inline' ? readFileSync(context, 'utf8') : '' },
    });
    return { status: result.status, output: JSON.parse(result.stdout.trim()), stderr: result.stderr };
  };
  return { root, run, notesDir, docsDir };
}

test('CLI writes IN-only release notes, flips every public-doc marker, and registers a page once', () => {
  const { root, docsDir, notesDir, run } = fixture();
  const first = run(['--version', '9.9.9', '--base', root, '--json']);
  expect(first.status).toBe(0);
  expect(first.output).toMatchObject({ outcome: 'ok', version: '9.9.9' });
  const notes = readFileSync(join(notesDir, '9.9.9.md'), 'utf8');
  expect(notes).toContain('## Behavior changes\n\n- New behavior ([#42](https://github.com/ElanvitalAI/elanous/pull/42))');
  expect(notes).not.toContain('later');
  expect(readFileSync(join(docsDir, 'architecture.md'), 'utf8')).toBe('✅ in v9.9.9\n🔄 in progress\n📋 designed\n');
  expect(readFileSync(join(docsDir, 'harness.md'), 'utf8')).toBe('✅ in v9.9.9\n');
  expect(readFileSync(join(docsDir, 'guides/deep/tutorial.md'), 'utf8')).toBe('✅ in v9.9.9\n🔄 in progress\n');
  expect(first.output.flipped).toContain(join(docsDir, 'guides/deep/tutorial.md'));
  const pages = JSON.parse(readFileSync(join(root, 'website/pages.json'), 'utf8'));
  expect(pages.pages.slice(0, 3).map((page: { id: string }) => page.id)).toEqual(['intro', 'releases/9.9.9', 'releases/9.9.8']);
  expect(pages.pages[1]).toMatchObject({ slug: '/releases/9-9-9', source: 'release/public/docs/releases/9.9.9.md', since: '9.9.9' });
  const before = readFileSync(join(root, 'website/pages.json'), 'utf8');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(join(root, 'website/pages.json'), 'utf8')).toBe(before);
  writeFileSync(join(notesDir, '9.9.9.md'), 'Curated release notes.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(join(notesDir, '9.9.9.md'), 'utf8')).toBe('Curated release notes.\n');
});

for (const failedFile of ['9.9.9.md', 'harness.md', 'pages.json']) {
  test(`partial ${failedFile} temp write keeps destination intact and retry finishes`, () => {
    const { root, docsDir, notesDir } = fixture();
    const state = join(root, 'state');
    const target = failedFile === 'pages.json' ? join(root, 'website/pages.json')
      : failedFile === 'harness.md' ? join(docsDir, failedFile) : join(notesDir, failedFile);
    const original = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const failed = runDocs(['--version', '9.9.9', '--base', root, '--json'], root, {}, {
      stateRoot: state,
      writeTemp: (path, text) => {
        if (path.startsWith(join(dirname(target), `.${failedFile}.`))) {
          writeFileSync(path, text.slice(0, 5));
          throw new Error(`partial ${failedFile}`);
        }
        writeFileSync(path, text);
      },
    });
    expect(failed.outcome).toBe('error');
    expect(failed.error).toBe(`partial ${failedFile}`);
    expect(existsSync(target) ? readFileSync(target, 'utf8') : null).toBe(original);
    expect(readdirSync(dirname(target)).filter((name) => name.startsWith(`.${failedFile}.`))).toEqual([]);
    const retry = runDocs(['--version', '9.9.9', '--base', root, '--json'], root, {}, { stateRoot: state });
    expect(retry.outcome).toBe('ok');
    expect(readFileSync(join(notesDir, '9.9.9.md'), 'utf8')).toStartWith('# 9.9.9\n');
    expect(readFileSync(join(docsDir, 'harness.md'), 'utf8')).toBe('✅ in v9.9.9\n');
    expect(JSON.parse(readFileSync(join(root, 'website/pages.json'), 'utf8')).pages.filter((page: { id: string }) => page.id === 'releases/9.9.9')).toHaveLength(1);
  });
}

test('pre-existing unrelated release notes without a pages entry are folded in, never overwritten or refused', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, 'Unrelated notes.\n');
  const result = run(['--version', '9.9.9', '--base', root, '--json']);
  expect(result.status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toStartWith('# 9.9.9\n\nUnrelated notes.\n');
  expect(text).toContain('- New behavior ([#42]');
});

// Real sample (main, 09-29): #21496 landed its own line into releases/0.2.4.md before the release loop ran,
// and a headline paragraph is written at the top — the docs node used to throw and stall v0.2.4.
test('a line a PR landed early and a headline paragraph are both kept around the rendered notes', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  const landed = '- 크레딧 정책일 때 매시 한도 알림이 세 계정의 크레딧 합계와 합계 소모 속도로 «언제 바닥나는지»를 말합니다.';
  writeFileSync(notes, `Elanous now drives coding agents from inside their own screens.\n\n${landed}\n`);
  const result = run(['--version', '9.9.9', '--base', root, '--json']);
  expect(result.status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toStartWith('# 9.9.9\n\nElanous now drives coding agents from inside their own screens.\n');
  expect(text).toContain('## Behavior changes\n\n- New behavior ([#42]');
  expect(text).toContain(`## Also in this release\n\n${landed}\n`);
  expect(text.split(landed).length - 1).toBe(1);
  const pages = JSON.parse(readFileSync(join(root, 'website/pages.json'), 'utf8'));
  expect(pages.pages.filter((page: { id: string }) => page.id === 'releases/9.9.9')).toHaveLength(1);
  // Idempotent through the fold path itself: drop the pages entry the first run added, run again.
  pages.pages = pages.pages.filter((page: { id: string }) => page.id !== 'releases/9.9.9');
  writeFileSync(join(root, 'website/pages.json'), JSON.stringify(pages, null, 2) + '\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(notes, 'utf8')).toBe(text);
});

test('a line that differs from a rendered one only by its PR link is not repeated · pre-landed sections keep their heading', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '- New behavior\n\n## Known issues\n\n- Windows needs a restart after install.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text.match(/New behavior/g)).toHaveLength(1);
  expect(text).toContain('## Known issues\n\n- Windows needs a restart after install.\n');
  expect(text).not.toContain('## Also in this release');
});

test('paragraph breaks and empty pre-landed sections are kept', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, 'First paragraph.\n\n\nSecond paragraph.\n\n## Known issues\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toStartWith('# 9.9.9\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Behavior changes');
  expect(text).toContain('## Known issues');
});

test('paragraph breaks inside a pre-landed section are kept · a same-text line in another section is not dropped', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '## Known issues\n\nFirst note.\n\nSecond note.\n\n- New behavior\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toContain('## Known issues\n\nFirst note.\n\nSecond note.\n\n- New behavior\n');
  expect(text).toContain('## Behavior changes\n\n- New behavior ([#42]');
});

test('merging into a rendered section keeps a paragraph apart from the rendered list', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '## Behavior changes\n\n- New behavior\n\nA note about this change.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(notes, 'utf8')).toContain('- New behavior ([#42](https://github.com/ElanvitalAI/elanous/pull/42))\n\nA note about this change.\n');
});

test('a pre-landed section with the same heading as a rendered one merges into it', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '## Behavior changes\n\n- Early line under the same heading.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toContain('## Behavior changes\n\n- New behavior ([#42](https://github.com/ElanvitalAI/elanous/pull/42))\n- Early line under the same heading.\n');
  expect(text.match(/## Behavior changes/g)).toHaveLength(1);
  expect(text).not.toContain('## Also in this release');
});

test('invalid graph context still emits a final failure JSON line', () => {
  const { root } = fixture();
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'docs-node.ts'), '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_GRAPH_CONTEXT: '{invalid' },
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'error', verdict: 'fail' });
});

test('graph context file supplies version and base without flags', () => {
  const { root, run } = fixture();
  for (const graph of ['file', 'inline'] as const) {
    const result = run(['--json'], graph);
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ outcome: 'ok', version: '9.9.9', notes: join(root, 'release/public/docs/releases/9.9.9.md') });
  }
});

test('explicit version and base override graph context inputs', () => {
  const { root, run, notesDir } = fixture();
  const graphBase = join(root, 'graph-base');
  writeFileSync(join(root, 'context.json'), JSON.stringify({ input: { version: '1.2.3', base: graphBase } }));
  const result = run(['--version', '9.9.9', '--base', root, '--json'], 'file');
  expect(result.status).toBe(0);
  expect(result.output).toMatchObject({ outcome: 'ok', version: '9.9.9', notes: join(notesDir, '9.9.9.md') });
  expect(readFileSync(join(notesDir, '9.9.9.md'), 'utf8')).toStartWith('# 9.9.9\n');
  expect(existsSync(join(graphBase, 'release/public/docs/releases/1.2.3.md'))).toBe(false);
});

test('missing manifest and invalid version fail before changing any public docs', () => {
  const { root, docsDir, run } = fixture();
  const original = readFileSync(join(docsDir, 'architecture.md'), 'utf8');
  for (const version of ['9.9.8', '../escape']) {
    const result = run(['--version', version, '--base', root, '--json']);
    expect(result.status).toBe(1);
    expect(result.output.outcome).toBe('error');
  }
  expect(readFileSync(join(docsDir, 'architecture.md'), 'utf8')).toBe(original);
});
