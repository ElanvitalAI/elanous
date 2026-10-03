import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const indexModule = `${import.meta.dir}/../src/index.ts`;
const configModule = `${import.meta.dir}/../src/user-config.ts`;

function captureBootPrompts(documentReferences: string | undefined): { first: string | undefined; second: string | undefined } {
  const stateDir = mkdtempSync(join(tmpdir(), 'document-references-child-'));
  try {
    const child = spawnSync('bun', ['--eval', `
      import { getUserConfig } from ${JSON.stringify(configModule)};
      const { runChatTurnCli } = await import(${JSON.stringify(indexModule)});
      const cfg = getUserConfig();
      cfg.chat.toolDeny = [];
      const prompts = [];
      const capture = async (input) => {
        prompts.push(input.systemPrompt);
        return { provider: 'test', model: 'test' };
      };
      await runChatTurnCli({ cfg, userText: 'child instruction', explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools: true, runTurn: capture });
      delete process.env.ELANOUS_DOCUMENT_REFERENCES;
      await runChatTurnCli({ cfg, userText: 'child instruction', explicitSessionId: undefined, reuseActive: false, forceNew: true, json: true, enableTools: true, runTurn: capture });
      console.log(JSON.stringify({ first: prompts[0], second: prompts[1] }));
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELANOUS_STATE_DIR: stateDir,
        ...(documentReferences === undefined ? {} : { ELANOUS_DOCUMENT_REFERENCES: documentReferences }),
      },
    });
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe('child boot document references', () => {
  test('makes every parent-supplied reference path known in the captured child system prompt', () => {
    const references = [
      { path: 'docs/architecture.md', result: { kind: 'ok', contents: 'architecture' } },
      { path: 'src/self-implement/harness-policy.ts', result: { kind: 'ok', contents: 'policy' } },
    ];

    const { first, second } = captureBootPrompts(JSON.stringify(references));

    expect(first).toContain('Document references supplied by the parent');
    for (const { path } of references) expect(first).toContain(path);
    expect(first).toContain('you may decide whether to open them');
    expect(second).not.toContain('Document references supplied by the parent');
  });

  test('leaves the child prompt unchanged when references are absent, malformed, or not an array', () => {
    const absent = captureBootPrompts(undefined);
    const malformed = captureBootPrompts('{not json');
    const notArray = captureBootPrompts(JSON.stringify({ path: 'docs/not-an-array.md' }));

    expect(absent.first).toBe(absent.second);
    expect(malformed.first).toBe(malformed.second);
    expect(notArray.first).toBe(notArray.second);
  });
});
