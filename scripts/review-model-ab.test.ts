// `review-model-ab` 의 계약 — ⛔ 「돈을 안 쓴다」가 «기본»인가.
//
// 🩸 이 자는 유료 모델을 부른다. 그래서 무는 것은 산출 모양이 아니라 ***「부르지 않았나」***다.
import { setDefaultTimeout, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lookupLlmTierSpec } from '../src/model-tier/llm-tier-map.js';
import { diffOf } from './review-model-ab.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(240_000);

const SCRIPT = new URL('./review-model-ab.ts', import.meta.url).pathname;

function run(args: string[], options: { cwd?: string } = {}): { out: string; code: number } {
  // ⛔ 자격증명을 «지우고» 돌린다 — 실수로 모델을 불렀다면 여기서 터져야 한다(조용히 성공하면 안 된다).
  const env = { ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
  const r = spawnSync('bun', [SCRIPT, ...args], { ...options, encoding: 'utf8', env, timeout: 120_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const unmeasured = out.match(/UNMEASURED: diff context[^\r\n]*/)?.[0];
  if (unmeasured) console.warn(unmeasured);
  return { out, code: r.status ?? -1 };
}

describe('review-model-ab — 기본은 «돈을 안 쓴다»', () => {
  it('partial-clone diff uses available local objects and blocks missing ones with transports disabled', () => {
    const objectA = 'a'.repeat(40);
    const objectB = 'b'.repeat(40);
    const gitlink = 'c'.repeat(40);
    const gitlinkTarget = 'd'.repeat(40);
    const rawDiff = `:100644 100644 ${objectA} ${objectB} M\tfile.ts\n:160000 160000 ${gitlink} ${gitlinkTarget} M\tsubmodule\n`;
    const makeRunner = (missing = false) => {
      const commands: string[][] = [];
      const runner: NonNullable<Parameters<typeof diffOf>[2]> = (args, options) => {
        commands.push(args);
        expect(options.env.GIT_NO_LAZY_FETCH).toBe('1');
        expect(options.env.GIT_ALLOW_PROTOCOL).toBe('');
        expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
        if (args[0] === 'config') return 'remote.origin.promisor true\nremote.origin.partialclonefilter blob:none\n';
        if (args[0] === 'diff-tree') return rawDiff;
        if (args[0] === 'cat-file') {
          expect(args[2]).not.toBe(gitlink);
          expect(args[2]).not.toBe(gitlinkTarget);
          if (missing && args[2] === objectB) throw new Error('fatal: unable to read object');
          return '';
        }
        if (args[0] === 'show') return 'measured diff';
        throw new Error(`unexpected Git command: ${args.join(' ')}`);
      };
      return { commands, runner };
    };

    const complete = makeRunner();
    expect(diffOf('HEAD', false, complete.runner)).toBe('measured diff');
    expect(complete.commands.map(([command]) => command)).toEqual(['config', 'diff-tree', 'cat-file', 'cat-file', 'show']);

    const missing = makeRunner(true);
    expect(diffOf('HEAD', false, missing.runner)).toContain('UNMEASURED: diff context for HEAD');
    expect(missing.commands.map(([command]) => command)).not.toContain('show');
    missing.commands.length = 0;
    expect(() => diffOf('HEAD', true, missing.runner)).toThrow('UNMEASURED: diff context for HEAD');
    expect(missing.commands.map(([command]) => command)).not.toContain('show');

  });

  it('legacy Git measures a real local partial-clone diff and blocks a missing blob without fetching', () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-model-ab-partial-clone-'));
    const promisor = `${repo}.promisor.git`;
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git(['init', '-q']);
      git(['config', 'user.name', 'Review model test']);
      git(['config', 'user.email', 'review-model-test@example.invalid']);
      git(['config', 'gc.auto', '0']);
      writeFileSync(join(repo, 'sample.ts'), 'export const value = 1;\n');
      git(['add', 'sample.ts']);
      git(['commit', '-qm', 'base']);
      writeFileSync(join(repo, 'sample.ts'), 'export const value = 2;\n');
      git(['add', 'sample.ts']);
      git(['commit', '-qm', 'change']);
      git(['clone', '--bare', '-q', repo, promisor]);
      git(['config', 'remote.origin.url', pathToFileURL(promisor).toString()]);
      git(['config', 'remote.origin.promisor', 'true']);
      git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
      git(['config', 'extensions.partialClone', 'origin']);

      const legacyGit: NonNullable<Parameters<typeof diffOf>[2]> = (args, options) => {
        const env = { ...options.env };
        delete env.GIT_NO_LAZY_FETCH; // Simulate Git versions that ignore this environment variable.
        const result = spawnSync('git', args, { ...options, cwd: repo, env });
        if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
        return result.stdout;
      };
      expect(diffOf('HEAD', false, legacyGit)).toContain('export const value = 2;');

      const missingBlob = git(['rev-parse', 'HEAD:sample.ts']).trim();
      const objectPath = join(repo, '.git', 'objects', missingBlob.slice(0, 2), missingBlob.slice(2));
      expect(existsSync(objectPath)).toBe(true);
      execFileSync('git', ['--git-dir', promisor, 'cat-file', '-e', missingBlob]);
      unlinkSync(objectPath);
      expect(diffOf('HEAD', false, legacyGit)).toContain('UNMEASURED: diff context for HEAD');
      expect(() => diffOf('HEAD', true, legacyGit)).toThrow('UNMEASURED: diff context for HEAD');
      expect(existsSync(objectPath)).toBe(false);

      const cli = run(['--ref', 'HEAD', '--run', '--arms', 'openai-codex/loaded'], { cwd: repo });
      expect(cli.code).not.toBe(0);
      expect(cli.out).toContain('--run aborted before any model review.');
      expect(cli.out).not.toContain('verdict=');
      expect(cli.out).not.toContain('401');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(promisor, { recursive: true, force: true });
    }
  });

  it('⛔ `--run` 없이는 dry-run 이고, 그 사실을 «말한다»', () => {
    const { out, code } = run(['--ref', 'HEAD']);
    expect(code).toBe(0);
    expect(out).toContain('dry-run');
    expect(out).toContain('모델을 «부르지 않았다»');
  });

  it('⛔ dry-run 산출에 리뷰 «판정»이 없다 — 있으면 어딘가에서 모델을 부른 것이다', () => {
    const { out } = run(['--ref', 'HEAD']);
    expect(out).not.toContain('verdict=');
    expect(out).not.toContain('mustFix=');
  });

  it('⭐ 팔의 모델 이름은 «사다리»에서 온다 — 손으로 적힌 이름이 아니다', () => {
    const { out } = run(['--ref', 'HEAD', '--arms', 'openai-codex/loaded,openai-codex/best']);
    const loaded = lookupLlmTierSpec('openai-codex', 'loaded').model;
    const best = lookupLlmTierSpec('openai-codex', 'best').model;
    expect(out).toContain(loaded);
    expect(out).toContain(best);
    // 자가 무는지 — 둘이 같으면 이 시험은 «아무 말도 안 한다»(grok 사다리가 실제로 그렇다).
    expect(loaded).not.toBe(best);
  });

  it('⭐ `@effort` 는 사다리의 effort 를 «덮는다» — 사다리에 없는 칸(xhigh·max)을 재기 위한 축', () => {
    const { out, code } = run(['--ref', 'HEAD', '--arms', 'openai-codex/best,openai-codex/best@xhigh']);
    expect(code).toBe(0);
    const best = lookupLlmTierSpec('openai-codex', 'best');
    expect(out).toContain(`${best.model}·${best.reasoningLevel}`);
    expect(out).toContain(`${best.model}·xhigh`);
    expect(best.reasoningLevel).not.toBe('xhigh');   // 자가 무는지 — 같으면 위 두 줄이 한 줄을 두 번 본다
  });
});
