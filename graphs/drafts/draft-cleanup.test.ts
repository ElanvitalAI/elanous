import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    return { stdout: JSON.stringify({ outcome: context.nodeId === 'classify' ? input?.mode ?? 'shadow' : 'ok',
      applyPlan: { version: 1, closeCap: 10, closeCapSource: 'default', entries: [] } }),
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
    expect(recipes.classify!.command).toContain('"--max-pages", "100", "--max-drafts", "300", "--max-merged", "1000"');
    expect(recipes.classify!.command).toContain('ELANOUS_GRAPH_DIR');
    expect(recipes.classify!.command).toContain('"shadow"');
    expect(recipes.classify!.command).toContain('result.apply !== false');
    expect(recipes.classify!.command).toContain('"--emit-apply-plan"');
    expect(recipes.classify!.command).toContain('maxBuffer:maxOutputBytes');
    expect(recipes.classify!.command).toContain('truncated:run.exitedDueToMaxBuffer === true');
    expect(recipes.classify!.command).toContain('truncated: output exceeded ');
    expect(recipes.classify!.command).toContain('classification apply plan missing or incomplete');
    expect(recipes.classify!.command).toContain('if (run.exitCode !== 0)');
    expect(recipes.classify!.command).toContain('draft-cleanup.stdout');
    expect(recipes.classify!.command).toContain('draft-cleanup.stderr');
    expect(recipes.classify!.command).toContain('draft-cleanup.evidence.json');
    expect(recipes.classify!.command).toContain('draft cleanup inventory incomplete');
    expect(recipes.classify!.command).not.toContain('"--apply"');
  });

  it('preserves and parses a 700 KB classify response beyond the former output cutoff', async () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-large-output-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const graphState = join(root, 'graph-state');
    mkdirSync(bin);
    const bun = Bun.which('bun')!;
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\nexec "${bun}" -e 'const result={repository:"test/repo",apply:false,complete:true,entries:[],counts:{},applyPlan:{version:1,entries:[]},padding:"x".repeat(700_000)}; console.log(JSON.stringify(result))'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      const result = await runGraph(graph, { deps: { root: graphState } });
      expect(result.status).toBe('done');
      const evidenceFiles = await Array.fromAsync(new Bun.Glob('**/*.draft-cleanup.evidence.json').scan({ cwd: graphState, onlyFiles: true }));
      expect(evidenceFiles).toHaveLength(1);
      const metaPath = join(graphState, evidenceFiles[0]!);
      const evidenceBase = metaPath.replace('.draft-cleanup.evidence.json', '');
      const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
      const stdout = readFileSync(evidenceBase + '.draft-cleanup.stdout', 'utf8');
      expect(Buffer.byteLength(stdout)).toBeGreaterThan(700_000);
      expect(JSON.parse(stdout)).toMatchObject({ complete: true, apply: false });
      expect(metadata).toMatchObject({ stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, maxOutputBytes: 16 * 1024 * 1024, truncated: false });
      expect(readFileSync(evidenceBase + '.draft-cleanup.stderr', 'utf8')).toBe('');
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  }, 30_000);

  it('records an output-limit truncation and fails closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-truncated-output-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const graphState = join(root, 'graph-state');
    mkdirSync(bin);
    const bun = Bun.which('bun')!;
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\nexec "${bun}" -e 'process.stdout.write("x".repeat(17*1024*1024))'\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      const result = await runGraph(graph, { deps: { root: graphState } });
      expect(result.status).toBe('failed');
      expect(JSON.stringify(result.nodes[0])).toContain('truncated: output exceeded 16777216 bytes');
      const evidenceFiles = await Array.fromAsync(new Bun.Glob('**/*.draft-cleanup.evidence.json').scan({ cwd: graphState, onlyFiles: true }));
      expect(evidenceFiles).toHaveLength(1);
      const metadata = JSON.parse(readFileSync(join(graphState, evidenceFiles[0]!), 'utf8'));
      expect(metadata).toMatchObject({ maxOutputBytes: 16 * 1024 * 1024, truncated: true });
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    }
  }, 30_000);

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
    install('gh', `#!/bin/sh\nprintf '%s\\n' "$*" >> "${invocations}"\ncase "$*" in\n  'repo view --json nameWithOwner --jq .nameWithOwner') echo 'test/repo' ;;\n  *'pulls?state=open'*) echo '[{"number":81,"title":"already landed","draft":true,"state":"open","head":{"ref":"self-impl/goalid-51-run","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"elanous:stalled"}],"created_at":"2026-09-28T00:00:00Z","updated_at":"2026-09-28T00:00:00Z","merged_at":null},{"number":83,"title":"protected draft","draft":true,"state":"open","head":{"ref":"self-impl/goalid-53-run","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"labels":[{"name":"elanous:keep"}],"created_at":"2026-09-28T00:00:00Z","updated_at":"2026-09-28T00:00:00Z","merged_at":null}]' ;;\n  *'pulls?state=closed'*) echo '[{"number":82,"title":"already landed","draft":false,"state":"closed","head":{"ref":"self-impl/goalid-51-landed"},"base":{"ref":"main"},"labels":[],"created_at":"2026-09-28T01:00:00Z","updated_at":"2026-09-29T00:00:00Z","merged_at":"2026-09-29T00:00:00Z"}]' ;;\n  'pr edit 81 --repo test/repo --add-label elanous:superseded --remove-label elanous:stalled') echo "$*" >> "${root}/mutations" ;;\n  'label create elanous:swept:superseded-by --repo test/repo --color 6A737D --description Draft sweep close reason; reopen this PR to restore it --force') echo "$*" >> "${root}/mutations" ;;\n  'pr edit 81 --repo test/repo --add-label elanous:swept:superseded-by') echo "$*" >> "${root}/mutations" ;;\n  pr\\ close\\ 81\\ --repo\\ test/repo*) echo "$*" >> "${root}/mutations" ;;\n  *'/files?'*) echo '[]' ;;\n  *'/commits?'*) echo '[]' ;;\n  *'/comments?'*) echo '[]' ;;\n  *'/commits/'*'/status') echo '{"state":"success"}' ;;\n  *'/check-runs?'*) echo '{"total_count":0,"check_runs":[]}' ;;\n  *'/commits/'*) echo '{"commit":{"message":""},"files":[]}' ;;\n  *'/reviews?'*) echo '[]' ;;\n  *'/pulls/81') echo '{"number":81,"title":"already landed","draft":true,"state":"open","head":{"ref":"self-impl/goalid-51-run","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"elanous:stalled"}],"created_at":"2026-09-28T00:00:00Z","updated_at":"2026-09-28T00:00:00Z","merged_at":null}' ;;\n  *'/pulls/'[0-9]*) echo '{"head":{"sha":"abc123"}}' ;;\n  *) exit 91 ;;\nesac\n`);
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
      if (mode === 'live') {
        expect(invoked[1]).toContain('harness drafts sweep --json --apply --apply-plan-file');
        const planPath = /--apply-plan-file (\S+)/.exec(invoked[1]!)?.[1];
        expect(planPath).toBeDefined();
        expect(existsSync(planPath!)).toBe(false);
      }
      const githubCalls = readFileSync(invocations, 'utf8').trim().split('\n');
      // Each sweep lists open PRs once: the RUN-TTL step reuses the draft inventory's listing (DRAFT-SWEEP-SLOW).
      expect(githubCalls.filter((call) => call.includes('pulls?state=open'))).toHaveLength(1);
      expect(githubCalls.filter((call) => call.includes('pulls?state=closed'))).toHaveLength(1);
      // Read-only GETs and the batched GraphQL `query` feed the classifier; label creation, edits and closes are mutations.
      const readOnly = (call: string) => {
        // gh API pagination flags precede the endpoint in argv; normalize them before classifying the default GET.
        const normalized = call.replace(/^api (?:(?:--paginate|--slurp) )+/, 'api ');
        return /^api graphql -f query=query \{ repository\(/.test(normalized)
          || /^api repos\/[^ ]+\/(?:pulls\/\d+(?:\/(?:files|commits|reviews))?|issues\/\d+\/comments|commits\/[0-9a-f]+)\b/.test(normalized)
            && !/\s-X\s|--method/.test(normalized);
      };
      expect(readOnly('api --paginate -X DELETE repos/test/repo/issues/81/comments?per_page=100')).toBe(false);
      const mutations = githubCalls.filter((call) => !call.startsWith('repo view') && !call.includes('pulls?state=') && !readOnly(call));
      if (mode === 'shadow') expect(mutations).toEqual([]);
      else {
        expect(mutations).toEqual([
          'pr edit 81 --repo test/repo --add-label elanous:superseded --remove-label elanous:stalled',
          'label create elanous:swept:superseded-by --repo test/repo --color 6A737D --description Draft sweep close reason; reopen this PR to restore it --force',
          'pr edit 81 --repo test/repo --add-label elanous:swept:superseded-by',
          'pr close 81 --repo test/repo',
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

  it('runs sweep in ELANOUS_DRAFT_SWEEP_GIT_CWD, preserves raw evidence, and fails closed on non-zero exit', async () => {
    // Installed rails have no .git: branch liveness needs a checkout, and the sweep reports its reason on stdout.
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-cwd-'));
    roots.push(root);
    const bin = join(root, 'bin');
    const checkout = join(root, 'checkout');
    mkdirSync(bin);
    mkdirSync(checkout);
    const bun = Bun.which('bun')!;
    const seen = join(root, 'cwd');
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\npwd -P > "${seen}"\necho '{"complete":false,"apply":false,"error":"open PR inventory capped at 100 pages (10000 rows observed)"}'\necho 'inventory rows=10000' >&2\nexit 1\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const previousPath = process.env.PATH;
    const previousCwd = process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD = checkout;
      const result = await runGraph(graph, { deps: { root: join(root, 'graph-state') } });
      expect(result.status).toBe('failed');
      expect(readFileSync(seen, 'utf8').trim()).toBe(spawnSync('pwd', ['-P'], { cwd: checkout, encoding: 'utf8' }).stdout.trim());
      const failure = JSON.stringify(result.nodes[0]);
      expect(failure).toContain('open PR inventory capped at 100 pages (10000 rows observed)');
      expect(failure).toContain('inventory rows=10000');
      expect(failure.indexOf('open PR inventory capped at 100 pages (10000 rows observed)'))
        .toBeLessThan(failure.indexOf('inventory rows=10000'));
      const evidenceFiles = await Array.fromAsync(new Bun.Glob('**/*.draft-cleanup.*').scan({ cwd: join(root, 'graph-state'), onlyFiles: true }));
      expect(evidenceFiles).toHaveLength(3);
      for (const path of evidenceFiles) expect(statSync(join(root, 'graph-state', path)).mode & 0o777).toBe(0o600);
      const metaPath = evidenceFiles.find((path) => path.endsWith('.evidence.json'))!;
      const evidenceBase = join(root, 'graph-state', metaPath.replace('.draft-cleanup.evidence.json', ''));
      expect(readFileSync(evidenceBase + '.draft-cleanup.stdout', 'utf8')).toContain('"complete":false');
      expect(readFileSync(evidenceBase + '.draft-cleanup.stderr', 'utf8')).toContain('inventory rows=10000');
      expect(JSON.parse(readFileSync(join(root, 'graph-state', metaPath), 'utf8'))).toMatchObject({
        exitCode: 1, stdoutBytes: expect.any(Number), stderrBytes: expect.any(Number),
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousCwd === undefined) delete process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD; else process.env.ELANOUS_DRAFT_SWEEP_GIT_CWD = previousCwd;
    }
  }, 60_000);

  it('keeps apply failure cause before stderr progress and stops the live graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'draft-cleanup-apply-error-'));
    roots.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const bun = Bun.which('bun')!;
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\nif [ "$1" = "-e" ]; then exec "${bun}" "$@"; fi\ncase " $* " in\n  *' --apply '*) echo '{"complete":false,"apply":false,"error":"apply rejected: snapshot drift"}'; echo '[draft-sweep] preflight failed' >&2; exit 1 ;;\n  *) echo '{"complete":true,"apply":false,"counts":{},"entries":[],"applyPlan":{"version":1,"closeCap":10,"closeCapSource":"default","entries":[]}}' ;;\nesac\n`);
    chmodSync(join(bin, 'bun'), 0o755);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${previousPath}`;
      const result = await runGraph(graph, { input: { mode: 'live' }, deps: { root: join(root, 'graph-state') } });
      expect(result.status).toBe('failed');
      expect(result.path).toEqual(['classify', 'apply', 'failed']);
      const failure = JSON.stringify(result.nodes[1]);
      expect(failure).toContain('apply rejected: snapshot drift');
      expect(failure).toContain('preflight failed');
      expect(failure.indexOf('apply rejected: snapshot drift'))
        .toBeLessThan(failure.indexOf('preflight failed'));
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
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
    expect(recipes.apply!.command).toContain('"--apply-plan-file", planPath');
    expect(recipes.apply!.command).toContain('import("node:fs/promises")');
    expect(recipes.apply!.command).toContain('unlink(planPath).catch');
    expect(recipes.apply!.command).not.toContain('"--max-pages"');
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
