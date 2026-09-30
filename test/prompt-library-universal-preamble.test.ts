// Universal preamble — fix F (surface-agnostic project anchor).
// Reference: 내부 문서 `_INDEX-claude-code-pipeline-refs` fix F.
// Mirrors Claude Code's Phase 0 auto-memory pattern.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PROJECT_ANCHOR_MAX_CHARS,
  PROJECT_ANCHOR_CANDIDATES,
  PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES,
  PROJECT_TREE_MAX_CHARS,
  PROJECT_TREE_DIR_ENTRY_LIMIT,
  buildUniversalPreamble,
  loadProjectAnchor,
  loadProjectAnchorWithMeta,
  loadProjectTree,
  loadProjectTreeWithMeta,
  resetUniversalPreambleCache,
  setProjectAnchorReadObserverForTest,
} from '../src/prompt-library/universal-preamble.js';
import { mkdirSync } from 'node:fs';

let tmp: string;
const harnessEnv = {
  space: process.env.ELANOUS_HARNESS_SPACE,
  spaceId: process.env.ELANOUS_HARNESS_SPACE_ID,
  runId: process.env.ELANOUS_RUN_ID,
};

function assertProjectAnchorCandidatesFitBudget(root: string): void {
  const candidates = PROJECT_ANCHOR_CANDIDATES.flatMap(({ filename }) => {
    const path = join(root, filename);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const overflow = raw.length - PROJECT_ANCHOR_MAX_CHARS;
    if (overflow > 0) {
      throw new Error(
        `Project anchor candidate ${filename} has raw.length ${raw.length}; ` +
        `cap ${PROJECT_ANCHOR_MAX_CHARS}; overflow ${overflow}.`,
      );
    }
    return [{ filename, length: raw.length }];
  });
  const total = candidates.reduce((sum, { length }) => sum + length, 0);
  const overflow = total - PROJECT_ANCHOR_MAX_CHARS;
  if (overflow > 0) {
    throw new Error(
      `Project anchor candidates ${candidates.map(({ filename, length }) => `${filename} raw.length ${length}`).join('; ')}; ` +
      `total ${total}; cap ${PROJECT_ANCHOR_MAX_CHARS}; overflow ${overflow}.`,
    );
  }
}

beforeEach(() => {
  delete process.env.ELANOUS_HARNESS_SPACE;
  delete process.env.ELANOUS_HARNESS_SPACE_ID;
  delete process.env.ELANOUS_RUN_ID;
  tmp = mkdtempSync(join(tmpdir(), 'elanous-univ-anchor-'));
  resetUniversalPreambleCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetUniversalPreambleCache();
  if (harnessEnv.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE;
  else process.env.ELANOUS_HARNESS_SPACE = harnessEnv.space;
  if (harnessEnv.spaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID;
  else process.env.ELANOUS_HARNESS_SPACE_ID = harnessEnv.spaceId;
  if (harnessEnv.runId === undefined) delete process.env.ELANOUS_RUN_ID;
  else process.env.ELANOUS_RUN_ID = harnessEnv.runId;
});

describe('buildUniversalPreamble + loadProjectAnchor', () => {
  test('returns no-tools guidance and lifecycle when neither AGENTS.md nor CLAUDE.md exists', () => {
    const msgs = buildUniversalPreamble({ cwd: tmp });
    expect(msgs).toHaveLength(2);
    expect((msgs[0]!.content as string)).toContain('tools disabled');
    expect((msgs[1]!.content as string)).toContain('Coding Agent Pipelines');
    expect(loadProjectAnchor(tmp).content).toBeNull();
  });

  test('emits anchor + tree + lifecycle when AGENTS.md exists', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Agents guide\nUse this guide.\n');
    const msgs = buildUniversalPreamble({ cwd: tmp });
    // [anchor, project-tree (W4-B), no-tools guidance, lifecycle]
    expect(msgs.length).toBe(4);
    expect(msgs[0]!.role).toBe('system');
    const content = msgs[0]!.content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('=== Project canonical collaboration guide (AGENTS.md) ===');
    expect(content as string).toContain('# Agents guide');
    expect(content as string).not.toContain('CLAUDE.md');
    // Project Layout (tree) landed second.
    expect((msgs[1]!.content as string)).toContain('## Project Layout');
    expect((msgs[1]!.content as string)).toContain('AGENTS.md');
    expect(msgs[2]!.role).toBe('system');
    const guidance = msgs[2]!.content as string;
    expect(guidance).toContain('tools disabled');
    expect(guidance).toContain('Do not guess repository or real-time facts');
    expect(guidance).toContain('file counts, file contents, commits, or the current time');
    expect(guidance).toContain('cannot check');
    expect(guidance).toContain('for navigation, not evidence for counts');
    expect(guidance).toContain('elanous agent …');
    expect(guidance).toContain('elanous chat --tools …');
    expect((msgs[3]!.content as string)).toContain('Coding Agent Pipelines');
    // src/cli/agent-cli.ts runChatTurnCli calls buildUniversalPreamble and joins its messages before runTurn({ systemPrompt }).
    const systemPrompt = msgs.map(m => m.content as string).filter(Boolean).join('\n\n');
    expect(systemPrompt.indexOf('## Project Layout')).toBeLessThan(systemPrompt.indexOf('## Chat without tools'));
    expect(systemPrompt).toContain('Do not guess repository or real-time facts');
  });

  test('empty enabledTools also emits exactly one guidance message after the tree', () => {
    writeFileSync(join(tmp, 'README.md'), '# Hello\n');
    const msgs = buildUniversalPreamble({ cwd: tmp, enabledTools: [] });
    expect(msgs).toHaveLength(3);
    expect((msgs[0]!.content as string)).toContain('## Project Layout');
    expect(msgs[1]).toEqual(expect.objectContaining({ role: 'system' }));
    expect((msgs[1]!.content as string)).toContain('Do not guess repository or real-time facts');
    expect((msgs[2]!.content as string)).toContain('Coding Agent Pipelines');
  });

  test('enabled Read tool preserves the tool-enabled preamble', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Agents guide\n');
    const msgs = buildUniversalPreamble({ cwd: tmp, enabledTools: ['Read'] });
    const expected = buildUniversalPreamble({ cwd: tmp })
      .filter(m => !(m.content as string).startsWith('## Chat without tools'));
    expect(msgs.slice(0, -1)).toEqual(expected);
    expect(msgs.at(-1)!.role).toBe('system');
    expect((msgs.at(-1)!.content as string)).toContain('# Session-specific guidance');
    expect(msgs.every(m => !(m.content as string).startsWith('## Chat without tools'))).toBe(true);
    const systemPrompt = msgs.map(m => m.content as string).filter(Boolean).join('\n\n');
    expect(systemPrompt).not.toContain('## Chat without tools');
  });

  test('exports the project anchor candidates and policy-observed CLAUDE filename declarations', () => {
    expect(PROJECT_ANCHOR_CANDIDATES).toEqual([
      { filename: 'AGENTS.md', label: 'Project canonical collaboration guide' },
      { filename: 'DESIGN.md', label: 'Project design craft rulebooks' },
    ]);
    expect(PROJECT_ANCHOR_NON_CANDIDATE_FILENAMES).toEqual(['CLAUDE.md']);
  });

  test('keeps repository-root anchor candidates within the raw JavaScript character budget', () => {
    const root = process.cwd();
    assertProjectAnchorCandidatesFitBudget(root);

    const raw = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const result = loadProjectAnchor(root);
    const agents = result.files.find(({ filename, relDir }) => filename === 'AGENTS.md' && relDir === '');
    expect(agents).toEqual(expect.objectContaining({ truncated: false, chars: raw.length }));
    expect(result.totalChars).toBe(
      PROJECT_ANCHOR_CANDIDATES.reduce((total, { filename }) =>
        total + readFileSync(join(root, filename), 'utf8').length, 0),
    );
  });

  test('loads ordered, complete repository-root AGENTS.md and DESIGN.md anchors', () => {
    const root = process.cwd();
    const agentsRaw = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const designRaw = readFileSync(join(root, 'DESIGN.md'), 'utf8');

    const result = loadProjectAnchor(root);

    expect(result.files).toEqual([
      expect.objectContaining({ filename: 'AGENTS.md', relDir: '', truncated: false, chars: agentsRaw.length }),
      expect.objectContaining({ filename: 'DESIGN.md', relDir: '', truncated: false, chars: designRaw.length }),
    ]);
    expect(result.totalChars).toBe(agentsRaw.length + designRaw.length);
    expect(result.content).toContain(
      `=== Project design craft rulebooks (DESIGN.md) ===\n${designRaw}\n=== end DESIGN.md ===`,
    );
  });

  test('reports anchor candidate filename, raw length, cap, and overflow deterministically', () => {
    const agentsRaw = 'A'.repeat(PROJECT_ANCHOR_MAX_CHARS - 10);
    const designRaw = 'D'.repeat(17);
    writeFileSync(join(tmp, 'AGENTS.md'), agentsRaw);
    writeFileSync(join(tmp, 'DESIGN.md'), designRaw);

    expect(() => assertProjectAnchorCandidatesFitBudget(tmp)).toThrow(
      `Project anchor candidates AGENTS.md raw.length ${agentsRaw.length}; DESIGN.md raw.length ${designRaw.length}; ` +
      `total ${PROJECT_ANCHOR_MAX_CHARS + 7}; cap ${PROJECT_ANCHOR_MAX_CHARS}; overflow 7.`,
    );

    const raw = 'A'.repeat(PROJECT_ANCHOR_MAX_CHARS + 17);
    writeFileSync(join(tmp, 'AGENTS.md'), raw);
    rmSync(join(tmp, 'DESIGN.md'));

    expect(() => assertProjectAnchorCandidatesFitBudget(tmp)).toThrow(
      `Project anchor candidate AGENTS.md has raw.length ${raw.length}; ` +
      `cap ${PROJECT_ANCHOR_MAX_CHARS}; overflow 17.`,
    );
  });

  test('excludes an existing CLAUDE.md by policy while loading AGENTS.md with ample budget', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Agents canonical\n');
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Claude addendum\n');
    const result = loadProjectAnchorWithMeta(tmp);
    expect(result.files).toEqual([
      expect.objectContaining({ filename: 'AGENTS.md', relDir: '' }),
    ]);
    expect(result.content).toContain('# Agents canonical');
    expect(result.content).not.toContain('# Claude addendum');
    expect(result.skipped).toEqual([
      { filename: 'DESIGN.md', relDir: '', reason: 'absent' },
      { filename: 'CLAUDE.md', relDir: '', reason: 'policy-excluded' },
    ]);
  });

  test('records absent candidates but no policy telemetry when CLAUDE.md is absent', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Agents canonical\n');
    expect(loadProjectAnchorWithMeta(tmp).skipped).toEqual([
      { filename: 'DESIGN.md', relDir: '', reason: 'absent' },
    ]);
  });

  test('returns an empty anchor for a CLAUDE-only repository', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Claude rules\nFollow these.\n');
    const result = loadProjectAnchorWithMeta(tmp);
    expect(result.content).toBeNull();
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([
      { filename: 'AGENTS.md', relDir: '', reason: 'absent' },
      { filename: 'DESIGN.md', relDir: '', reason: 'absent' },
      { filename: 'CLAUDE.md', relDir: '', reason: 'policy-excluded' },
    ]);
  });

  test('preserves anchor budget truncation without considering CLAUDE.md', () => {
    const big = 'A'.repeat(40 * 1024);
    writeFileSync(join(tmp, 'AGENTS.md'), big);
    writeFileSync(join(tmp, 'CLAUDE.md'), '# Should not appear\n');
    const result = loadProjectAnchorWithMeta(tmp);
    expect(result.content).not.toBeNull();
    expect(result.totalChars).toBeLessThanOrEqual(PROJECT_ANCHOR_MAX_CHARS);
    expect(result.content!).toContain('…[truncated to fit anchor budget]');
    expect(result.files).toEqual([
      expect.objectContaining({ filename: 'AGENTS.md', truncated: true, relDir: '' }),
    ]);
    expect(result.skipped).toEqual([
      { filename: 'DESIGN.md', relDir: '', reason: 'budget-exhausted' },
      { filename: 'CLAUDE.md', relDir: '', reason: 'policy-excluded' },
    ]);
    expect(result.content!).not.toContain('# Should not appear');
  });

  test('records a candidate that exists but cannot be read', () => {
    mkdirSync(join(tmp, 'AGENTS.md'));
    expect(loadProjectAnchorWithMeta(tmp).skipped).toEqual([
      { filename: 'AGENTS.md', relDir: '', reason: 'read-failed' },
      { filename: 'DESIGN.md', relDir: '', reason: 'absent' },
    ]);
  });

  test('refreshes cached anchor after an AGENTS.md overwrite', () => {
    const path = join(tmp, 'AGENTS.md');
    writeFileSync(path, '# short\n');
    expect(loadProjectAnchor(tmp).files[0]!.chars).toBe('# short\n'.length);
    writeFileSync(path, '# replacement with longer content\n');
    const result = loadProjectAnchor(tmp);
    expect(result.files[0]!.chars).toBe('# replacement with longer content\n'.length);
    expect(result.content).toContain('replacement with longer content');
  });

  test('does not cache stale content when AGENTS.md changes after its read', () => {
    const path = join(tmp, 'AGENTS.md');
    const replacement = '# replacement after read\n';
    writeFileSync(path, '# stale read\n');
    let replaced = false;
    setProjectAnchorReadObserverForTest((readPath) => {
      if (!replaced && readPath === path) {
        replaced = true;
        writeFileSync(path, replacement);
      }
    });
    try {
      const result = loadProjectAnchor(tmp);
      expect(result.files[0]!.chars).toBe(replacement.length);
      expect(result.content).toContain('replacement after read');
      expect(loadProjectAnchor(tmp).files[0]!.chars).toBe(replacement.length);
    } finally {
      setProjectAnchorReadObserverForTest(undefined);
    }
  });

  test('refreshes cached anchor when an absent AGENTS.md is created', () => {
    expect(loadProjectAnchor(tmp).content).toBeNull();
    writeFileSync(join(tmp, 'AGENTS.md'), '# created\n');
    expect(loadProjectAnchor(tmp).content).toContain('# created');
  });

  test('refreshes cached anchor when an existing AGENTS.md is deleted', () => {
    const path = join(tmp, 'AGENTS.md');
    writeFileSync(path, '# present\n');
    expect(loadProjectAnchor(tmp).content).toContain('# present');
    rmSync(path);
    expect(loadProjectAnchor(tmp).content).toBeNull();
  });

  test('per-cwd cache retains A while loading B', () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'elanous-univ-anchor2-'));
    const reads: string[] = [];
    try {
      writeFileSync(join(tmp, 'AGENTS.md'), '# A1\n');
      writeFileSync(join(tmp2, 'AGENTS.md'), '# A2\n');
      setProjectAnchorReadObserverForTest((path) => reads.push(path));
      expect(loadProjectAnchor(tmp).content).toContain('# A1');
      expect(loadProjectAnchor(tmp2).content).toContain('# A2');
      expect(loadProjectAnchor(tmp).content).toContain('# A1');
      expect(reads.filter((path) => path === join(tmp, 'AGENTS.md'))).toHaveLength(1);
    } finally {
      setProjectAnchorReadObserverForTest(undefined);
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

test('runChatTurnCli supplies the guidance in the actual tool-disabled system prompt, not the tool-enabled prompt', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'elanous-cli-preamble-'));
  try {
    const cliModule = `${import.meta.dir}/../src/cli/agent-cli.ts`;
    const configModule = `${import.meta.dir}/../src/user-config.ts`;
    const child = spawnSync('bun', ['--eval', `
      import { getUserConfig } from ${JSON.stringify(configModule)};
      import { runChatTurnCli } from ${JSON.stringify(cliModule)};
      const cfg = getUserConfig();
      cfg.chat.toolDeny = [];
      const prompts = [];
      const capture = async (input) => {
        prompts.push({ systemPrompt: input.systemPrompt, tools: input.tools?.length ?? 0 });
        return { provider: 'test', model: 'test' };
      };
      for (const enableTools of [false, true]) {
        await runChatTurnCli({ cfg, userText: 'How many files?', explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools, runTurn: capture });
      }
      console.log(JSON.stringify(prompts));
    `], {
      encoding: 'utf8',
      env: { ...process.env, ELANOUS_STATE_DIR: stateDir, ELANOUS_HARNESS_SPACE: '', ELANOUS_HARNESS_SPACE_ID: '', ELANOUS_RUN_ID: '' },
    });
    expect(child.status).toBe(0);
    const prompts = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { systemPrompt: string; tools: number }[];
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.tools).toBe(0);
    expect(prompts[0]!.systemPrompt).toContain('Do not guess repository or real-time facts');
    expect(prompts[0]!.systemPrompt.indexOf('## Project Layout')).toBeLessThan(prompts[0]!.systemPrompt.indexOf('## Chat without tools'));
    expect(prompts[1]!.tools).toBeGreaterThan(0);
    expect(prompts[1]!.systemPrompt).not.toContain('## Chat without tools');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe('buildDashboardTurnPreamble — universal layer integration', () => {
  test('includes the universal preamble first when anchor files exist', async () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Anchor sentinel TEST_F_INCLUDED\n');
    const { buildDashboardTurnPreamble } = await import('../src/dashboard/turn-preamble.js');
    // Minimal UserConfig snapshot — only conciseness is read by the
    // builder; cast keeps the test from coupling to the full
    // UserConfig surface.
    const userConfig = {
      chat: {
        conciseness: {
          enabled: true,
          finalMessageMaxLines: 6,
          preambleMaxWords: 12,
          flatBullets: false,
        },
      },
    } as unknown as Parameters<typeof buildDashboardTurnPreamble>[0]['userConfig'];
    const preamble = buildDashboardTurnPreamble({
      userText: 'evaluate this project',
      cwd: tmp,
      userConfig,
    });
    // Universal anchor must be the FIRST system message so the model
    // sees project context before any surface-specific guidance.
    expect(preamble.length).toBeGreaterThan(0);
    const firstContent = preamble[0]!.content;
    expect(typeof firstContent).toBe('string');
    expect(firstContent as string).toContain('TEST_F_INCLUDED');
  });
});

describe('buildUniversalPreamble — codex-family addendum (fix L-1) + lifecycle (P4) + tree (W4-B)', () => {
  test('codex family appends the behavioral discipline addendum after anchor + tree + lifecycle', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Anchor v1\n');
    const msgs = buildUniversalPreamble({ cwd: tmp, modelFamily: 'codex' });
    // [anchor, project-tree, no-tools guidance, lifecycle, codex addendum]
    expect(msgs.length).toBe(5);
    expect((msgs[0]!.content as string)).toContain('# Anchor v1');
    expect((msgs[1]!.content as string)).toContain('## Project Layout');
    expect((msgs[2]!.content as string)).toContain('Chat without tools');
    expect((msgs[3]!.content as string)).toContain('Coding Agent Pipelines');
    const addendum = msgs[4]!.content as string;
    expect(addendum).toContain('Codex Behavioral Discipline');
    // Fix L-1 sections:
    expect(addendum).toContain('Avoid Wasted Tokens');
    expect(addendum).toContain('RE-CALL BLOCKED');
    expect(addendum).toContain('Parallelize Reads');
    expect(addendum).toContain('Persist To Completion');
    // Fix U new sections (narrate-before-act + verify-via-tests):
    expect(addendum).toContain('Narrate Before Each Tool Batch');
    expect(addendum).toContain('Self-Checkpoint');
    expect(addendum).toContain('Verify Via Tests');
    expect(addendum).toContain('성숙도');
    // W7-C — shell-mode read pattern (cat enforcement after rg --files):
    expect(addendum).toContain('Shell-Mode Read Pattern');
    expect(addendum).toContain('A second consecutive listing turn without a cat');
    expect(addendum).toContain('hybrid rhythm');
  });

  test('claude family appends the anthropic addendum (Wave 3, 2026-05-04) but not the codex addendum', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Anchor v1\n');
    const msgs = buildUniversalPreamble({ cwd: tmp, modelFamily: 'claude' });
    // [anchor, project-tree, no-tools guidance, lifecycle, claude-addendum]
    expect(msgs.length).toBe(5);
    expect((msgs[0]!.content as string)).not.toContain('Codex Behavioral Discipline');
    expect((msgs[1]!.content as string)).toContain('## Project Layout');
    expect((msgs[2]!.content as string)).toContain('Chat without tools');
    expect((msgs[3]!.content as string)).toContain('Coding Agent Pipelines');
    expect((msgs[4]!.content as string)).toContain('Claude Behavioral Discipline');
    // Wave 3 — engineering-standards directives (read-first, no gold-
    // plating, faithful reporting, verification) sourced from ref/
    // claude-code-fork getSimpleDoingTasksSection.
    expect((msgs[4]!.content as string)).toContain('Read Before Proposing Changes');
    expect((msgs[4]!.content as string)).toContain('Faithful Reporting');
  });

  test('omitted modelFamily defaults to no codex addendum (still gets tree + lifecycle)', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '# Anchor v1\n');
    const msgs = buildUniversalPreamble({ cwd: tmp });
    // [anchor, project-tree, no-tools guidance, lifecycle]
    expect(msgs.length).toBe(4);
    expect((msgs[0]!.content as string)).not.toContain('Codex Behavioral Discipline');
    expect((msgs[1]!.content as string)).toContain('## Project Layout');
    expect((msgs[2]!.content as string)).toContain('Chat without tools');
    expect((msgs[3]!.content as string)).toContain('Coding Agent Pipelines');
  });

  test('codex addendum still emits even when no anchor files exist', () => {
    // Empty cwd — no anchor files. Emits [no-tools guidance, lifecycle, codex addendum].
    const msgs = buildUniversalPreamble({ cwd: tmp, modelFamily: 'codex' });
    expect(msgs.length).toBe(3);
    expect((msgs[0]!.content as string)).toContain('Chat without tools');
    expect((msgs[1]!.content as string)).toContain('Coding Agent Pipelines');
    expect((msgs[2]!.content as string)).toContain('Codex Behavioral Discipline');
  });

  test('lifecycle includes 분석/구현/디버깅 pipelines verbatim (P4)', () => {
    const msgs = buildUniversalPreamble({ cwd: tmp });
    const lifecycle = msgs[1]!.content as string;
    expect(lifecycle).toContain('분석');
    expect(lifecycle).toContain('구현');
    expect(lifecycle).toContain('디버깅');
    expect(lifecycle).toContain('수정할까요?');
    // Pipeline shapes — must literally name find / read / edit / verify
    // so a reviewer can audit the agent's chosen path.
    expect(lifecycle).toContain('find');
    expect(lifecycle).toContain('read');
    expect(lifecycle).toContain('edit');
    expect(lifecycle).toContain('verify');
    expect(lifecycle).toContain('exec');
  });
});

describe('loadProjectTree (W4-B project tree light snapshot)', () => {
  test('returns null content for empty cwd', () => {
    // tmp is fresh, no files
    const r = loadProjectTreeWithMeta(tmp);
    expect(r.content).toBeNull();
    expect(r.totalChars).toBe(0);
    expect(r.topLevelCount).toBe(0);
  });

  test('renders top-level files + 1 depth dirs in codex format', () => {
    writeFileSync(join(tmp, 'README.md'), '# Hello\n');
    writeFileSync(join(tmp, 'package.json'), '{"name":"x"}');
    mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, 'src/index.ts'), 'export {};');
    mkdirSync(join(tmp, 'src/utils'));
    writeFileSync(join(tmp, 'src/utils/log.ts'), 'export {};');

    const r = loadProjectTreeWithMeta(tmp);
    expect(r.content).not.toBeNull();
    expect(r.totalChars).toBeLessThanOrEqual(PROJECT_TREE_MAX_CHARS);
    expect(r.topLevelCount).toBe(3);
    const c = r.content!;
    // codex format: `- name/` 2-space indent (NO ASCII tree characters)
    expect(c).toContain('- README.md');
    expect(c).toContain('- package.json');
    expect(c).toContain('- src/');
    expect(c).toContain('  - index.ts');
    expect(c).toContain('  - utils/');
    // No legacy ASCII tree chars
    expect(c).not.toContain('├──');
    expect(c).not.toContain('└──');
  });

  test('per-dir entry cap (DIR_ENTRY_LIMIT) emits "(+N more)" marker', () => {
    mkdirSync(join(tmp, 'docs'));
    // Create more than DIR_ENTRY_LIMIT children
    const childCount = PROJECT_TREE_DIR_ENTRY_LIMIT + 5;
    for (let i = 0; i < childCount; i++) {
      writeFileSync(join(tmp, `docs/entry-${String(i).padStart(3, '0')}.md`), 'x');
    }
    const r = loadProjectTreeWithMeta(tmp);
    const c = r.content!;
    expect(c).toContain(`- docs/  (${childCount} entries)`);
    expect(c).toContain(`(+${childCount - PROJECT_TREE_DIR_ENTRY_LIMIT} more)`);
    // First 20 children should be present
    expect(c).toContain('  - entry-000.md');
    expect(c).toContain(`  - entry-${String(PROJECT_TREE_DIR_ENTRY_LIMIT - 1).padStart(3, '0')}.md`);
    // Children beyond the cap should NOT be present
    expect(c).not.toContain(`  - entry-${String(PROJECT_TREE_DIR_ENTRY_LIMIT).padStart(3, '0')}.md`);
  });

  test('skips noisy dirs (node_modules, .git, target, dist)', () => {
    mkdirSync(join(tmp, 'node_modules'));
    writeFileSync(join(tmp, 'node_modules/foo.txt'), 'x');
    mkdirSync(join(tmp, '.git'));
    writeFileSync(join(tmp, '.git/HEAD'), 'ref');
    mkdirSync(join(tmp, 'target'));
    mkdirSync(join(tmp, 'dist'));
    writeFileSync(join(tmp, 'src.ts'), 'export {};');

    const r = loadProjectTreeWithMeta(tmp);
    const c = r.content!;
    expect(c).toContain('- src.ts');
    expect(c).not.toContain('node_modules');
    expect(c).not.toContain('.git');
    expect(c).not.toContain('target');
    expect(c).not.toContain('dist');
  });

  test('caches per-cwd; reset picks up disk mutations', () => {
    writeFileSync(join(tmp, 'a.md'), 'x');
    expect(loadProjectTree(tmp).content).toContain('- a.md');
    writeFileSync(join(tmp, 'b.md'), 'y');
    // Cache hit — b.md not visible yet
    expect(loadProjectTree(tmp).content).not.toContain('- b.md');
    resetUniversalPreambleCache();
    expect(loadProjectTree(tmp).content).toContain('- b.md');
  });

  test('character cap is final safety net (item cap usually catches first)', () => {
    // Create many top-level entries to exceed the character cap
    for (let i = 0; i < 500; i++) {
      writeFileSync(join(tmp, `topfile-${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const r = loadProjectTreeWithMeta(tmp);
    expect(r.totalChars).toBeLessThanOrEqual(PROJECT_TREE_MAX_CHARS + 200);
  });
});

describe('buildUniversalPreamble — project tree integration (W4-B)', () => {
  test('emits tree-only when no anchor files exist (lifecycle still emits)', () => {
    // Empty tmp, no AGENTS.md/CLAUDE.md → no anchor, no tree (empty
    // dir → tree returns null)
    const msgs = buildUniversalPreamble({ cwd: tmp });
    // Empty cwd has no tree to emit.
    expect(msgs.length).toBe(2);
    expect((msgs[0]!.content as string)).toContain('Chat without tools');
    expect((msgs[1]!.content as string)).toContain('Coding Agent Pipelines');
  });

  test('emits tree alongside lifecycle when cwd has files (no anchor)', () => {
    writeFileSync(join(tmp, 'README.md'), '# Hello\n');
    const msgs = buildUniversalPreamble({ cwd: tmp });
    // [tree, no-tools guidance, lifecycle]
    expect(msgs.length).toBe(3);
    expect((msgs[0]!.content as string)).toContain('## Project Layout');
    expect((msgs[0]!.content as string)).toContain('- README.md');
    expect((msgs[1]!.content as string)).toContain('Chat without tools');
    expect((msgs[2]!.content as string)).toContain('Coding Agent Pipelines');
  });
});

// BACKLOG L2 — 로컬 모델 자식은 «lean» 예산(앵커 8K · 트리 2K). 기본은 그대로(32K · 8K).
import { projectAnchorMaxChars, projectTreeMaxChars, PROJECT_ANCHOR_LEAN_MAX_CHARS, PROJECT_TREE_LEAN_MAX_CHARS } from '../src/prompt-library/universal-preamble.js';
test('prompt budget: default unchanged, lean via ELANOUS_PROMPT_BUDGET=lean (BACKLOG L2)', () => {
  const saved = process.env.ELANOUS_PROMPT_BUDGET;
  try {
    delete process.env.ELANOUS_PROMPT_BUDGET;
    expect([projectAnchorMaxChars(), projectTreeMaxChars()]).toEqual([PROJECT_ANCHOR_MAX_CHARS, PROJECT_TREE_MAX_CHARS]);
    process.env.ELANOUS_PROMPT_BUDGET = 'lean';
    expect([projectAnchorMaxChars(), projectTreeMaxChars()]).toEqual([PROJECT_ANCHOR_LEAN_MAX_CHARS, PROJECT_TREE_LEAN_MAX_CHARS]);
    expect(PROJECT_ANCHOR_LEAN_MAX_CHARS).toBeLessThan(PROJECT_ANCHOR_MAX_CHARS);
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_PROMPT_BUDGET; else process.env.ELANOUS_PROMPT_BUDGET = saved;
  }
});
