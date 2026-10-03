import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderTaskNotificationsXml } from '../src/agent/task-notification.js';
import { SELF_DOMAIN, injectUtterance, recallSelfEvents } from '../src/domains/self-awareness.js';
import { openSurfaceEventsDb, recordEvent } from '../src/domains/surface-events.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, '..');
const roots: string[] = [];
const query = 'CLI_OBSERVER_WIRING_TOKEN';
const observerTokenBurst = Array.from({ length: 30 }, () => query).join(' ');
const observer = renderTaskNotificationsXml([{
  taskId: 'observer-cli-task',
  agentName: 'general-purpose',
  state: 'done',
  output: `observer-generated output ${observerTokenBurst}`,
  truncated: false,
  durationMs: 25,
  finishedAt: 1,
}]);
const localIntentional = [
  `${query} intentional local alpha`,
  `${query} intentional local beta`,
];
const fleetIntentional = `${query} intentional federated gamma`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedStore(stateDir: string, entries: string[]): void {
  const db = openSurfaceEventsDb(join(stateDir, 'surface_events.db'));
  try {
    for (const text of entries) {
      if (text !== observer) injectUtterance({ text, origin: 'codex', importance: 10 }, db);
    }
    if (entries.includes(observer)) {
      recordEvent(db, {
        surface: 'dashboard:turn-preamble',
        direction: 'inbound',
        kind: 'utterance',
        category: 'utterance',
        domain: SELF_DOMAIN,
        text: observer,
        summary: observer.slice(0, 150),
        importance: 10,
        ts: new Date(Date.now() + 1000).toISOString(),
      });
    }
  } finally {
    db.close();
  }
}

function runRecall(home: string, stateDir: string, args: string[]): string {
  const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', 'self', 'recall', query, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      ELANOUS_STATE_DIR: stateDir,
      ELANOUS_CONFIG_DIR: stateDir,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function occurrences(output: string, text: string): number {
  return output.split(text).length - 1;
}

describe('elanous self recall observer-output CLI wiring', () => {
  test('spawns only isolated stores: default excludes observers, --include-observer-output includes them, and fleet keeps the requested limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'self-recall-cli-observer-'));
    roots.push(root);
    const home = join(root, 'home');
    const primary = join(home, '.elanous');
    const federated = join(root, 'federated');
    mkdirSync(primary, { recursive: true });
    mkdirSync(federated, { recursive: true });
    // The scoped CLI reads `<ELANOUS_STATE_DIR>/surface_events.db`, while fleet treats
    // HOME/.elanous as prod and reads its managed `memory/` store.
    seedStore(primary, [observer, ...localIntentional]);
    seedStore(join(primary, 'memory'), [observer, ...localIntentional]);
    seedStore(federated, [fleetIntentional]);
    {
      const db = openSurfaceEventsDb(join(primary, 'surface_events.db'));
      try {
        const unfiltered = recallSelfEvents(db, query, { limit: 2, bump: false, excludeObserverOutput: false });
        expect(unfiltered.map((hit) => hit.text)).toContain(observer);
        const filtered = recallSelfEvents(db, query, { limit: 2, bump: false, excludeObserverOutput: true });
        expect(filtered.map((hit) => hit.text)).not.toContain(observer);
        for (const text of localIntentional) expect(filtered.map((hit) => hit.text)).toContain(text);
      } finally {
        db.close();
      }
    }
    mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
    writeFileSync(join(home, '.elanous', 'logs', 'instances.json'), JSON.stringify({
      instances: [
        { name: 'prod', stateDir: primary, kind: 'prod', pid: process.pid, startedAt: new Date().toISOString() },
        { name: 'federated', stateDir: federated, kind: 'prod', pid: process.pid, startedAt: new Date().toISOString() },
      ],
    }));

    const defaultOutput = runRecall(home, primary, ['--limit', '2']);
    expect(defaultOutput).toContain('self-awareness 회상 (2)');
    for (const text of localIntentional) expect(defaultOutput).toContain(text);
    expect(defaultOutput).not.toContain('<task-notification>');
    expect(defaultOutput).not.toContain('observer-generated output');
    expect(occurrences(defaultOutput, 'intentional local')).toBe(2);

    const includedOutput = runRecall(home, primary, ['--limit', '3', '--include-observer-output']);
    expect(includedOutput).toContain('self-awareness 회상 (3)');
    expect(includedOutput).toContain('<task-notification>');
    expect(includedOutput).toContain('observer-generated output');
    for (const text of localIntentional) expect(includedOutput).toContain(text);

    const fleetDefaultOutput = runRecall(home, primary, ['--all-instances', '--limit', '3']);
    expect(fleetDefaultOutput).toContain('self-awareness 회상 · fleet (3 · 2 instances)');
    expect(fleetDefaultOutput).not.toContain('<task-notification>');
    expect(fleetDefaultOutput).not.toContain('observer-generated output');
    for (const text of [...localIntentional, fleetIntentional]) expect(fleetDefaultOutput).toContain(text);
    expect(occurrences(fleetDefaultOutput, 'intentional')).toBe(3);

    const fleetIncludedOutput = runRecall(home, primary, ['--all-instances', '--limit', '4', '--include-observer-output']);
    expect(fleetIncludedOutput).toContain('self-awareness 회상 · fleet (4 · 2 instances)');
    expect(fleetIncludedOutput).toContain('<task-notification>');
    expect(fleetIncludedOutput).toContain('observer-generated output');
  });
});
