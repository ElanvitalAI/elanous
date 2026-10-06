import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCommands, extractElanousCommands, type HelpRunner } from './docs-cli-check.js';

const help: HelpRunner = (args) => {
  const key = args.join(' ');
  if (key === '') return { ok: true, out: 'Usage: elanous\n\nCommands:\n  doctor [options]   check\n  harness            run goals\n  self-update        update\n' };
  if (key === 'doctor') return { ok: true, out: 'Usage: elanous doctor [options]\n\nOptions:\n  --fix   repair\n  --yes   no prompt\n  --sudo  allow sudo\n' };
  if (key === 'harness') return { ok: true, out: 'Usage: elanous harness\n\nCommands:\n  say <text>   one line\n  ask <file>   goal file\n' };
  if (key === 'harness say') return { ok: true, out: 'Usage: elanous harness say [options] <text>\n\nOptions:\n  --dry-run  plan only\n' };
  return { ok: false, out: '' };
};

describe('docs-cli-check — 문서의 elanous 호출을 실제 CLI 에 대조', () => {
  test('bun bin/elanous.mjs 접두도 elanous 와 같은 명령으로 읽는다', () => {
    const md = ['`bun bin/elanous.mjs doctor --fix`', '```bash', 'bun bin/elanous.mjs harness say "x"', '```'].join('\n');
    expect(extractElanousCommands('x.md', md).map((r) => [r.cmd, r.sub ?? null, r.flags])).toEqual([
      ['doctor', null, ['--fix']],
      ['harness', 'say', []],
    ]);
  });

  test('a flag token with regex metacharacters is reported, not thrown (doc-rot real run: SyntaxError unmatched parentheses)', () => {
    const md = ['```', 'elanous doctor --fix(x --yes', 'elanous doctor --a+b', '```'].join('\n');
    const f = checkCommands(extractElanousCommands('x.md', md), help);
    expect(f.map((x) => [x.kind, x.detail.split(' ')[0]])).toEqual([
      ['unknown-flag', '--fix(x'],
      ['unknown-flag', '--a+b'],
    ]);
  });

  test('코드 블록·인라인 코드에서 뽑는다 · 자리표와 주석은 인자로 본다 · && 로 이어진 두 호출을 둘로', () => {
    const md = ['Run `elanous doctor --fix --yes`.', '```bash', 'elanous harness say "add a flag"   # one line', 'elanous --version && elanous doctor', '```', 'elanous outside a fence is prose'].join('\n');
    const refs = extractElanousCommands('x.md', md);
    expect(refs.map((r) => [r.cmd, r.sub ?? null, r.flags])).toEqual([
      ['doctor', null, ['--fix', '--yes']],
      ['harness', 'say', []],
      ['doctor', null, []],
    ]);
  });

  test('없는 명령·하위 명령·플래그를 이름으로 댄다(양성) · 있는 것은 통과(음성)', () => {
    const md = ['```', 'elanous doctor --fix --yes --sudo', 'elanous harness say --dry-run "x"', 'elanous nosuch run', 'elanous harness tell "x"', 'elanous doctor --nope', '```'].join('\n');
    const f = checkCommands(extractElanousCommands('x.md', md), help);
    expect(f.map((x) => [x.kind, x.detail])).toEqual([
      ['unknown-command', 'elanous nosuch'],
      ['unknown-subcommand', 'elanous harness tell'],
      ['unknown-flag', '--nope (elanous doctor)'],
    ]);
  });

  test('--help 가 실패하면 «없다»가 아니라 «못 쟀다»', () => {
    const down: HelpRunner = () => ({ ok: false, out: '' });
    expect(checkCommands(extractElanousCommands('x.md', '`elanous doctor`'), down).map((x) => x.kind)).toEqual(['unmeasured']);
  });

  test('세 번째 명령의 플래그는 그 help 로 확인하고, 위치 인자는 두 번째 help 에 남긴다', () => {
    const calls: string[] = [];
    const nestedHelp: HelpRunner = (args) => {
      const key = args.join(' ');
      calls.push(key);
      const outputs: Record<string, string> = {
        '': 'Usage: elanous\n\nCommands:\n  connector  connectors\n  plugin  plugins\n',
        connector: 'Usage: elanous connector\n\nCommands:\n  linear  Linear connector\n',
        'connector linear': 'Usage: elanous connector linear\n\nCommands:\n  sync  pull issues\n',
        'connector linear sync': 'Usage: elanous connector linear sync\n\nOptions:\n  --team <team>\n  --dry-run\n',
        plugin: 'Usage: elanous plugin\n\nCommands:\n  add <name>  install\n',
        'plugin add': 'Usage: elanous plugin add\n\nOptions:\n  --force\n',
      };
      return { ok: key in outputs, out: outputs[key] ?? '' };
    };
    const refs = extractElanousCommands('x.md', '```bash\nelanous connector linear sync --team X --dry-run\nelanous connector linear sync --absent\nelanous plugin add mypkg --force\nelanous plugin add mypkg --absent\n```');
    expect(refs.map((r) => [r.cmd, r.sub, r.subsub])).toEqual([
      ['connector', 'linear', 'sync'], ['connector', 'linear', 'sync'],
      ['plugin', 'add', 'mypkg'], ['plugin', 'add', 'mypkg'],
    ]);
    expect(checkCommands(refs, nestedHelp).map((f) => [f.kind, f.detail])).toEqual([
      ['unknown-flag', '--absent (elanous connector linear sync)'],
      ['unknown-flag', '--absent (elanous plugin add)'],
    ]);
    expect(calls.filter((key) => key === 'connector linear sync')).toHaveLength(1);
    expect(calls).not.toContain('plugin add mypkg');
  });

  test('두 번째 명령 help 실패는 부모 플래그로 판정하지 않고 못 쟀다고 낸다', () => {
    const calls: string[] = [];
    const failingHelp: HelpRunner = (args) => {
      const key = args.join(' ');
      calls.push(key);
      const outputs: Record<string, string> = {
        '': 'Usage: elanous\n\nCommands:\n  connector  connectors\n',
        connector: 'Usage: elanous connector\n\nCommands:\n  linear  Linear connector\n\nOptions:\n  --parent-only\n',
      };
      return { ok: key in outputs, out: outputs[key] ?? '' };
    };
    const refs = extractElanousCommands('x.md', '```bash\nelanous connector linear sync --parent-only\nelanous connector linear sync --team X\n```');
    expect(checkCommands(refs, failingHelp).map((f) => [f.kind, f.detail])).toEqual([
      ['unmeasured', 'elanous connector linear --help 실패'],
      ['unmeasured', 'elanous connector linear --help 실패'],
    ]);
    expect(calls.filter((key) => key === 'connector linear')).toHaveLength(1);
    expect(calls).not.toContain('connector linear sync');
  });

  test('확인된 세 번째 명령의 help 실패는 부모 플래그로 판정하지 않고 못 쟀다고 낸다', () => {
    const calls: string[] = [];
    const failingHelp: HelpRunner = (args) => {
      const key = args.join(' ');
      calls.push(key);
      const outputs: Record<string, string> = {
        '': 'Usage: elanous\n\nCommands:\n  connector  connectors\n',
        connector: 'Usage: elanous connector\n\nCommands:\n  linear  Linear connector\n',
        'connector linear': 'Usage: elanous connector linear\n\nCommands:\n  sync  pull issues\n\nOptions:\n  --parent-only\n',
      };
      return { ok: key in outputs, out: outputs[key] ?? '' };
    };
    const refs = extractElanousCommands('x.md', '```bash\nelanous connector linear sync --parent-only\nelanous connector linear sync --team X\n```');
    expect(checkCommands(refs, failingHelp).map((f) => [f.kind, f.detail])).toEqual([
      ['unmeasured', 'elanous connector linear sync --help 실패'],
      ['unmeasured', 'elanous connector linear sync --help 실패'],
    ]);
    expect(calls.filter((key) => key === 'connector linear sync')).toHaveLength(1);
  });

  test('펜스에서는 세그먼트 머리의 호출만 뽑되 프롬프트·sudo·환경 대입을 허용한다', () => {
    const md = ['```bash', 'Anyone scripting against elanous can run', '$ elanous status --json', 'ELANOUS_X=1 elanous status', '> elanous status', 'sudo elanous status', 'ELANOUS_X=1 sudo elanous status', 'printf x && elanous status', '```', '`elanous status`'].join('\n');
    const refs = extractElanousCommands('x.md', md);
    expect(refs.map((r) => [r.line, r.cmd, r.flags])).toEqual([
      [3, 'status', ['--json']], [4, 'status', []], [5, 'status', []], [6, 'status', []],
      [7, 'status', []], [8, 'status', []], [10, 'status', []],
    ]);
  });

  test('공개 실물 문서의 connector linear sync 플래그는 실제 CLI help 에 있다', () => {
    const repo = resolve(import.meta.dir, '..');
    const file = 'release/public/docs/tasks-and-intake.md';
    const refs = extractElanousCommands(file, readFileSync(resolve(repo, file), 'utf8'))
      .filter((r) => r.cmd === 'connector' && r.sub === 'linear' && r.subsub === 'sync');
    expect(refs.length).toBeGreaterThan(0);
    const realHelp: HelpRunner = (args) => {
      const r = spawnSync('bun', ['bin/elanous.mjs', '--test', ...args, '--help'], {
        cwd: repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
      });
      return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    };
    expect(checkCommands(refs, realHelp)).toEqual([]);
  });
  test('public loop agents guide names the graph stages and safe orchestrator modes; its commands exist', () => {
    const repo = resolve(import.meta.dir, '..');
    const file = 'release/public/docs/loop-agents.md';
    const doc = readFileSync(resolve(repo, file), 'utf8');
    const graph = readFileSync(resolve(repo, 'graphs/orchestrator/orchestrator.yaml'), 'utf8');
    const stages = ['intake', 'split', 'place', 'delegate', 'reconcile', 'report'];
    for (const stage of stages) expect(graph).toContain(`node_id: ${stage}`);
    expect(doc).toContain(`**${stages.join(' → ')}**`);
    expect(doc).toContain('## For operators — the orchestrator');
    expect(doc).toMatch(/`loops\.orchestrator\.mode` to `shadow` \(the default\)/);
    expect(doc).toContain('`live` to place eligible work and actually queue requests');
    expect(doc).toContain('raise a human decision card rather than acting alone');
    for (const heading of ['## For everyone — see and run loops', '## For owners — the steward', '## For developers — build your own']) expect(doc).toContain(heading);
    const refs = extractElanousCommands(file, doc).filter((r) => r.cmd === 'loop' && ['status', 'activity'].includes(r.sub ?? '') && (r.text.includes('orchestrator') || r.sub === 'activity'));
    expect(refs.map((r) => r.text)).toEqual(['elanous loop status orchestrator', 'elanous loop activity']);
    const realHelp: HelpRunner = (args) => {
      const r = spawnSync('bun', ['bin/elanous.mjs', '--test', ...args, '--help'], {
        cwd: repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
      });
      return { ok: r.status === 0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    };
    expect(checkCommands(refs, realHelp)).toEqual([]);
  });
});

// 09-26: 도움말은 별칭을 `self-update|update [options]` 로 찍는다 — 문서의 `elanous update` 를 «없는 명령»으로 잡았다.
describe('docs-cli-check — 별칭도 명령이다', () => {
  test('primary|alias 줄에서 별칭으로 쓴 호출이 어긋남이 아니다', () => {
    const help: HelpRunner = (args) => args.length === 0
      ? { ok: true, out: 'Usage: elanous\n\nCommands:\n  self-update|update [options]  갱신\n  doctor [options]  진단\n' }
      : { ok: true, out: `Usage: elanous ${args[0]}\n\nOptions:\n  --auto <x>\n  -h, --help\n` };
    const f = checkCommands(extractElanousCommands('x.md', '`elanous update --auto on` · `elanous self-update` · `elanous updat`'), help);
    expect(f.filter((x) => x.kind === 'unknown-command').map((x) => x.detail)).toEqual(['elanous updat']);
  });
});
