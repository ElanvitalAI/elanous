import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateImageLayerRuntimeKey, gateImagePinPath, prebuildGateImagePinAtCut } from '../../scripts/release-loop/gate-image-pin.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';
import { podSourceScript } from '../task-orchestrator/surfaces/pod-source-receive.js';

const BASE_DIGEST = `sha256:${'a'.repeat(64)}`;
const LOCK_HASH = 'b'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const RUNTIME_RECIPE_HASH = 'd'.repeat(64);
const GATE_DEPS_DIGEST = 'e'.repeat(12);
const SKILLS_DIGEST = 'f'.repeat(16);
const POOL = 'pool-a@aws1:1#k3d-elanous-registry:5051';

/** Two source-only commits share one immutable runtime image while the Pod checks out the exact second SHA. */
export async function runGateImageLayeredDeltaScenario() {
  const root = mkdtempSync(join(tmpdir(), 'gate-image-layered-delta-'));
  try {
    const work = join(root, 'repo');
    const remote = join(root, 'origin.git');
    mkdirSync(work);
    const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git('config', 'user.email', 'sim@example.com');
    git('config', 'user.name', 'sim');
    writeFileSync(join(work, 'bun.lock'), 'stable lock fixture\n');
    writeFileSync(join(work, 'source.ts'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-qm', 'runtime and first source');
    const firstCommit = git('rev-parse', 'HEAD');
    writeFileSync(join(work, 'source.ts'), 'export const value = 2;\n');
    git('add', 'source.ts'); git('commit', '-qm', 'source-only repair');
    const secondCommit = git('rev-parse', 'HEAD');
    execFileSync('git', ['clone', '-q', '--bare', work, remote]);

    const runtimeKey = gateImageLayerRuntimeKey({ baseImageDigest: BASE_DIGEST, lockHash: LOCK_HASH,
      architecture: 'x86_64', bunVersion: '1.4.2', buildRecipeHash: RUNTIME_RECIPE_HASH,
      gateDepsDigest: GATE_DEPS_DIGEST, skillsDigest: SKILLS_DIGEST });
    const runtimeImage = `elanous-harness:${runtimeKey.slice(0, 12)}`;
    const members = parsePodPool(POOL).map(({ context }) => ({ context }));
    const registry = new Map<string, string>();
    let builds = 0;
    let pushes = 0;
    const pins = [] as Array<{ commit: string; digest: string }>;
    for (const [index, commit] of [firstCommit, secondCommit].entries()) {
      const result = await prebuildGateImagePinAtCut({ root, version: '0.3.8', runId: `sim-${index}`, commit,
        image: runtimeImage, members, probe: () => registry.get(runtimeImage) ?? null,
        sync: async () => {
          builds++;
          pushes++;
          registry.set(runtimeImage, IMAGE_DIGEST);
          return new Map(members.map(({ context }) => [context, { ok: true }]));
        } });
      pins.push({ commit, digest: result.digest });
    }

    const imageTree = join(root, 'image-source');
    const imagePinGit = join(root, 'image-pin.git');
    const imageCommit = join(root, 'image-source-commit');
    const pod = join(root, 'pod');
    mkdirSync(imageTree); mkdirSync(pod);
    copyFileSync(join(work, 'bun.lock'), join(imageTree, 'bun.lock'));
    writeFileSync(join(imageTree, 'source.ts'), execFileSync('git', ['-C', work, 'show', `${firstCommit}:source.ts`], { encoding: 'utf8' }));
    // The cached source tree is deliberately at the earlier SHA; the new SHA arrives through Git fetch.
    execFileSync('git', ['init', '-q', '--bare', imagePinGit]);
    execFileSync('git', ['--git-dir', imagePinGit, 'remote', 'add', 'origin', `file://${remote}`]);
    execFileSync('git', ['--git-dir', imagePinGit, 'fetch', '-q', '--depth', '1', 'origin', firstCommit]);
    execFileSync('git', ['--git-dir', imagePinGit, 'update-ref', 'refs/heads/pinned', firstCommit]);
    const secondCommitInImage = spawnSync('git', ['--git-dir', imagePinGit, 'cat-file', '-e', `${secondCommit}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
    writeFileSync(imageCommit, `${firstCommit}\n`);
    const source = podSourceScript({ kind: 'commit', sha: secondCommit }, `file://${remote}`, join(root, 'no-host-mirror'),
      { imageSourceDir: imageTree, imageCommitFile: imageCommit, imageGitDir: imagePinGit });
    const result = Bun.spawnSync(['bash', '-c', `set -e\n${source}`], { cwd: pod });
    const checkedOut = execFileSync('git', ['-C', join(pod, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const sourceValue = execFileSync('git', ['-C', join(pod, 'repo'), 'show', 'HEAD:source.ts'], { encoding: 'utf8' }).trim();
    const secondCommitInPod = spawnSync('git', ['-C', join(pod, 'repo'), 'cat-file', '-e', `${secondCommit}^{commit}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).status === 0;
    return { outcome: result.exitCode === 0 && builds === 1 && pushes === 1 && checkedOut === secondCommit
      && sourceValue === 'export const value = 2;' && pins.every((pin) => pin.digest === IMAGE_DIGEST)
      && !secondCommitInImage && secondCommitInPod
      ? 'reused-runtime-and-checked-out-source-delta' as const : 'layered-delta-failed' as const,
      builds, pushes, runtimeImage, runtimeKey, sameRuntimeKeyAcrossSourceCommits: pins.length === 2 && pins[0]!.digest === pins[1]!.digest,
      runtimeKeyChangesWithMeasuredBaseDigest: gateImageLayerRuntimeKey({ baseImageDigest: IMAGE_DIGEST, lockHash: LOCK_HASH,
        architecture: 'x86_64', bunVersion: '1.4.2', buildRecipeHash: RUNTIME_RECIPE_HASH,
        gateDepsDigest: GATE_DEPS_DIGEST, skillsDigest: SKILLS_DIGEST }) !== runtimeKey,
      pins, firstCommit, secondCommit, checkedOut, sourceValue,
      imageHadSecondCommitBeforePod: secondCommitInImage, podHasSecondCommitAfterReceive: secondCommitInPod,
      sourceOutput: result.stdout.toString(), sourceError: result.stderr.toString(),
      pinFiles: pins.map((_, index) => gateImagePinPath(root, '0.3.8', `sim-${index}`)) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
