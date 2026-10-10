import { setDefaultTimeout, afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { runDocs } from './docs-node.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

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
  expect(notes).toContain('## Behavior changes\n\n- New behavior');
  expect(notes).not.toContain('github.com');
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

test('CLI rerun keeps previously landed linked and unlinked notes when their origin is unknown', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const existing = '# 9.9.9\n\nLaunch headline.\n\n## Behavior changes\n\n- Hand-written fix ([#52](https://github.com/ElanvitalAI/elanous/pull/52))\n- Hand-written unlinked fix.\n';
  writeFileSync(notes, existing);
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(notes, 'utf8')).toBe(existing);
});

test('pre-existing unrelated release notes without a pages entry are folded in, never overwritten or refused', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, 'Unrelated notes.\n');
  const result = run(['--version', '9.9.9', '--base', root, '--json']);
  expect(result.status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toStartWith('# 9.9.9\n\nUnrelated notes.\n');
  expect(text).toContain('- New behavior');
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
  expect(text).toContain('## Behavior changes\n\n- New behavior');
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
  expect(text).toContain('## Behavior changes\n\n- New behavior');
});

test('merging into a rendered section keeps a paragraph apart from the rendered list', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '## Behavior changes\n\n- New behavior\n\nA note about this change.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  expect(readFileSync(notes, 'utf8')).toContain('- New behavior\n\nA note about this change.\n');
});

test('a pre-landed section with the same heading as a rendered one merges into it', () => {
  const { root, run, notesDir } = fixture();
  const notes = join(notesDir, '9.9.9.md');
  writeFileSync(notes, '## Behavior changes\n\n- Early line under the same heading.\n');
  expect(run(['--version', '9.9.9', '--base', root, '--json']).status).toBe(0);
  const text = readFileSync(notes, 'utf8');
  expect(text).toContain('## Behavior changes\n\n- New behavior\n- Early line under the same heading.\n');
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

test('GATE-NODES-PARALLEL: a staged prefetch is what the late tui and docs nodes consume — one worktree, no TUI rerun, cache spent', async () => {
  const { stagePrefetch, joinTui, graphDocs, commandRunner } = await import('./docs-node.js');
  const { tuiChecks } = await import('./tui-node-checks.js');
  const { tuiNodeOutput } = await import('./tui-sim-node.js');
  const root = mkdtempSync(join(tmpdir(), 'release-docs-prefetch-'));
  scratch.push(root);
  const state = join(root, 'state');
  const commit = 'a'.repeat(40);
  const main = 'b'.repeat(40);
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({
    version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: commit },
    in: [{ sha: 'one', title: 'Title', line: 'New behavior', kind: 'feat', docs: 'present', prNumber: 42 }], deferred: [], escalate: [],
  }));
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: Object.fromEntries([
    ['version-release', { outcome: 'ok', commit }], ...['gate', 'prepare', 'upgrade', 'tui'].map((node) => [node, { outcome: 'ok' }]),
  ]) } as Parameters<typeof stagePrefetch>[0];
  writeFileSync(contextPath, JSON.stringify(context));
  const env = { ELANOUS_GRAPH_CONTEXT: contextPath };
  const calls: string[] = [];
  let currentMain = main;
  const run = (command: string, args: string[], cwd?: string, timeout?: number, childEnv?: NodeJS.ProcessEnv) => {
    // Docs staging is a real subprocess (the deadline must be able to stop it).
    if (command === process.execPath) return commandRunner(command, args, cwd, timeout, childEnv);
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git' && args[0] === 'rev-parse') return currentMain;
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const tree = args.includes('--detach') ? args[args.indexOf('--detach') + 1]! : args[args.indexOf('-b') + 2]!;
      mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
      mkdirSync(join(tree, 'website'), { recursive: true });
      writeFileSync(join(tree, 'website/pages.json'), JSON.stringify({ pages: [] }));
    }
    return '';
  };
  const first = '─┤ ChatLog ├──\n❯ /command, or type a question\n 📁 elan/monad-agent  │ ⌥ main │ some-model │ ctx 0 │ 🖥 mbp';
  const help = `┌── Dashboard help ──\n│Commands\n│/help  Show help overlay\n${first}`;
  let tuiRuns = 0;
  const tui = (at: string) => { tuiRuns++; return tuiNodeOutput(at, [{ checks: tuiChecks({ readyMs: 9000, first, help, afterEsc: first }) }], { unmeasured: 'fixture' }); };

  const staged = stagePrefetch(context, env, root, run, { stateRoot: state, tui });
  expect(staged).toMatchObject({ version: '9.9.9', commit, main, tree: join(contexts, 'docs-prefetch/tree') });
  expect(staged.docs.outcome).toBe('ok');
  expect(tuiRuns).toBe(1);
  const cacheFiles = () => readdirSync(join(contexts, 'docs-prefetch')).filter((name) => name.endsWith('.json'));
  expect(cacheFiles()).toHaveLength(1);
  // Second stage of the same cut is a cache hit (no second worktree, no second TUI).
  stagePrefetch(context, env, root, run, { stateRoot: state, tui });
  expect(tuiRuns).toBe(1);

  const joined = joinTui(context, env, root, () => { throw new Error('fallback must not run on a cache hit'); }, state);
  expect(joined).toMatchObject({ outcome: 'ok', commit, verdict: 'pass' });

  const docs = graphDocs(context, env, root, run, state);
  expect(docs).toMatchObject({ outcome: 'ok', version: '9.9.9', branch: 'release-docs/9.9.9', worktree: staged.tree });
  expect(calls.filter((call) => call.startsWith('git worktree add'))).toHaveLength(1);
  expect(calls).toContain(`git -C ${staged.tree} switch -c release-docs/9.9.9`);
  expect(calls.at(-1)).toBe('git push -u origin release-docs/9.9.9');
  expect(cacheFiles()).toHaveLength(0);

  // Spent cache: a resumed docs node (or a moved origin/main) takes the original fresh-worktree path.
  currentMain = 'c'.repeat(40);
  const fresh = graphDocs(context, env, root, run, state);
  if (fresh.worktree) scratch.push(dirname(fresh.worktree));
  expect(fresh.outcome).toBe('ok');
  expect(fresh.worktree).not.toBe(staged.tree);
  expect(calls.filter((call) => call.startsWith('git worktree add'))).toHaveLength(2);
});

// Real `bun scripts/release-loop/tui-sim-node.ts --commit <cut> --json` stdout (node-b shadow rehearsal 2026-10-10, 0.2.23 cut).
// It has NO `outcome` — node-verdict.ts tui adds that. The prefetch reuses THIS shape, so the reuse test must feed it.
const TUI_SIM_RAW_STDOUT = "{\"verdict\": \"pass\", \"commit\": \"4a8b340ca05e8e110a770563bd93c651146405e4\", \"attempts\": 1, \"checks\": [{\"id\": \"boot\", \"pass\": true, \"detail\": \"ready in 13430ms\"}, {\"id\": \"prompt\", \"pass\": true, \"detail\": \"input line (❯) on the first screen\"}, {\"id\": \"status-bar\", \"pass\": true, \"detail\": \"status bar with model and ctx\"}, {\"id\": \"help-opens\", \"pass\": true, \"detail\": \"/help shows the help overlay\"}, {\"id\": \"help-closes\", \"pass\": true, \"detail\": \"Esc closes the overlay\"}, {\"id\": \"no-error-text\", \"pass\": true, \"detail\": \"no error text on any screen\"}], \"png\": \"/var/folders/6w/lwcnwd3146s1sd01fxn67ggr0000gn/T/tui-node-2yTEFm/snap-001-release-check.png\", \"regress\": {\"results\": [{\"id\": \"R1\", \"title\": \"첫 화면 — 입력칸 · «Step 1» 0 (ONB1)\", \"ok\": true, \"reason\": \"입력칸이 보이고 «Step 1» 이 없다\"}, {\"id\": \"R2\", \"title\": \"빈 입력 Ctrl+C → 안내 → 2초 뒤 사라짐 (U1a · #22868)\", \"ok\": true, \"reason\": \"안내가 떴다가 2초 뒤 사라졌다\"}, {\"id\": \"R3\", \"title\": \"글 친 뒤 Ctrl+C → 입력 지움 · 안내 없음 (U1a)\", \"ok\": true, \"reason\": \"글이 지워지고 안내는 없다\"}, {\"id\": \"R4\", \"title\": \"owner 팔레트 — /directive · /help 보임 (MAT1c)\", \"ok\": true, \"reason\": \"/directive 보임 · /help 보임\"}, {\"id\": \"R5\", \"title\": \"general 팔레트 — /directive 숨김 · /help 보임 (MAT1c)\", \"ok\": true, \"reason\": \"/directive 숨김 · /help 보임\"}, {\"id\": \"R6\", \"title\": \"/help 가 그려지고 입력칸이 남는다 (U1b · #22802)\", \"ok\": true, \"reason\": \"도움말이 그려졌다(명령 줄 32 · Keys 절 · 입력칸 유지)\"}, {\"id\": \"R7\", \"title\": \"답 오는 중 쳐 둔 두 줄이 내 말로 차례로 (U1c2 · #23026 · 실제 LLM 턴)\", \"ok\": true, \"reason\": \"내 말2 → 답2 → 내 말3 → 답3\"}], \"pass\": 7, \"fail\": 0}}";

test('GATE-NODES-PARALLEL: a prefetched raw tui-sim result (no outcome field) is reused by the late tui node — no rerun', async () => {
  const { stagePrefetch, joinTui, commandRunner } = await import('./docs-node.js');
  const { lastResult } = await import('./node-verdict.js');
  const raw = JSON.parse(TUI_SIM_RAW_STDOUT) as Record<string, unknown>;
  expect(raw).not.toHaveProperty('outcome');
  const commit = String(raw.commit);
  const root = mkdtempSync(join(tmpdir(), 'release-docs-prefetch-raw-tui-'));
  scratch.push(root);
  const state = join(root, 'state');
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({
    version: '9.9.9', baseline: { ref: 'v9.9.8', sha: 'base' }, cutoff: { sha: commit },
    in: [{ sha: 'one', title: 'Title', line: 'New behavior', kind: 'feat', docs: 'present', prNumber: 42 }], deferred: [], escalate: [],
  }));
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: Object.fromEntries([
    ['version-release', { outcome: 'ok', commit }], ...['gate', 'prepare', 'upgrade'].map((node) => [node, { outcome: 'ok' }]),
  ]) } as Parameters<typeof stagePrefetch>[0];
  writeFileSync(contextPath, JSON.stringify(context));
  const env = { ELANOUS_GRAPH_CONTEXT: contextPath };
  const run = (command: string, args: string[], cwd?: string, timeout?: number, childEnv?: NodeJS.ProcessEnv) => {
    if (command === process.execPath) return commandRunner(command, args, cwd, timeout, childEnv);
    if (command === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const tree = args[args.indexOf('--detach') + 1]!;
      mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
      mkdirSync(join(tree, 'website'), { recursive: true });
      writeFileSync(join(tree, 'website/pages.json'), JSON.stringify({ pages: [] }));
    }
    return '';
  };
  // Exactly what the default (spawned) path yields: lastResult of the raw stdout line.
  const tui = () => lastResult({ status: 0, stdout: `${TUI_SIM_RAW_STDOUT}\n`, stderr: '' }) ?? null;
  const staged = stagePrefetch(context, env, root, run, { stateRoot: state, tui });
  expect(staged.tui).toMatchObject({ outcome: 'ok', verdict: 'pass', commit, attempts: 1 });
  const joined = joinTui(context, env, root, () => { throw new Error('fallback must not run: the prefetched TUI is reusable'); }, state);
  expect(joined).toMatchObject({ outcome: 'ok', verdict: 'pass', commit, summary: 'tui pass' });
});

test('GATE-NODES-PARALLEL: the real prefetch entrypoint treats a pre-worker failure as a cache miss, not a graph failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-docs-prefetch-miss-'));
  scratch.push(root);
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  // No manifest under the state root → cutFor throws before any worker could start.
  writeFileSync(contextPath, JSON.stringify({ nodeId: 'prefetch', input: { version: '9.9.9', previousVersion: '9.9.8' },
    outputs: { 'version-release': { outcome: 'ok', commit: 'a'.repeat(40) } } }));
  const result = spawnSync(process.execPath, [resolve(import.meta.dir, 'docs-node.ts')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_GRAPH_CONTEXT: contextPath },
  });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  expect(output).toMatchObject({ outcome: 'ok', verdict: 'pass', version: '9.9.9' });
  expect(output.summary).toStartWith('prefetch skipped (cache miss):');
  expect(existsSync(join(contexts, 'docs-prefetch'))).toBe(false);
});

test('GATE-NODES-PARALLEL: an asynchronous worker spawn error is handled (cache miss), and a failed TUI fallback never passes on an earlier ok line', async () => {
  const { EventEmitter } = await import('node:events');
  const { startPrefetchWorker, joinTui } = await import('./docs-node.js');
  // Spawn that reports failure asynchronously (no pid, then an `error` event) — must throw synchronously and leave a handled listener.
  const failing = Object.assign(new EventEmitter(), { pid: undefined, unref() {} });
  expect(() => startPrefetchWorker('9.9.9', 'a'.repeat(40), () => failing as never)).toThrow('prefetch worker did not start');
  expect(failing.listenerCount('error')).toBe(1);
  expect(() => failing.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  const started = Object.assign(new EventEmitter(), { pid: 4242, unrefCalled: false, unref() { this.unrefCalled = true; } });
  expect(startPrefetchWorker('9.9.9', 'a'.repeat(40), () => started as never)).toBe(4242);
  expect(started.unrefCalled).toBe(true);
  expect(() => started.emit('error', new Error('late'))).not.toThrow();

  const root = mkdtempSync(join(tmpdir(), 'release-docs-tui-fallback-'));
  scratch.push(root);
  const state = join(root, 'state');
  const commit = 'a'.repeat(40);
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', cutoff: { sha: commit }, in: [] }));
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: {
    'version-release': { outcome: 'ok', commit }, upgrade: { outcome: 'ok' } } } as Parameters<typeof joinTui>[0];
  const ok = JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'tui pass' }) + '\n';
  const env = { ELANOUS_GRAPH_CONTEXT: join(root, 'no-run.json') };
  expect(() => joinTui(context, env, root, () => ({ status: null, stdout: ok, stderr: 'timeout' }), state)).toThrow('tui fallback exited null');
  expect(() => joinTui(context, env, root, () => ({ status: 2, stdout: ok, stderr: '' }), state)).toThrow('tui fallback exited 2');
  expect(joinTui(context, env, root, () => ({ status: 0, stdout: ok, stderr: '' }), state)).toMatchObject({ outcome: 'ok' });
  // No manifest at all (cache key cannot be computed) is a miss → the original TUI path runs.
  let fellBack = 0;
  expect(joinTui(context, env, root, () => { fellBack++; return { status: 0, stdout: ok, stderr: '' }; }, join(root, 'no-state'))).toMatchObject({ outcome: 'ok' });
  expect(fellBack).toBe(1);
  expect(() => joinTui(context, env, root, () => ({ status: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'fail' }) + '\n', stderr: '' }), state)).toThrow('verdict fail');
  const failed = JSON.stringify({ outcome: 'fail', verdict: 'fail', summary: 'tui fail' }) + '\n';
  expect(() => joinTui(context, env, root, () => ({ status: 5, stdout: failed, stderr: '' }), state)).toThrow('tui fallback exited 5');
  expect(() => joinTui(context, env, root, () => ({ status: 2, stdout: JSON.stringify({ outcome: 'error', verdict: 'pass' }) + '\n', stderr: '' }), state)).toThrow('verdict pass');
  expect(joinTui(context, env, root, () => ({ status: 2, stdout: JSON.stringify({ outcome: 'error', verdict: 'fail' }) + '\n', stderr: '' }), state)).toMatchObject({ outcome: 'error' });
  expect(() => joinTui(context, env, root, () => ({ status: 1, stdout: JSON.stringify({ outcome: 'fail', verdict: 'pass' }) + '\n', stderr: '' }), state)).toThrow('verdict pass');
  expect(joinTui(context, env, root, () => ({ status: 1, stdout: failed, stderr: '' }), state)).toMatchObject({ outcome: 'fail' });
});

test('GATE-NODES-PARALLEL: a prefetch that publishes after the docs node missed is never consumed by a resumed docs node', async () => {
  const { stagePrefetch, graphDocs, commandRunner } = await import('./docs-node.js');
  const root = mkdtempSync(join(tmpdir(), 'release-docs-late-prefetch-'));
  scratch.push(root);
  const state = join(root, 'state');
  const commit = 'a'.repeat(40);
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', cutoff: { sha: commit },
    in: [{ sha: 'one', title: 'Title', line: 'New behavior', kind: 'feat', docs: 'present', prNumber: 42 }], deferred: [], escalate: [] }));
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: Object.fromEntries([
    ['version-release', { outcome: 'ok', commit }], ...['gate', 'prepare', 'upgrade', 'tui'].map((node) => [node, { outcome: 'ok' }]),
  ]) } as Parameters<typeof stagePrefetch>[0];
  writeFileSync(contextPath, JSON.stringify(context));
  const env = { ELANOUS_GRAPH_CONTEXT: contextPath };
  const calls: string[] = [];
  const run = (command: string, args: string[], cwd?: string, timeout?: number, childEnv?: NodeJS.ProcessEnv) => {
    // Docs staging is a real subprocess (the deadline must be able to stop it).
    if (command === process.execPath) return commandRunner(command, args, cwd, timeout, childEnv);
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const tree = args.includes('--detach') ? args[args.indexOf('--detach') + 1]! : args[args.indexOf('-b') + 2]!;
      if (!args.includes('--detach')) scratch.push(dirname(tree));
      mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
      mkdirSync(join(tree, 'website'), { recursive: true });
      writeFileSync(join(tree, 'website/pages.json'), JSON.stringify({ pages: [] }));
    }
    return '';
  };
  // A first docs attempt that FAILS before any check (gate output missing) still claims the slot — the worker cannot publish after it.
  const failedGate = { ...context, outputs: { ...context.outputs, tui: { outcome: 'fail' } } } as typeof context;
  expect(graphDocs(failedGate, env, root, run, state)).toMatchObject({ outcome: 'error', error: 'tui did not pass' });
  expect(readFileSync(join(contexts, 'docs-prefetch', 'claim'), 'utf8')).toBe('docs');
  // docs runs (cache miss → fresh path), then the slow worker tries to publish.
  expect(graphDocs(context, env, root, run, state).outcome).toBe('ok');
  expect(() => stagePrefetch(context, env, root, run, { stateRoot: state, tui: () => null })).toThrow('docs node already ran');
  expect(readdirSync(join(contexts, 'docs-prefetch')).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  // Even a cache file that slipped in is ignored on a resumed docs attempt: no `switch -c`, a fresh worktree again.
  writeFileSync(join(contexts, 'docs-prefetch', 'stray.json'), '{}');
  const resumed = graphDocs(context, env, root, run, state);
  expect(resumed.outcome).toBe('ok');
  expect(calls.some((call) => call.includes(' switch -c '))).toBe(false);
  expect(calls.filter((call) => call.startsWith('git worktree add -b'))).toHaveLength(2);
});

test('GATE-NODES-PARALLEL: the detached worker has one whole deadline — a docs stage running past it is killed, nothing is published, the staged worktree is removed', async () => {
  const { stagePrefetch, commandRunner } = await import('./docs-node.js');
  const root = mkdtempSync(join(tmpdir(), 'release-docs-prefetch-deadline-'));
  scratch.push(root);
  const state = join(root, 'state');
  const commit = 'a'.repeat(40);
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', cutoff: { sha: commit }, in: [] }));
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: { 'version-release': { outcome: 'ok', commit } } } as Parameters<typeof stagePrefetch>[0];
  writeFileSync(contextPath, JSON.stringify(context));
  const calls: Array<{ call: string; timeout?: number }> = [];
  let docsTimeout: number | undefined;
  const run = (command: string, args: string[], cwd?: string, timeout?: number) => {
    if (command === process.execPath) {
      // The real docs stage, slowed to 10 s — far past the budget the deadline leaves it.
      docsTimeout = timeout;
      return commandRunner(process.execPath, ['-e', 'await Bun.sleep(10_000)'], cwd, timeout);
    }
    calls.push({ call: `${command} ${args.slice(0, 2).join(' ')}`, timeout });
    if (command === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
    return '';
  };
  const started = Date.now();
  expect(() => stagePrefetch(context, { ELANOUS_GRAPH_CONTEXT: contextPath }, root, run, { stateRoot: state, tui: () => null, deadline: started + 1_500 }))
    .toThrow(/failed/);
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(docsTimeout).toBeLessThanOrEqual(1_500);
  expect(calls.map(({ call }) => call)).toContain('git worktree remove');
  expect(readdirSync(join(contexts, 'docs-prefetch')).filter((name) => name.endsWith('.json') || name === 'claim')).toHaveLength(0);
});

test('GATE-NODES-PARALLEL: worker claimed first but its valid cache appears only after the first docs attempt — a resumed docs never consumes it', async () => {
  const { stagePrefetch, graphDocs, commandRunner } = await import('./docs-node.js');
  const root = mkdtempSync(join(tmpdir(), 'release-docs-late-valid-'));
  scratch.push(root);
  const state = join(root, 'state');
  const commit = 'a'.repeat(40);
  mkdirSync(join(state, 'release/9.9.9'), { recursive: true });
  writeFileSync(join(state, 'release/9.9.9/manifest.json'), JSON.stringify({ version: '9.9.9', cutoff: { sha: commit },
    in: [{ sha: 'one', title: 'Title', line: 'New behavior', kind: 'feat', docs: 'present', prNumber: 42 }], deferred: [], escalate: [] }));
  const contexts = join(root, 'run.json.contexts');
  mkdirSync(contexts);
  const contextPath = join(contexts, '1.json');
  const context = { input: { version: '9.9.9', previousVersion: '9.9.8' }, outputs: Object.fromEntries([
    ['version-release', { outcome: 'ok', commit }], ...['gate', 'prepare', 'upgrade', 'tui'].map((node) => [node, { outcome: 'ok' }]),
  ]) } as Parameters<typeof stagePrefetch>[0];
  writeFileSync(contextPath, JSON.stringify(context));
  const env = { ELANOUS_GRAPH_CONTEXT: contextPath };
  const calls: string[] = [];
  const run = (command: string, args: string[], cwd?: string, timeout?: number, childEnv?: NodeJS.ProcessEnv) => {
    if (command === process.execPath) return commandRunner(command, args, cwd, timeout, childEnv);
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git' && args[0] === 'rev-parse') return 'b'.repeat(40);
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const tree = args.includes('--detach') ? args[args.indexOf('--detach') + 1]! : args[args.indexOf('-b') + 2]!;
      if (!args.includes('--detach')) scratch.push(dirname(tree));
      mkdirSync(join(tree, 'release/public/docs/releases'), { recursive: true });
      mkdirSync(join(tree, 'website'), { recursive: true });
      writeFileSync(join(tree, 'website/pages.json'), JSON.stringify({ pages: [] }));
    }
    return '';
  };
  // The worker wins the claim and publishes a VALID cache for this cut …
  stagePrefetch(context, env, root, run, { stateRoot: state, tui: () => null });
  const dir = join(contexts, 'docs-prefetch');
  const [cacheName] = readdirSync(dir).filter((name) => name.endsWith('.json'));
  expect(readFileSync(join(dir, 'claim'), 'utf8')).toBe('worker');
  // … but it is not visible yet when the first docs attempt looks (published «late»).
  renameSync(join(dir, cacheName!), join(dir, `${cacheName}.late`));
  expect(graphDocs(context, env, root, run, state).outcome).toBe('ok');
  renameSync(join(dir, `${cacheName}.late`), join(dir, cacheName!));
  const resumed = graphDocs(context, env, root, run, state);
  expect(resumed.outcome).toBe('ok');
  expect(resumed.worktree).not.toBe(join(dir, 'tree'));
  expect(calls.some((call) => call.includes(' switch -c '))).toBe(false);
  expect(calls.filter((call) => call.startsWith('git worktree add -b'))).toHaveLength(2);
});
