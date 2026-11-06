// Fault injection for reused POD child state. Git is real and local; only the
// worker process inventory is simulated. No cloud, Kubernetes, or network calls.
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePsDevice } from './fake-ps.js';
import { createTempGitRemote, type TempGitRemote } from './temp-git-remote.js';

export interface PodReuseResidueFaultFixture {
  readonly remote: TempGitRemote;
  readonly runCredentialPath: string;
  readonly processes: ReturnType<typeof createFakePsDevice>;
  inject(runId: string): { readonly untrackedPath: string; readonly processId: string };
  residue(): { readonly gitStatus: string; readonly credentials: readonly string[]; readonly processes: readonly string[] };
  revokeCredentials(): number;
  cleanup(): void;
}

/** Seeds observable worktree, run credential and child-process residue on a real local Git checkout. */
export function createPodReuseResidueFaultFixture(): PodReuseResidueFaultFixture {
  const remote = createTempGitRemote();
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'ux-sim-pod-reuse-residue-'));
    const runCredentialPath = join(root, 'credentials', 'run-token');
    const processes = createFakePsDevice();
    const injectedRuns = new Set<string>();
    return {
      remote,
      runCredentialPath,
      processes,
      inject(runId) {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(runId)) throw new Error('runId must be a safe slug');
        if (injectedRuns.has(runId)) throw new Error(`residue fault already injected for run: ${runId}`);
        injectedRuns.add(runId);
        const changedTrackedPath = 'README.md';
        const untrackedPath = `.pod-reuse-residue-${runId}`;
        writeFileSync(join(remote.checkout, changedTrackedPath), `modified by ${runId}\n`);
        writeFileSync(join(remote.checkout, untrackedPath), `left by ${runId}\n`);
        mkdirSync(join(root!, 'credentials'), { recursive: true });
        writeFileSync(runCredentialPath, `credential-for-${runId}\n`, { mode: 0o600 });
        const processId = `child-${runId}`;
        if (!processes.start({ id: processId, host: 'worker-1', releaseVersion: 'sim',
          fingerprint: 'pod-reuse-residue', lane: 'si-v1', mission: runId, command: 'child-runner' })) {
          throw new Error(`fake-ps rejected residue process: ${processId}`);
        }
        return { untrackedPath, processId };
      },
      residue() {
        const gitStatus = remote.git(remote.checkout, ['status', '--porcelain', '-z']);
        const credentials = existsSync(runCredentialPath) ? [runCredentialPath] : [];
        const processIds = processes.list('worker-1').map((process) => process.id);
        return { gitStatus, credentials, processes: processIds };
      },
      revokeCredentials() {
        if (existsSync(runCredentialPath)) unlinkSync(runCredentialPath);
        return existsSync(runCredentialPath) ? 1 : 0;
      },
      cleanup() {
        remote.cleanup();
        if (root) {
          rmSync(root, { recursive: true, force: true });
          root = undefined;
        }
      },
    };
  } catch (error) {
    remote.cleanup();
    if (root) rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

