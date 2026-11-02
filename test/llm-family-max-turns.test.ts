// Family tool-loop budget cells — grok owns a named path; claude/codex/gemini
// keep their current numbers; explicit llm.maxTurns.<family> still wins first.
//
// Deleting the claude/codex/gemini assertions in this file is the failure
// signal for "those values stayed the same".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  familyMaxTurnsKey,
  NAMED_MAX_TURNS_FAMILIES,
  resolveFamilyMaxTurns,
} from '../src/llm.js';
import {
  buildUserConfig,
  resetUserConfig,
  setUserConfigOverlay,
  type UserConfig,
} from '../src/user-config.js';

function isolateBudget(
  maxTurns: UserConfig['llm']['maxTurns'],
  answerPriority: NonNullable<UserConfig['llm']['answerPriority']> = 'quality',
): void {
  setUserConfigOverlay((cfg) => ({
    ...cfg,
    llm: {
      ...cfg.llm,
      answerPriority,
      maxTurns,
    },
  }));
}

beforeEach(() => {
  isolateBudget(undefined, 'quality');
});

afterEach(() => {
  setUserConfigOverlay(null);
  resetUserConfig();
});

describe('familyMaxTurnsKey — named cell vs residual default', () => {
  test('grok is a named budget key, not the residual default', () => {
    expect(familyMaxTurnsKey('grok')).toBe('grok');
    expect(familyMaxTurnsKey('grok')).not.toBe('default');
    expect(NAMED_MAX_TURNS_FAMILIES).toContain('grok');
  });

  test('openrouter is chosen by provider name — its models (family other) do not leak into the residual default', () => {
    expect(NAMED_MAX_TURNS_FAMILIES).toContain('openrouter');
    expect(familyMaxTurnsKey('other')).toBe('default');
    expect(resolveFamilyMaxTurns('other', 'openrouter')).toBe(0);
    expect(resolveFamilyMaxTurns('other')).toBe(20);
  });

  test('claude · codex · gemini stay named; local / gpt / other stay residual', () => {
    expect(familyMaxTurnsKey('claude')).toBe('claude');
    expect(familyMaxTurnsKey('codex')).toBe('codex');
    expect(familyMaxTurnsKey('gemini')).toBe('gemini');
    expect(familyMaxTurnsKey('local')).toBe('default');
    expect(familyMaxTurnsKey('gpt')).toBe('default');
    expect(familyMaxTurnsKey('other')).toBe('default');
    expect(familyMaxTurnsKey('unknown-family')).toBe('default');
  });
});

describe('resolveFamilyMaxTurns — quality defaults (no override)', () => {
  test('openai-codex maps gpt to the codex cell while bare gpt remains residual', () => {
    isolateBudget({ codex: null }, 'quality');

    expect(resolveFamilyMaxTurns('gpt', 'openai-codex')).toBe(resolveFamilyMaxTurns('codex'));
    expect(resolveFamilyMaxTurns('gpt')).toBe(20);
    expect(familyMaxTurnsKey('gpt')).toBe('default');
  });

  test('claude · codex · gemini keep the current quality values (delete this and the file fails)', () => {
    expect(resolveFamilyMaxTurns('claude')).toBe(24);
    expect(resolveFamilyMaxTurns('codex')).toBe(0);
    expect(resolveFamilyMaxTurns('gemini')).toBe(16);
  });

	  test('grok quality is unlimited like codex (결정 2026-09-23) — the residual stays 20', () => {
	    expect(familyMaxTurnsKey('grok')).toBe('grok');
	    expect(familyMaxTurnsKey('grok')).not.toBe('default');
	    expect(resolveFamilyMaxTurns('grok')).toBe(0);
	    expect(resolveFamilyMaxTurns('local')).toBe(20);
	    expect(resolveFamilyMaxTurns('other')).toBe(20);
	    expect(resolveFamilyMaxTurns('gpt')).toBe(20);
	  });

	  test('0 remains the unlimited sentinel; a finite grok override still wins over the unlimited default', () => {
	    expect(resolveFamilyMaxTurns('codex')).toBe(0);
	    expect(resolveFamilyMaxTurns('grok')).toBe(0);
	    isolateBudget({ grok: 20 }, 'quality');
	    expect(resolveFamilyMaxTurns('grok')).toBe(20);
	    isolateBudget({ grok: 0 }, 'quality');
	    expect(resolveFamilyMaxTurns('grok')).toBe(0);
	    isolateBudget({ grok: null }, 'quality');
	    expect(resolveFamilyMaxTurns('grok')).toBe(0);
	  });
});

describe('streamLLMWithTools — openai-codex provider budget wiring', () => {
  test('gpt-6-astra uses the codex override through the in-scope provider name', () => {
    // mock.module('./llm.js') in an unrelated test file can replace this module
    // for the remainder of Bun's shared test process. Run this integration seam
    // in a child so its result depends only on the real provider loop and fake
    // provider below, not on suite order or other tests' module registry.
    const home = mkdtempSync(join(tmpdir(), 'llm-family-max-turns-home-'));
    try {
      const script = `
        import { streamLLMWithTools } from './src/llm.ts';
        import { setUserConfigOverlay } from './src/user-config.ts';

        let providerCalls = 0;
        let dispatchedCalls = 0;
        const turns = Array.from({ length: 4 }, (_, index) => [{
          type: 'tool_call', id: 'turn-' + index, name: 'Bash', args: { command: 'echo ' + index },
        }]);
        const provider = {
          name: 'openai-codex',
          defaultModel: 'gpt-6-astra',
          available: () => true,
          async *streamChat() {
            providerCalls += 1;
            for (const event of turns[providerCalls - 1] ?? []) yield event;
          },
          async *chat() {},
        };
        setUserConfigOverlay((cfg) => ({
          ...cfg,
          llm: { ...cfg.llm, answerPriority: 'quality', maxTurns: { codex: 3, default: 1 } },
        }));
        await streamLLMWithTools([{ role: 'user', content: 'q' }], {
          onText: () => {},
          dispatchTool: async () => { dispatchedCalls += 1; return 'r'; },
        }, {
          provider,
          model: 'gpt-6-astra',
          tools: [{ name: 'Bash', description: 'd', parameters: { type: 'object' } }],
        });
        console.log(JSON.stringify({ providerCalls, dispatchedCalls }));
      `;
      const result = Bun.spawnSync([process.execPath, '-e', script], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`isolated provider loop failed (${result.exitCode}): ${result.stderr.toString()}`);
      }
      const output = result.stdout.toString().trim().split('\n').at(-1);
      expect(JSON.parse(output ?? 'null')).toEqual({ providerCalls: 3, dispatchedCalls: 3 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('resolveFamilyMaxTurns — non-quality rows leave claude/codex/gemini unchanged', () => {
  test('cost', () => {
    isolateBudget(undefined, 'cost');
    expect(resolveFamilyMaxTurns('claude')).toBe(6);
    expect(resolveFamilyMaxTurns('codex')).toBe(6);
    expect(resolveFamilyMaxTurns('gemini')).toBe(4);
    expect(resolveFamilyMaxTurns('local')).toBe(4);
  });

  test('balanced', () => {
    isolateBudget(undefined, 'balanced');
    expect(resolveFamilyMaxTurns('claude')).toBe(12);
    expect(resolveFamilyMaxTurns('codex')).toBe(12);
    expect(resolveFamilyMaxTurns('gemini')).toBe(8);
    expect(resolveFamilyMaxTurns('local')).toBe(6);
  });

  test('exhaustive', () => {
    isolateBudget(undefined, 'exhaustive');
    expect(resolveFamilyMaxTurns('claude')).toBe(50);
    expect(resolveFamilyMaxTurns('codex')).toBe(0);
    expect(resolveFamilyMaxTurns('gemini')).toBe(24);
    expect(resolveFamilyMaxTurns('grok')).toBe(0);
    expect(resolveFamilyMaxTurns('other', 'openrouter')).toBe(0);
    expect(resolveFamilyMaxTurns('local')).toBe(12);
  });
});

describe('resolveFamilyMaxTurns — explicit user-config override wins first', () => {
  test('llm.maxTurns.grok finite override beats answerPriority quality', () => {
    isolateBudget({ grok: 42 }, 'quality');
    expect(resolveFamilyMaxTurns('grok')).toBe(42);
    expect(resolveFamilyMaxTurns('local')).toBe(20);
  });

  test('llm.maxTurns.grok 0 / null is unlimited, same path as codex', () => {
    isolateBudget({ grok: 0, codex: 0 }, 'quality');
    expect(resolveFamilyMaxTurns('grok')).toBe(0);
    expect(resolveFamilyMaxTurns('codex')).toBe(0);

    isolateBudget({ grok: null, codex: null }, 'cost');
    expect(resolveFamilyMaxTurns('grok')).toBe(0);
    expect(resolveFamilyMaxTurns('codex')).toBe(0);
  });

  test('override still beats answerPriority for claude · codex · gemini', () => {
    isolateBudget({ claude: 3, codex: 5, gemini: 7 }, 'exhaustive');
    expect(resolveFamilyMaxTurns('claude')).toBe(3);
    expect(resolveFamilyMaxTurns('codex')).toBe(5);
    expect(resolveFamilyMaxTurns('gemini')).toBe(7);
  });
});

describe('user-config parseMaxTurnsBudget — grok seam', () => {
  let root: string;
  let cfgPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'max-turns-budget-'));
    cfgPath = join(root, 'config.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('parses grok the same way as codex, including 0 → unlimited null', () => {
    writeFileSync(cfgPath, JSON.stringify({
      llm: { maxTurns: { grok: 0, codex: 0, claude: 24, gemini: 16 } },
    }));
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.maxTurns?.grok).toBeNull();
    expect(cfg.llm.maxTurns?.codex).toBeNull();
    expect(cfg.llm.maxTurns?.claude).toBe(24);
    expect(cfg.llm.maxTurns?.gemini).toBe(16);
  });

  test('omitted grok stays undefined so the family table default applies', () => {
    writeFileSync(cfgPath, JSON.stringify({
      llm: { maxTurns: { claude: 24 } },
    }));
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.maxTurns?.grok).toBeUndefined();
    expect(cfg.llm.maxTurns?.claude).toBe(24);
    expect(cfg.llm.maxTurns?.default).toBeUndefined();
  });

  test('positive grok override is kept as a finite cap', () => {
    writeFileSync(cfgPath, JSON.stringify({
      llm: { maxTurns: { grok: 30 } },
    }));
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.llm.maxTurns?.grok).toBe(30);
  });
});
