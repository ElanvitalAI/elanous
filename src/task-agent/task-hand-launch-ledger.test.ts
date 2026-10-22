import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { handTask } from './task-hand.js';
import { queryLaunchUtterances, withHandLaunchPairContext } from '../harness/launch-utterance-ledger.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const dirs: string[] = [];
afterEach(() => { resetElanousConfigDir(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The injected launcher is the real handTask dispatch seam, before a Pod is submitted.
test('hand parent append failure does not prevent launch and passes a fresh ID and exact text to say child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hand-utterance-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const state = join(root, 'task-agent-actions.json');
  const text = '  한 줄 발사 원문  ';
  mkdirSync(join(root, 'launch-utterances'));
  mkdirSync(join(root, 'launch-utterances', `${new Date().toISOString().slice(0, 10)}.jsonl`));
  let launched = false;
  const result = await handTask({ text, live: true, statePath: state,
    prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }),
    launcher: async (argv, _cwd, context) => {
      launched = true;
      if (!context) throw new Error('launch context missing');
      expect(argv.at(-1)).toBe(text.trim()); // say argv keeps the trimmed card text; the exact original rides the pair env
      expect(context.env.ELANOUS_RUN_ID).toBe(context.runId);
      expect(context.launchId).toMatch(/^tl-[0-9a-f]{12}$/);
      rmSync(join(root, 'launch-utterances', `${new Date().toISOString().slice(0, 10)}.jsonl`), { recursive: true });
      // Same seam defaultTaskLauncher applies before it spawns the say child.
      const launchedContext = withHandLaunchPairContext(argv, context);
      const child = spawn('bun', ['bin/elanous.mjs', '--test', '--config-dir', root, ...argv], {
        cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: root, ...launchedContext.env }, stdio: 'ignore',
      });
      try {
        for (let attempt = 0; attempt < 160 && queryLaunchUtterances({ root }).length === 0; attempt++) {
          if (child.exitCode !== null) break;
          await Bun.sleep(250);
        }
        expect(queryLaunchUtterances({ root })).toHaveLength(1);
      } finally { child.kill('SIGKILL'); }
      return { runId: context.runId };
    },
  });
  expect(launched).toBe(true);
  const launchId = result.card.launchId;
  if (!launchId) throw new Error('hand launch ID missing');
  expect(launchId).toMatch(/^tl-[0-9a-f]{12}$/);
  expect(readFileSync(state, 'utf8')).toContain(text.trim());
  expect(queryLaunchUtterances({ root }).map((row) => ({ source: row.source, utterance: row.utterance, launchId: row.launchId })))
    .toEqual([{ source: 'say', utterance: text, launchId }]);
}, 120_000);

test('live hand records its own start row with the same ID and utterance passed to its launcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hand-utterance-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const text = 'hand parent original';
  const result = await handTask({ text, live: true, statePath: join(root, 'task-agent-actions.json'),
    prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }),
    launcher: async (argv, _cwd, context) => {
      if (!context) throw new Error('launch context missing');
      expect(argv.at(-1)).toBe(text);
      expect(queryLaunchUtterances({ root }).map((row) => ({ source: row.source, utterance: row.utterance, launchId: row.launchId })))
        .toEqual([{ source: 'hand', utterance: text, launchId: context.launchId }]);
      return { runId: context.runId };
    },
  });
  expect(result.launched).toBe(true);
}, 120_000);
