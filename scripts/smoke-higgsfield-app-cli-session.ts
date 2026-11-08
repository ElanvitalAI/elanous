import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppActions, type AppActionDeclaration } from '../src/nexus/apps/app-actions.js';
import type { AppActionResolvedCredentials } from '../src/nexus/apps/app-actions.js';
import { createAppJobLedger, createAppJobs, createAppJobsGenerateAction } from '../src/nexus/apps/app-jobs.js';
import { createHiggsfieldAppBackend, downloadHiggsfieldResult, resolveHiggsfieldAppCredentialForApp } from '../src/nexus/apps/higgsfield-backend.js';

const APP_SLUG = 'voice-note';
const IMAGE_REFERENCE = 'uploads/mvp-d-hf-smoke.png';
const args = process.argv.slice(2);
const imagePath = args.find(arg => !arg.startsWith('--')) ?? '/tmp/mvp-d-hf-smoke.png';

if (!args.includes('--confirm-spend')) {
  console.error('Refusing a real Higgsfield request without --confirm-spend.');
  process.exitCode = 2;
} else {
  const workDir = mkdtempSync(join(tmpdir(), 'voice-note-higgsfield-live-'));
  const ledger = createAppJobLedger(join(workDir, 'jobs.sqlite'));
  const jobs = createAppJobs({
    ledger,
    pollIntervalMs: 3_000,
    maxPolls: 240,
    saveResult: async ({ appSlug, jobId, url }) => {
      const downloaded = await downloadHiggsfieldResult(url, 25 * 1024 * 1024);
      if (!downloaded) return undefined;
      const extension = downloaded.contentType === 'video/mp4' ? 'mp4' : 'webm';
      writeFileSync(join(workDir, `${jobId}.${extension}`), downloaded.bytes, { mode: 0o600, flag: 'wx' });
      return { key: `apps/${appSlug}/generated/${jobId}.${extension}` };
    },
  });
  try {
    const image = new Uint8Array(readFileSync(imagePath));
    const runtime = {
      jobs,
      ledger,
      backendForCredentials(credentials: AppActionResolvedCredentials) {
        if (credentials.appSlug !== APP_SLUG || credentials.keyId !== credentials.secret || typeof credentials.keyId !== 'object') {
          throw new Error('voice-note CLI session capability is unavailable');
        }
        return createHiggsfieldAppBackend(credentials);
      },
    };
    const actions = createAppActions({
      secrets: { async resolve({ appSlug, reference }) {
        const resolution = await resolveHiggsfieldAppCredentialForApp(appSlug, reference, async () => undefined);
        return resolution.handled ? resolution.value : undefined;
      } },
      readImageObject: async ({ appSlug, reference }) => appSlug === APP_SLUG && reference === IMAGE_REFERENCE
        ? { bytes: image, mimeType: 'image/png' }
        : undefined,
      generate: createAppJobsGenerateAction(runtime),
    });
    const declaration: AppActionDeclaration = {
      builtin: 'generate', async: true, spend: 'owner-confirm',
      uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'],
    };
    const queued = await actions.run({
      appSlug: APP_SLUG,
      actionName: 'makeAd',
      declaration,
      payload: {
        image: IMAGE_REFERENCE,
        text: 'Create a brief product showcase of the generic blue test mug on a clean studio background.',
        confirmSpend: true,
      },
    });
    if (!('jobId' in queued)) throw new Error('voice-note app action did not queue a generation job');
    console.log(`app=voice-note action=makeAd status=queued job=${queued.jobId}`);

    const deadline = Date.now() + 15 * 60_000;
    let finalStatus = 'unknown';
    while (Date.now() < deadline) {
      const current = jobs.get({ appSlug: APP_SLUG, jobId: queued.jobId });
      if (!current) throw new Error('voice-note app job disappeared');
      finalStatus = current.status;
      if (finalStatus === 'completed' || finalStatus === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (finalStatus !== 'completed') throw new Error(`voice-note app job did not complete (status=${finalStatus})`);
    console.log(`app=voice-note action=makeAd status=completed job=${queued.jobId}; CLI session values were not read or persisted`);
  } catch {
    console.error('Higgsfield app CLI-session smoke failed; provider details and credential material were withheld.');
    process.exitCode = 1;
  } finally {
    jobs.close();
    ledger.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}
