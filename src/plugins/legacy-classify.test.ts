import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { getPromptBankStore, resetPromptBankStoreForTests } from '../prompt-bank/store.js';
import { BOTLAB_SCHEDULE_COMMAND, renderBotlabCron } from '../../plugins/botlab/plugin.js';
import { parseBotlabCron } from '../bots/routines.js';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyLegacyPlugins,
  formatClassificationReport,
  main,
  PORTABLE_BUCKETS,
  directoryNameOf,
  isProtectedPluginName,
  PROTECTED_PLUGIN_NAMES,
  sourceImportersOf,
  stripComments,
  type LegacyPluginClassification,
} from './legacy-classify.js';
import { PluginHost } from './core/host.js';

function writePlugin(dir: string, name: string, body: string, manifest?: Record<string, unknown>): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.ts'), body);
  if (manifest) {
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  }
}

const PLUGIN_STUB = `
  initialState: () => ({}),
  panes: {},
`;

describe('legacy plugin classifier', () => {
  test('commands-only plugin is classified A (commands are evidence, not portable)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-a-'));
    try {
      writePlugin(root, 'cmd-only', `
        export default {
          name: 'cmd-only', version: '0', description: '',
          ${PLUGIN_STUB}
          slashCommands: [{ name: 'open-ui', description: 'open', handler: async () => {} }],
        };
      `);
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'cmd-only');
      expect(rec).toBeDefined();
      expect(rec!.verdict).toBe('A');
      expect(rec!.contributions.some((c) => c.bucket === 'commands' && c.names.includes('open-ui'))).toBe(true);
      expect(rec!.contributions.some((c) => c.bucket === 'agents' || c.bucket === 'tools')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('agents or tools contribution is classified B', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-b-'));
    try {
      writePlugin(root, 'with-agents', `
        export default {
          name: 'with-agents', version: '0', description: '',
          ${PLUGIN_STUB}
        };
      `, {
        id: 'with-agents',
        contributes: {
          agents: [{ id: 'reviewer', systemPrompt: 'review diffs' }],
        },
      });
      writePlugin(root, 'with-tools', `
        export default {
          name: 'with-tools', version: '0', description: '',
          ${PLUGIN_STUB}
          llmTools: [{
            name: 'quote',
            description: 'quote',
            parameters: { type: 'object', properties: {} },
            handler: async () => ({}),
          }],
        };
      `);
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const agents = records.find((r) => r.name === 'with-agents');
      const tools = records.find((r) => r.name === 'with-tools');
      expect(agents?.verdict).toBe('B');
      expect(agents?.contributions.some((c) => c.bucket === 'agents' && c.names.includes('reviewer'))).toBe(true);
      expect(tools?.verdict).toBe('B');
      expect(tools?.contributions.some((c) => c.bucket === 'tools' && c.names.includes('quote'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('activation failure is classified C and kept', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-c-'));
    try {
      writePlugin(root, 'boom', `
        export default {
          name: 'boom', version: '0', description: '',
          ${PLUGIN_STUB}
          onActivate: async () => { throw new Error('cannot boot'); },
        };
      `);
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'boom');
      expect(rec).toBeDefined();
      expect(rec!.verdict).toBe('C');
      expect(rec!.reason).toContain('activation failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('names rich contributions observed under manifest.contributes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-rich-'));
    try {
      writePlugin(root, 'rich-ui', `
        export default {
          name: 'rich-ui', version: '0', description: '',
          ${PLUGIN_STUB}
          widgets: [{
            type: 'canvas',
            description: 'canvas',
            initialState: () => ({}),
            render: () => [],
          }],
          keybindings: [{ key: 'C-m', command: 'open' }],
          slashCommands: [{ name: 'open-canvas', handler: async () => {} }],
        };
      `);
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'rich-ui');
      expect(rec).toBeDefined();
      expect(rec!.verdict).toBe('A');
      expect(namedBucket(rec!, 'widgets')).toContain('canvas');
      expect(namedBucket(rec!, 'keybindings')).toContain('C-m');
      expect(namedBucket(rec!, 'commands')).toContain('open-canvas');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('records widgets and buildLayout as rich evidence and still classifies A', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-layout-'));
    try {
      writePlugin(root, 'cmd-only', `
        export default {
          name: 'cmd-only', version: '0', description: '',
          ${PLUGIN_STUB}
          slashCommands: [{ name: 'open-ui', handler: async () => {} }],
        };
      `);
      writePlugin(root, 'iul-timeline', `
        export default {
          name: 'iul-timeline', version: '0', description: '',
          initialState: () => ({}),
          panes: {},
          widgets: [{
            type: 'state-timeline-viewer',
            description: 'viewer',
            initialState: () => ({}),
            render: () => [],
          }],
          requiredWidgets: ['state-timeline-viewer'],
          slashCommands: [{ name: 'iul-timeline', handler: async () => {} }],
          buildLayout: () => null,
        };
      `);
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const commandsOnly = records.find((r) => r.name === 'cmd-only');
      const timeline = records.find((r) => r.name === 'iul-timeline');
      expect(commandsOnly?.verdict).toBe('A');
      expect(namedBucket(commandsOnly!, 'widgets')).not.toContain('buildLayout');
      expect(timeline).toBeDefined();
      expect(timeline!.verdict).toBe('A');
      expect(namedBucket(timeline!, 'widgets')).toContain('state-timeline-viewer');
      expect(namedBucket(timeline!, 'widgets')).toContain('buildLayout');
      expect(namedBucket(timeline!, 'commands')).toContain('iul-timeline');
      expect(timeline!.reason).toContain('widgets[state-timeline-viewer, buildLayout]');
      expect(timeline!.contributions.some((c) => PORTABLE_BUCKETS.includes(c.bucket as typeof PORTABLE_BUCKETS[number]))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads nested manifest.contributes rather than top-level fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-nested-'));
    try {
      writePlugin(root, 'nested', `
        export default {
          name: 'nested', version: '0', description: '',
          ${PLUGIN_STUB}
        };
      `, {
        id: 'nested',
        agents: [{ id: 'decoy', systemPrompt: 'should not count at top level' }],
        contributes: {
          keybindings: [{ key: 'C-n', command: 'nested-only' }],
        },
      });
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'nested');
      expect(rec).toBeDefined();
      expect(rec!.verdict).toBe('A');
      expect(namedBucket(rec!, 'keybindings')).toContain('C-n');
      expect(rec!.contributions.some((c) => c.bucket === 'agents')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('main exits 0 when every discovered directory has a named verdict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-main-'));
    try {
      writePlugin(root, 'cmd-only', `
        export default {
          name: 'cmd-only', version: '0', description: '',
          ${PLUGIN_STUB}
          slashCommands: [{ name: 'open-ui', description: 'open', handler: async () => {} }],
        };
      `);
      mkdirSync(join(root, 'library-only'), { recursive: true });
      writeFileSync(join(root, 'library-only', 'index.ts'), 'export const shared = true;\n');
      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured = '';
      process.stdout.write = ((chunk: string | Uint8Array) => {
        captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      }) as typeof process.stdout.write;
      try {
        const code = await main([root]);
        expect(code).toBe(0);
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(captured).toContain('cmd-only\tA\t');
      expect(captured).toContain('library-only\tC\t');
      const report = formatClassificationReport(await classifyLegacyPlugins({ pluginDir: root }));
      expect(report).toContain('cmd-only\tA\t');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('discriminating: a portable plugin is not classified A', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-classify-disc-'));
    try {
      writePlugin(root, 'portable', `
        export default {
          name: 'portable', version: '0', description: '',
          ${PLUGIN_STUB}
        };
      `, {
        id: 'portable',
        contributes: {
          tools: [{ name: 'keep-me' }],
        },
      });
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'portable');
      expect(rec).toBeDefined();
      expect(rec!.verdict).not.toBe('A');
      expect(rec!.verdict).toBe('B');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surviving builtin plugin modules resolve their relative imports', async () => {
    const root = join(import.meta.dir, '..', '..', 'plugins');
    const files = [
      'hello/plugin.ts',
      'sync/plugin.ts',
      'agent-team/plugin.ts',
      'mss-instrument-agent/plugin.ts',
      'consensus-trader/plugin.ts',
      'iul-shared/index.ts',
      'examples/theme/plugin.ts',
    ];
    for (const rel of files) {
      const mod = await import(join(root, rel));
      expect(mod).toBeDefined();
    }
  });

  test('botlab contributes a read-only schedule command and prompt through the real host lifecycle', async () => {
    const root = join(import.meta.dir, '..', '..', 'plugins');
    const userDir = mkdtempSync(join(tmpdir(), 'legacy-classify-botlab-user-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'legacy-classify-botlab-data-'));
    const binDir = mkdtempSync(join(tmpdir(), 'legacy-classify-botlab-bin-'));
    const crontab = join(binDir, 'crontab');
    // 🔐⭐ 리뷰 must-fix(🅕 47차 수리) — 「읽기만 한다」를 «문면»이 아니라 «argv»로 증명한다.
    //    ⛔ 요약이 맞는 것은 「읽었다」만 답하고 「쓰지 «않았다»」는 한 글자도 안 답한다.
    const argvLog = join(binDir, 'argv.log');
    const originalDataHome = process.env.XDG_DATA_HOME;
    const originalPath = process.env.PATH;
    const logs: string[] = [];
    writeFileSync(crontab, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${argvLog}'`,
      "printf '%s\\n' '10 7 * * * bun scripts/botlab/bot-routine.ts alpha' '20 8 * * * bun scripts/botlab/bot-routine.ts beta' '# 30 9 * * * bun scripts/botlab/bot-routine.ts ignored'",
    ].join('\n'));
    chmodSync(crontab, 0o755);
    process.env.XDG_DATA_HOME = dataDir;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    resetPromptBankStoreForTests();
    try {
      const records = await classifyLegacyPlugins({ pluginDir: root, userDir });
      const botlab = records.find((record) => record.name === 'botlab');
      expect(botlab).toBeDefined();
      expect(namedBucket(botlab!, 'commands')).toContain(BOTLAB_SCHEDULE_COMMAND);
      expect(formatClassificationReport(records)).toContain(`botlab\tA\tcommands[${BOTLAB_SCHEDULE_COMMAND}]`);
      expect(botlab!.reason).not.toContain('undiscoverable');

      const originalStderr = process.stderr.write.bind(process.stderr);
      let stderr = '';
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        return true;
      }) as typeof process.stderr.write;
      try {
        expect(await main([root])).toBe(0);
      } finally {
        process.stderr.write = originalStderr;
      }
      expect(stderr).not.toContain('botlab');

      const host = new PluginHost({
        log: (line) => logs.push(line),
        hudSet: () => {},
        requestRender: () => {},
        focusPane: () => {},
      }, null, { userDir });
      await host.discover();
      const manifest = host.list().find((entry) => entry.manifest.id === 'botlab')!.manifest;
      expect(Object.keys(manifest.contributes).sort()).toEqual(['commands', 'prompts', 'tasks']);
      expect(manifest.contributes.prompts).toHaveLength(1);
      expect(manifest.contributes.tasks?.map((task) => task.id)).toEqual([
        'routine-investor', 'routine-assistant', 'routine-newsbot',
      ]);
      expect(manifest.contributes.tasks?.map((task) => task.args)).toEqual([
        ['scripts/botlab/bot-routine.ts', 'investor'],
        ['scripts/botlab/bot-routine.ts', 'assistant'],
        ['scripts/botlab/bot-routine.ts', 'newsbot'],
      ]);
      expect(manifest.contributes.panes).toBeUndefined();
      const promptStore = getPromptBankStore();
      const before = {
        commands: host.contributedCommands(),
        llmTools: host.contributedLLMTools().length,
        panes: host.active()?.ownedSlots.size ?? 0,
        prompt: promptStore.get('plugin:botlab.schedule-context'),
      };
      expect(before.prompt).toBeNull();

      await host.activate('botlab');
      const command = host.contributedCommands().find((entry) => entry.id === BOTLAB_SCHEDULE_COMMAND);
      expect(command?.handler).toBeDefined();
      expect(await host.dispatchSlash(BOTLAB_SCHEDULE_COMMAND, [])).toBe(true);
      expect(logs.at(-1)).toContain('alpha');
      expect(logs.at(-1)).toContain('beta');
      expect(logs.at(-1)).not.toContain('ignored');
      // 🔐⭐ 「읽기만 한다」의 «증명» — crontab 이 «정확히 한 번» `-l` 로만 불렸다.
      //    ⛔ 쓰기 인자(`-r`·`-` 등)가 섞이면 이 단언이 깨진다. 문면 검사로는 그것을 «못 잡는다».
      expect(readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual(['-l']);
      expect(host.contributedLLMTools()).toHaveLength(before.llmTools);
      expect(host.active()?.ownedSlots.size).toBe(before.panes);
      const fragment = promptStore.get('plugin:botlab.schedule-context');
      expect(fragment?.owner).toBe('plugin:botlab');
      expect(fragment?.content).toContain('distinguish schedules');

      await host.deactivate();
      expect(host.contributedCommands()).toEqual(before.commands);
      expect(host.contributedLLMTools()).toHaveLength(before.llmTools);
      expect(host.active()?.ownedSlots.size ?? 0).toBe(before.panes);
      expect(promptStore.get('plugin:botlab.schedule-context')).toBe(before.prompt);
      await host.activate('botlab');
      expect(promptStore.get('plugin:botlab.schedule-context')?.owner).toBe('plugin:botlab');
      await host.deactivate();
      expect(promptStore.get('plugin:botlab.schedule-context')).toBe(before.prompt);
    } finally {
      resetPromptBankStoreForTests();
      if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalDataHome;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(userDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 60_000); // real host lifecycle: >5s under release-gate load (0.2.18 gate introduced)

  test('botlab schedule output keeps unmeasured access distinct from an empty measured schedule', () => {
    expect(renderBotlabCron(parseBotlabCron(null))).toContain('못 물었다');
    expect(renderBotlabCron(parseBotlabCron(null))).not.toContain('no botlab schedules found');
    expect(renderBotlabCron(parseBotlabCron(''))).toContain('measured; no botlab schedules found');
  });

  test('botlab schedule output preserves unparsed botlab lines instead of claiming no schedules', () => {
    const output = renderBotlabCron(parseBotlabCron('not-a-cron bun scripts/botlab/bot-routine.ts alpha'));
    expect(output).toContain('0 parsed schedules');
    expect(output).toContain('1 botlab line(s) could not be parsed');
    expect(output).not.toContain('no botlab schedules found');
  });
});

function namedBucket(rec: LegacyPluginClassification, bucket: string): string[] {
  return rec.contributions.find((c) => c.bucket === bucket)?.names ?? [];
}

// ── 2026-09-03 리뷰 must-fix — 보호 목록과 소스 import 축이 «코드에» 있어야 한다 ──
//
// 계기: 이 골의 앞선 판은 두 축을 「이번 실행 결과가 그랬다」로만 만족했다. 리뷰가
// 그것을 잡았다 — 보호 대상이 기여를 잃는 날 조용히 삭제 후보가 되기 때문이다.
// ⊕ `iul-presets` 는 기여 0이었지만 `src/playground/lab.ts` 가 그 파일을 import 하고
//   있었고, 그것을 지우면 빌드가 깨진다. 기여 축이 원리상 못 보는 갈래다.
describe('legacy-classify — 보호 목록과 소스 import 축', () => {
  test('보호 이름이 상수로 «코드에» 있다', () => {
    expect([...PROTECTED_PLUGIN_NAMES]).toContain('agent-team');
    expect([...PROTECTED_PLUGIN_NAMES]).toContain('consensus-trader');
  });

  test('소스가 import 하는 플러그인을 «파일 이름으로» 댄다', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const importers = sourceImportersOf('iul-presets', repoRoot);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.some((f) => f.endsWith('src/playground/lab.ts'))).toBe(true);
  });

  test('import 이 없는 이름에는 «빈 목록»을 준다 — 그래야 삭제가 막히지 않는다', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    expect(sourceImportersOf('this-plugin-does-not-exist-anywhere', repoRoot)).toEqual([]);
  });

  test('문서·문자열 언급만으로는 import 로 세지 않는다', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    // widget-demo 는 src/playground/widget.ts 가 «문자열로» 비교하지만 import 하지 않는다.
    expect(sourceImportersOf('widget-demo', repoRoot)).toEqual([]);
  });
});

// ── 2026-09-03 4R 리뷰 must-fix ────────────────────────────────────────────
describe('legacy-classify — 보호 시점과 주석 제외', () => {
  test('보호는 «발견·활성화보다 먼저» 걸린다 — 발견 불가여도 B 다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-protect-'));
    try {
      // plugin.ts 도 plugin.json 도 없는 «발견 불가» 디렉토리를 보호 이름으로 만든다.
      mkdirSync(join(root, 'consensus-trader'), { recursive: true });
      writeFileSync(join(root, 'consensus-trader', 'README.md'), 'no entry point');
      const records = await classifyLegacyPlugins({ pluginDir: root });
      const rec = records.find((r) => r.name === 'consensus-trader');
      // ⛔ 「A 가 아님」으로 만족하면 C 회귀를 통과시킨다(5R 리뷰 GOODHART 지적).
      //    보호 규칙은 «B 여야 한다»고 말하므로 그대로 요구한다.
      expect(rec).toBeDefined();
      expect(rec!.verdict).toBe('B');
      expect(rec!.reason).toContain('protected by name');
      // 같은 디렉토리가 «두 번» 들어가지 않는다.
      expect(records.filter((r) => r.name === 'consensus-trader')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('보호 판정이 디렉토리 이름으로도 걸린다', () => {
    expect(isProtectedPluginName('agent-team')).toBe(true);
    expect(isProtectedPluginName('consensus-trader')).toBe(true);
    expect(isProtectedPluginName('iul-canvas')).toBe(false);
    expect(directoryNameOf('/a/b/plugins/agent-team')).toBe('agent-team');
    expect(directoryNameOf('/a/b/plugins/agent-team/')).toBe('agent-team');
  });

  test('주석 속 import 는 «소비»로 세지 않는다', () => {
    const withComment = [
      "// import x from '../../plugins/ghost/registry.js';",
      "/* import y from '../../plugins/ghost/other.js'; */",
      "const ok = 1;",
    ].join('\n');
    expect(stripComments(withComment)).not.toContain('plugins/ghost');
    // 진짜 import 는 남는다.
    const real = "import z from '../../plugins/ghost/real.js';";
    expect(stripComments(real)).toContain('plugins/ghost/real.js');
  });

  test('URL 의 // 를 주석으로 잘라 내지 않는다', () => {
    const url = "const u = 'https://example.test/x';";
    expect(stripComments(url)).toContain('https://example.test/x');
  });

  // ── 7R 리뷰 must-fix — 미탐(실제 import 를 놓침)이 과탐보다 «훨씬» 비싸다 ──
  test('문자열 안의 // 뒤에 오는 «실제 import» 를 놓치지 않는다', () => {
    // ⛔ 입력이 «옛 구현을 가르는» 것이어야 한다. `//` 앞이 `:` 면 옛 정규식도 안 지워
    //    시험이 통과해 버린다(실측으로 확인). 그래서 앞을 공백으로 둔다.
    const line = `const doc = 'a // b'; import p from '../../plugins/ghost/registry.js';`;
    expect(stripComments(line)).toContain('plugins/ghost/registry.js');
  });

  test('그런 파일을 sourceImportersOf 가 «소비»로 센다', () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-strcomment-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'consumer.ts'),
        `const doc = 'a // b'; import p from '../../plugins/ghost/registry.js';\n`,
      );
      expect(sourceImportersOf('ghost', root).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 2026-09-03 6R 리뷰 must-fix — id ≠ 디렉토리명 ─────────────────────────
describe('legacy-classify — manifest.id 와 디렉토리명이 다를 때', () => {
  test('소비 스캔과 완전성 검사가 «디렉토리명»을 쓴다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-iddir-'));
    try {
      // 디렉토리는 `dir-name`, manifest.id 는 `other-id` 로 «다르게» 만든다.
      writePlugin(root, 'dir-name', `
        export default {
          name: 'other-id', version: '0', description: '',
          ${PLUGIN_STUB}
        };
      `, { id: 'other-id', contributes: {} });
      const records = await classifyLegacyPlugins({ pluginDir: root });
      // ⛔ 그 디렉토리가 «판정 목록에 있어야» 한다 — 없으면 main() 이 unnamed 로 exit 1 한다.
      expect(records.some((r) => directoryNameOf(r.path) === 'dir-name')).toBe(true);
      // 같은 디렉토리에 두 판정이 생기지 않는다.
      expect(records.filter((r) => directoryNameOf(r.path) === 'dir-name')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 2026-09-03 8R 리뷰 — 블록 주석 «내부 후속 줄» 부분 수용 ────────────────
describe('legacy-classify — 블록 주석 내부', () => {
  test('여러 줄 블록 주석 «안»의 import 는 소비로 세지 않는다', () => {
    const src = ["/*", "import x from '../../plugins/ghost/a.js';", "*/", "const ok = 1;"].join('\n');
    expect(stripComments(src)).not.toContain('plugins/ghost/a.js');
    expect(stripComments(src)).toContain('const ok = 1;');
  });

  test('블록이 닫힌 «뒤»의 실제 import 는 남는다', () => {
    const src = ["/* note", "still comment", "*/ import y from '../../plugins/ghost/b.js';"].join('\n');
    expect(stripComments(src)).toContain('plugins/ghost/b.js');
  });

  test('여는 줄 «앞»의 코드도 남는다', () => {
    const src = ["import z from '../../plugins/ghost/c.js'; /* trailing", "still", "*/"].join('\n');
    expect(stripComments(src)).toContain('plugins/ghost/c.js');
  });
});
