import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { runGraph } from '../../src/graph-runner/runner.js';

const graph = join(import.meta.dir, 'draft-cleanup.yaml');
const recipes = parse(readFileSync(join(import.meta.dir, 'recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sweep = async (input?: { mode: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-'));
  roots.push(root);
  const calls: Array<{ node: string; command: string; input: unknown }> = [];
  const result = await runGraph(graph, { input, deps: { root, runBash: async (command, opts) => {
    const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
      nodeId: string; input: unknown; outputs: Record<string, unknown>;
    };
    calls.push({ node: context.nodeId, command, input: context.input });
    if (context.nodeId === 'apply') expect(context.outputs.classify).toMatchObject({ outcome: 'live' });
    return { stdout: JSON.stringify({ outcome: context.nodeId === 'classify' ? input?.mode ?? 'shadow' : 'ok' }),
      stderr: '', exitCode: 0 };
  } } });
  return { result, calls };
};

describe('draft-cleanup graph', () => {
  it('defaults to shadow and skips apply entirely', async () => {
    const { result, calls } = await sweep();
    expect(result.status).toBe('done');
    expect(calls.map(({ node }) => node)).toEqual(['classify']);
    expect(calls[0]!.command).toBe(recipes.classify!.command);
    expect(recipes.classify!.command).toContain('"sweep", "--json"');
    expect(recipes.classify!.command).toContain('ELANOUS_GRAPH_DIR');
    expect(recipes.classify!.command).toContain('"shadow"');
    expect(recipes.classify!.command).toContain('result.apply !== false');
    expect(recipes.classify!.command).toContain('if (run.exitCode !== 0)');
    expect(recipes.classify!.command).not.toContain('"--apply"');
  });

  it('executes shadow and live recipes through the real CLI in an isolated GitHub fixture', async () => {
    for (const mode of ['shadow', 'live'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-cli-'));
      roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const bun = Bun.which('bun')!;
    const git = Bun.which('git')!;
    const invocations = join(root, 'gh-invocations');
    const cliInvocations = join(root, 'cli-invocations');
    const install = (name: string, script: string) => {
      const file = join(bin, name);
      writeFileSync(file, script);
      chmodSync(file, 0o755);
    };
    install('bun', `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\nprintf '%s\\n' "$*" >> "${cliInvocations}"\nentry=$1; shift\nexec "${bun}" "$entry" --test "$@"\n`);
    install('gh', `#!/bin/sh\nprintf '%s\\n' "$*" >> "${invocations}"\ncase "$*" in\n  'repo view --json nameWithOwner --jq .nameWithOwner') echo 'test/repo' ;;\n  *'pulls?state=open'*) echo '[{"number":81,"title":"already landed","draft":true,"state":"open","head":{"ref":"self-impl/goalid-51-run"},"labels":[{"name":"elanous:stalled"}],"created_at":"2026-09-28T00:00:00Z","updated_at":"2026-09-28T00:00:00Z","merged_at":null},{"number":83,"title":"protected draft","draft":true,"state":"open","head":{"ref":"self-impl/goalid-53-run"},"labels":[{"name":"elanous:keep"}],"created_at":"2026-09-28T00:00:00Z","updated_at":"2026-09-28T00:00:00Z","merged_at":null}]' ;;\n  *'pulls?state=closed'*) echo '[{"number":82,"title":"already landed","draft":false,"state":"closed","head":{"ref":"self-impl/goalid-51-landed"},"base":{"ref":"main"},"labels":[],"created_at":"2026-09-28T01:00:00Z","updated_at":"2026-09-29T00:00:00Z","merged_at":"2026-09-29T00:00:00Z"}]' ;;\n  'pr edit 81 --repo test/repo --add-label elanous:superseded --remove-label elanous:stalled') echo "$*" >> "${root}/mutations" ;;\n  pr\\ close\\ 81\\ --repo\\ test/repo*) echo "$*" >> "${root}/mutations" ;;\n  *'/files?'*) echo '[]' ;;\n  *'/commits?'*) echo '[]' ;;\n  *'/comments?'*) echo '[]' ;;\n  *'/commits/'*'/status') echo '{"state":"success"}' ;;\n  *'/check-runs?'*) echo '{"check_runs":[]}' ;;\n  *'/commits/'*) echo '{"commit":{"message":""},"files":[]}' ;;\n  *'/reviews?'*) echo '[]' ;;\n  *'/pulls/'[0-9]*) echo '{"head":{"sha":"abc123"}}' ;;\n  *) exit 91 ;;\nesac\n`);
    install('git', `#!/bin/sh\ncase "$*" in\n  'config --get remote.origin.url') echo 'https://github.com/test/repo.git' ;;\n  'worktree list --porcelain') echo '' ;;\n  *) exec "${git}" "$@" ;;\nesac\n`);
    const previousPath = process.env.PATH;
    const previousState = process.env.ELANOUS_STATE_DIR;
    const previousConfig = process.env.ELANOUS_CONFIG_DIR;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      process.env.ELANOUS_STATE_DIR = join(root, 'state');
      process.env.ELANOUS_CONFIG_DIR = join(root, 'config');
      const result = await runGraph(graph, { input: { mode }, deps: { root: join(root, 'graph-state') } });
      expect(result.status, JSON.stringify(result.nodes) + '\nGH: ' + readFileSync(invocations, 'utf8') + '\nCLI: ' + readFileSync(cliInvocations, 'utf8')).toBe('done');
      expect(result.path).toEqual(mode === 'live' ? ['classify', 'apply', 'done'] : ['classify', 'done']);
      expect(result.nodes[0]?.exit).toBe(0);
      expect(JSON.parse(result.nodes[0]?.output as string)).toMatchObject({
        outcome: mode, counts: { 'superseded-by #82': 1, 'label:elanous:keep': 1 },
        entries: [{ number: 81, action: 'close', reason: 'superseded-by #82', applied: false },
          { number: 83, action: 'keep', applied: false }],
      });
      if (mode === 'live') {
        expect(result.nodes[1]?.exit).toBe(0);
        expect(JSON.parse(result.nodes[1]?.output as string)).toMatchObject({
          outcome: 'ok', entries: [{ number: 81, action: 'close', applied: true },
            { number: 83, action: 'keep', applied: false }],
        });
      }
      const invoked = readFileSync(cliInvocations, 'utf8').trim().split('\n');
      expect(invoked).toHaveLength(mode === 'live' ? 2 : 1);
      expect(invoked[0]).toContain('bin/elanous.mjs harness drafts sweep --json');
      if (mode === 'live') expect(invoked[1]).toContain('harness drafts sweep --json --apply');
      const githubCalls = readFileSync(invocations, 'utf8').trim().split('\n');
      // Each sweep lists open PRs once: the RUN-TTL step reuses the draft inventory's listing (DRAFT-SWEEP-SLOW).
      expect(githubCalls.filter((call) => call.includes('pulls?state=open'))).toHaveLength(mode === 'live' ? 2 : 1);
      expect(githubCalls.filter((call) => call.includes('pulls?state=closed'))).toHaveLength(mode === 'live' ? 2 : 1);
      // Read-only GETs (PR detail, files, commits, reviews, comments, commit status) and the batched GraphQL `query` feed the classifier; only edits/closes are mutations.
      const readOnly = (call: string) => /^api graphql -f query=query \{ repository\(/.test(call) || /^api repos\/[^ ]+\/(?:pulls\/\d+(?:\/(?:files|commits|reviews))?|issues\/\d+\/comments|commits\/[0-9a-f]+)\b/.test(call) && !/\s-X\s|--method/.test(call);
      const mutations = githubCalls.filter((call) => !call.startsWith('repo view') && !call.includes('pulls?state=') && !readOnly(call));
      if (mode === 'shadow') expect(mutations).toEqual([]);
      else {
        expect(mutations).toEqual([
          'pr edit 81 --repo test/repo --add-label elanous:superseded --remove-label elanous:stalled',
          'pr close 81 --repo test/repo --comment Draft sweep: superseded-by #82 (https://github.com/test/repo/pull/82). Branch preserved.',
        ]);
        expect(readFileSync(join(root, 'mutations'), 'utf8').trim().split('\n')).toEqual(mutations);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousState;
      if (previousConfig === undefined) delete process.env.ELANOUS_CONFIG_DIR; else process.env.ELANOUS_CONFIG_DIR = previousConfig;
    }
    }
  }, 120_000);

  it('runs sweep in ELANOUS_DRAFT_SWEEP_GIT_CWD and surfaces the JSON error when it exits non-zero', async () => {
    // Installed rails have no .git: branch liveness needs a checkout, and the sweep reports its reason on stdout.
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-cwd-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const checkout = join(root, 'checkout');
    mkdirSync(bin);
    mkdirSync(checkout);
    const bun = Bun.which('bun')!;
    const seen = join(root, 'cwd');
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\npwd -P > "${seen}"\necho '{"complete":false,"apply":false,"error":"Branch liveness unavailable"}'\nexit 1\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const previousPath = process.env.PATH;
    const previousCwd = process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD = checkout;
      const result = await runGraph(graph, { deps: { root: join(root, 'graph-state') } });
      expect(result.status).toBe('failed');
      expect(readFileSync(seen, 'utf8').trim()).toBe(spawnSync('pwd', ['-P'], { cwd: checkout, encoding: 'utf8' }).stdout.trim());
      expect(JSON.stringify(result.nodes[0])).toContain('Branch liveness unavailable');
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousCwd === undefined) delete process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD; else process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD = previousCwd;
    }
  }, 60_000);

  it('also skips apply for explicit shadow input', async () => {
    const { result, calls } = await sweep({ mode: 'shadow' });
    expect(result.status).toBe('done');
    expect(calls.map(({ node }) => node)).toEqual(['classify']);
  });

  it('runs apply only for explicit live input, with --apply in its command', async () => {
    const { result, calls } = await sweep({ mode: 'live' });
    expect(result.status).toBe('done');
    expect(calls.map(({ node }) => node)).toEqual(['classify', 'apply']);
    expect(calls[1]!.command).toBe(recipes.apply!.command);
    expect(recipes.apply!.command).toContain('"sweep", "--json", "--apply"');
    expect(recipes.apply!.command).toContain('ctx.input?.mode !== "live"');
    expect(recipes.apply!.command).toContain('ELANOUS_GRAPH_DIR');
    expect(recipes.apply!.command).toContain('result.apply !== true');
  });

  it('recipe commands reject invalid modes before invoking the sweep', () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-'));
    roots.push(root);
    const context = join(root, 'context.json');
    writeFileSync(context, JSON.stringify({ input: { mode: 'invalid' }, outputs: {} }));
    const classified = spawnSync('/bin/bash', ['-c', recipes.classify!.command], {
      cwd: join(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, encoding: 'utf8',
    });
    expect(classified.status).not.toBe(0);
    expect(classified.stderr).toContain('draft cleanup mode must be shadow or live');
    writeFileSync(context, JSON.stringify({ input: { mode: 'shadow' }, outputs: { classify: { outcome: 'live' } } }));
    const applied = spawnSync('/bin/bash', ['-c', recipes.apply!.command], {
      cwd: join(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context }, encoding: 'utf8',
    });
    expect(applied.status).not.toBe(0);
    expect(applied.stderr).toContain('draft cleanup apply requires live mode');
  });

  it('routes classification failure away from apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-'));
    roots.push(root);
    const calls: string[] = [];
    const result = await runGraph(graph, { input: { mode: 'live' }, deps: { root, runBash: async (_command, opts) => {
      calls.push(JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')).nodeId);
      return { stdout: '', stderr: 'inventory unavailable', exitCode: 1 };
    } } });
    expect(result.status).toBe('failed');
    expect(calls).toEqual(['classify']);
  });
});
