import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPodCommand } from '../../src/task-orchestrator/surfaces/pod-command-job.js';
import { gateShardShell } from './gate-node.js';
import { warmReferenceFromJobArtifacts, writeWarmJobManifest } from './gate-warm-artifacts.js';

// Explicit live probe: two real Kubernetes Jobs, with no injected Pod command,
// kubectl or fake test runner. Run on a configured Pod host with
// ELANOUS_WARM_REFERENCE_LIVE_POD=1 bun test this-file.
test.skipIf(process.env.ELANOUS_WARM_REFERENCE_LIVE_POD !== '1')('two real Pod Jobs cannot exchange a one-file warm reference', async () => {
  const cutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const file = 'src/warm-reference-live-probe.test.ts';
  const root = mkdtempSync(join(tmpdir(), 'warm-reference-live-'));
  const pool = process.env.ELANOUS_WARM_REFERENCE_POOL || 'k3d-elanous-pool:56';
  const jobs: string[] = [];
  const run = async (cause: string, index: number) => {
    const attemptId = randomUUID();
    const source = `import { test } from "bun:test"; test("fails", () => { throw new Error("${cause}"); });\n`;
    const shell = gateShardShell({ parts: [[file]], cdpPatterns: [], softSeconds: 150,
      cachePrefix: '', installSlots: 0, sourceBinding: { cutSha, attemptId } });
    const setup = `origin=$PWD; cd ../repo || exit 1; printf '%s' '${source}' > ${file}; cd "$origin" || exit 1; ${shell}`;
    const name = `warm-reference-live-${index}-${attemptId.slice(0, 8)}`;
    jobs.push(name);
    const job = await runPodCommand({ pool, clone: true, hostMirror: '', source: { kind: 'commit', sha: cutSha },
      name,
      command: ['bash', '-lc', setup], deadlineSeconds: 210, artifactsRoot: root });
    expect(job.exitCode).toBe(0);
    const prefix = join(root, `collected-${index}`);
    for (const suffix of ['log', 'junit.xml', 'rc']) copyFileSync(join(job.artifactsDir, `part-0.${suffix}`), `${prefix}.${suffix}`);
    expect(readFileSync(`${prefix}.rc`, 'utf8').trim()).toBe('1');
    writeFileSync(`${prefix}.json`, JSON.stringify({ rc: 1, files: [file], commit: cutSha, attemptId,
      jobExitCode: job.exitCode, jobFailed: false }));
    expect(writeWarmJobManifest(prefix, file, cutSha, attemptId)).toBe(true);
    expect(warmReferenceFromJobArtifacts(prefix, file, { cutSha, attemptId })).toEqual({
      file, rc: 1, failureIds: [`${file} > fails`], errorIds: [], junitComplete: true,
    });
    return { prefix, attemptId, job: job.job };
  };
  try {
    const first = await run('first', 1);
    const second = await run('second', 2);
    expect(first.job).not.toBe(second.job);
    expect(first.attemptId).not.toBe(second.attemptId);
    const original = [first, second].map(({ prefix }) => ({
      log: readFileSync(`${prefix}.log`), junit: readFileSync(`${prefix}.junit.xml`),
    }));
    for (const [index, target] of [first, second].entries()) {
      writeFileSync(`${target.prefix}.log`, original[1 - index]!.log);
      writeFileSync(`${target.prefix}.junit.xml`, original[1 - index]!.junit);
      expect(writeWarmJobManifest(target.prefix, file, cutSha, target.attemptId)).toBe(true);
      expect(warmReferenceFromJobArtifacts(target.prefix, file, { cutSha, attemptId: target.attemptId })).toBeNull();
    }
  } finally {
    // runPodCommand retains finished Jobs for inspection. This opt-in probe owns
    // only these names and removes them after artifact comparison (also on error).
    const cleanupErrors: string[] = [];
    for (const name of jobs) {
      const deleted = spawnSync('kubectl', ['--context', pool.split(':')[0]!, '-n', 'elanous-test',
        'delete', 'job', name, '--ignore-not-found=true', '--wait=false'], { encoding: 'utf8' });
      if (deleted.status !== 0) cleanupErrors.push(`${name}: ${deleted.stderr}`);
    }
    rmSync(root, { recursive: true, force: true });
    if (cleanupErrors.length) throw new Error(`warm reference probe cleanup failed: ${cleanupErrors.join('; ')}`);
  }
}, 600_000);
