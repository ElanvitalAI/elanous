/** Isolated journey for a spoken request to create, build, and deploy a Flutter app. */
export const FLUTTER_TEMPLATE_ID = 'flutter-app-lecture-scrap';
export const APP_DEPLOY_TOOL = 'app_deploy';

export type DeployStatus = 'simulated' | 'published' | 'rejected' | 'failed';
export interface SiteDeployOutput {
  kind: 'site-deploy';
  status: DeployStatus;
  publicUrl?: string;
  reason?: string;
}

export interface DeployCard {
  toolName: typeof APP_DEPLOY_TOOL;
  title: string;
  stage: 'create' | 'build' | 'simulate' | 'confirm' | 'publish';
  rawOutput: SiteDeployOutput;
}

export interface FlutterDeployPorts {
  /** Return the origin assigned to this created app by a trusted deployment identity. */
  create(input: { utterance: string; templateId: typeof FLUTTER_TEMPLATE_ID }): Promise<{ appId: string; publicOrigin: string }>;
  build(input: { appId: string; platform: 'android'; format: 'apk' }): Promise<{ artifact: string }>;
  /** DEPLOY-1's app_deploy simulation seam. */
  simulate(input: { appId: string; artifact: string }): Promise<{ rawOutput: SiteDeployOutput; receiptId?: string }>;
  /** ACP elanous/ask is called only after a passing simulation. */
  ask(input: { method: 'elanous/ask/request'; payload: {
    id: string;
    request: { questions: readonly [{
      id: 'confirm'; header: '배포'; question: string;
      options: readonly [{ label: 'N'; description: string }, { label: 'y'; description: string }];
      recommendedIndex: 0; includeOther: false;
    }] };
  } }): Promise<{ answers?: { confirm?: string }; cancelled?: boolean } | null>;
  /** DEPLOY-1's app_deploy publish seam. */
  publish(input: { appId: string; artifact: string; simulationReceipt: string }): Promise<{ rawOutput: SiteDeployOutput }>;
}

const confirmRequest = {
  method: 'elanous/ask/request',
  payload: { id: 'flutter-deploy-confirm', request: { questions: [{
    id: 'confirm', header: '배포', question: '시뮬레이션을 통과했습니다. 앱을 공개 배포할까요?',
    // ACP modal initially selects the first option; this enforces default N.
    options: [
      { label: 'N', description: '공개하지 않습니다.' },
      { label: 'y', description: '공개 배포합니다.' },
    ],
    recommendedIndex: 0, includeOther: false,
  }] } },
} as const;

function card(stage: DeployCard['stage'], rawOutput: SiteDeployOutput): DeployCard {
  return { toolName: APP_DEPLOY_TOOL, title: '앱 배포', stage, rawOutput };
}

function failure(stage: DeployCard['stage'], error: unknown): DeployCard {
  return card(stage, { kind: 'site-deploy', status: 'failed',
    reason: error instanceof Error ? error.message : String(error) });
}

/** No public URL is exposed until publish succeeds after an explicit yes. */
export async function runFlutterDeployJourney(utterance: string, ports: FlutterDeployPorts): Promise<DeployCard> {
  let appId: string;
  let publicOrigin: string;
  try {
    ({ appId, publicOrigin } = await ports.create({ utterance, templateId: FLUTTER_TEMPLATE_ID }));
    if (!appId) throw new Error('app id missing');
    const assigned = new URL(publicOrigin);
    if (assigned.protocol !== 'https:' || !assigned.hostname.endsWith('.elanous.app')
      || assigned.username || assigned.password || assigned.port || assigned.pathname !== '/'
      || assigned.search || assigned.hash) throw new Error('invalid assigned app origin');
    publicOrigin = assigned.origin;
  } catch (error) { return failure('create', error); }

  let artifact: string;
  try {
    ({ artifact } = await ports.build({ appId, platform: 'android', format: 'apk' }));
    if (!artifact.endsWith('.apk')) throw new Error('Android APK missing');
  } catch (error) { return failure('build', error); }

  let receiptId: string;
  try {
    const result = await ports.simulate({ appId, artifact });
    const output = result.rawOutput;
    if (output.kind !== 'site-deploy' || output.publicUrl) throw new Error('invalid simulation output');
    if (output.status === 'rejected' || output.status === 'failed') return card('simulate', output);
    if (output.status !== 'simulated') throw new Error('simulation did not return simulated status');
    if (!result.receiptId) throw new Error('simulation receipt missing');
    receiptId = result.receiptId;
  } catch (error) { return failure('simulate', error); }

  try {
    const answer = await ports.ask(confirmRequest);
    if (answer?.cancelled || answer?.answers?.confirm !== 'y') {
      return card('confirm', { kind: 'site-deploy', status: 'simulated', reason: 'confirmation-declined' });
    }
  } catch (error) { return failure('confirm', error); }

  try {
    const { rawOutput } = await ports.publish({ appId, artifact, simulationReceipt: receiptId });
    if (rawOutput.kind !== 'site-deploy') throw new Error('invalid deploy output');
    if (rawOutput.status === 'published') {
      const url = rawOutput.publicUrl && new URL(rawOutput.publicUrl);
      if (!url || url.origin !== publicOrigin || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('published URL does not match the created app origin');
      }
    } else if (rawOutput.publicUrl) throw new Error('unpublished result has public URL');
    return card('publish', rawOutput);
  } catch (error) { return failure('publish', error); }
}
