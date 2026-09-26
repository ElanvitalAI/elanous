import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { buildUserConfig, resetUserConfig } from '../src/user-config.js';
import { buildDevCliSpec, type DevCliExecutor } from '../src/self-dev/dev-cli.js';
import { planDevPipeline, toSelfImplementOptions } from '../src/self-dev/dev-pipeline.js';
import { runSelfImplement } from '../src/self-implement/orchestrator.js';
import { seams } from '../src/self-implement/test-seams.js';

const SELF: DevCliExecutor = { kind: 'self' };

type AuthorityObservation = {
  graphAuthoritative: boolean;
  graphAuthoritativeSource: 'flag' | 'config' | 'default';
};

async function runThroughExistingEntry(input: {
  configValue?: boolean;
  goalType?: 'research';
  changedFiles?: readonly string[];
  runId: string;
}): Promise<{ authority: AuthorityObservation; nodeNames: string[]; gateExecuted: boolean }> {
  const configDir = mkdtempSync(join(tmpdir(), 'graph-authority-default-'));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const ledger: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    delete process.env.XDG_CONFIG_HOME;
    setElanousConfigDir(configDir);
    if (input.configValue !== undefined) {
      // This is the persisted raw shape produced by
      // `config set tools.selfImplement.graphAuthoritative <boolean>`.
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        tools: { selfImplement: { graphAuthoritative: input.configValue } },
      }));
    }
    resetUserConfig();

    const spec = buildDevCliSpec({ text: 'graph authority execution entry' }, SELF, {});
    const goalFile = input.goalType === undefined
      ? undefined
      : join(configDir, 'GOAL.md');
    if (goalFile !== undefined) writeFileSync(goalFile, `대상 경로: docs/x.md\n- GoalId: 1111111111111111\n- GoalType: ${input.goalType}\n\n# research goal\n`);
    const options = toSelfImplementOptions(
      'graph authority execution entry',
      planDevPipeline(spec),
      seams({
        writeRunLedger: (entry) => {
          ledger.push({ event: entry.event, data: entry.data });
        },
        ...(input.changedFiles === undefined ? {} : { changedFilesForGateRoute: () => input.changedFiles! }),
      }),
    );
    await runSelfImplement({ ...options, ...(goalFile === undefined ? {} : { goalFile }), runId: input.runId });

    const authority = ledger.find(({ event }) => event === 'graph-authority-resolved')?.data;
    expect(authority).toBeDefined();
    return {
      authority: authority as AuthorityObservation,
      nodeNames: ledger
        .filter(({ event }) => event === 'pipeline-node-entry')
        .map(({ data }) => String(data.node)),
      gateExecuted: ledger.some(({ event, data }) => event === 'gated' && data.gateExecuted === true),
    };
  } finally {
    resetUserConfig();
    resetElanousConfigDir();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe('graph authority default and source ladder', () => {
  test('missing setting reaches runSelfImplement as enabled/default and records node names', async () => {
    const observed = await runThroughExistingEntry({ runId: 'run-graph-default' });
    expect(observed.authority).toMatchObject({
      graphAuthoritative: true,
      graphAuthoritativeSource: 'default',
    });
    expect(observed.nodeNames).toEqual(['implement', 'gate', 'open-pr']);
  });

  test('default graph authority intentionally skips the gate for research document-only changes', async () => {
    const defaultOn = await runThroughExistingEntry({
      goalType: 'research', changedFiles: ['docs/research.md'], runId: 'run-default-docs-skip',
    });
    expect(defaultOn.authority).toMatchObject({ graphAuthoritative: true, graphAuthoritativeSource: 'default' });
    expect(defaultOn.gateExecuted).toBe(false);
  });

  // 🆕 2026-09-26 설정 졸업 — 그래프 권위는 항상 켬: 끄는 길(설정 키 · `--graph` 플래그)이 사라졌다.
  //   옛 설정 `graphAuthoritative: false` 가 남아 있어도 권위는 켜져 있고 출처는 `default` 다(은퇴 키).
  test('retired config false no longer turns authority off — enabled with default provenance', async () => {
    const enabled = await runThroughExistingEntry({ configValue: true, runId: 'run-config-on' });
    const retiredOff = await runThroughExistingEntry({ configValue: false, runId: 'run-config-off' });
    expect(enabled.authority).toMatchObject({ graphAuthoritative: true, graphAuthoritativeSource: 'default' });
    expect(retiredOff.authority).toMatchObject({ graphAuthoritative: true, graphAuthoritativeSource: 'default' });
  });

  test('adjacent selfImplement defaults remain unchanged', () => {
    const config = buildUserConfig('/definitely/missing/graph-authority-default.json');
    // 2026-09-26 졸업: graphAuthoritative 키는 은퇴했다(항상 켬) — 설정에 더는 없다.
    expect(config.tools.selfImplement).not.toHaveProperty('graphAuthoritative');
    expect(config.tools.selfImplement).toMatchObject({
      observeOnly: false,
      fabricDecompose: false,
      autoOpenPr: true,
    });
  });
});
