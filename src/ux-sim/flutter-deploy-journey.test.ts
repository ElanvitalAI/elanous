import { expect, test } from 'bun:test';
import { runFlutterDeployJourney, type FlutterDeployPorts } from './flutter-deploy-journey.js';

function world(answer: string = 'y', cancelled = false) {
  const calls: string[] = [];
  const ports: FlutterDeployPorts = {
    async create(input) {
      calls.push(`create:${input.templateId}:${input.utterance}`);
      return { appId: 'lecture-scrap', publicOrigin: 'https://lecture-scrap--member.elanous.app' };
    },
    async build(input) {
      calls.push(`build:${input.appId}:${input.platform}:${input.format}`);
      return { artifact: 'build/app/outputs/flutter-apk/app-debug.apk' };
    },
    async simulate(input) {
      calls.push(`simulate:${input.appId}:${input.artifact}`);
      return { rawOutput: { kind: 'site-deploy', status: 'simulated' }, receiptId: 'sim-pass-1' };
    },
    async ask(input) {
      expect(input).toEqual({ method: 'elanous/ask/request', payload: {
        id: 'flutter-deploy-confirm', request: { questions: [{
          id: 'confirm', header: '배포', question: '시뮬레이션을 통과했습니다. 앱을 공개 배포할까요?',
          options: [
            { label: 'N', description: '공개하지 않습니다.' },
            { label: 'y', description: '공개 배포합니다.' },
          ],
          recommendedIndex: 0, includeOther: false,
        }] },
      } });
      calls.push('ask');
      return { answers: { confirm: answer }, cancelled };
    },
    async publish(input) {
      calls.push(`publish:${input.simulationReceipt}`);
      return { rawOutput: { kind: 'site-deploy', status: 'published',
        publicUrl: 'https://lecture-scrap--member.elanous.app/' } };
    },
  };
  return { calls, ports };
}

test('spoken Flutter request passes create, APK build, simulation, ACP yes, then publish', async () => {
  const { calls, ports } = world();
  const result = await runFlutterDeployJourney('강의 노트 앱 만들어 배포해 줘', ports);
  expect(result).toEqual({ toolName: 'app_deploy', title: '앱 배포', stage: 'publish', rawOutput: {
    kind: 'site-deploy', status: 'published', publicUrl: 'https://lecture-scrap--member.elanous.app/',
  } });
  expect(calls).toEqual([
    'create:flutter-app-lecture-scrap:강의 노트 앱 만들어 배포해 줘',
    'build:lecture-scrap:android:apk',
    'simulate:lecture-scrap:build/app/outputs/flutter-apk/app-debug.apk',
    'ask', 'publish:sim-pass-1',
  ]);
});

test('default no, malformed confirmation, and simulation failure never publish', async () => {
  for (const answer of ['N', 'yes', '']) {
    const { calls, ports } = world(answer);
    const result = await runFlutterDeployJourney('앱 배포해 줘', ports);
    expect(result).toMatchObject({ stage: 'confirm', rawOutput: { status: 'simulated' } });
    expect(result.rawOutput.publicUrl).toBeUndefined();
    expect(calls).not.toContain('publish:sim-pass-1');
  }
  const cancelledYes = world('y', true);
  const cancelledResult = await runFlutterDeployJourney('앱 배포해 줘', cancelledYes.ports);
  expect(cancelledResult).toMatchObject({ stage: 'confirm', rawOutput: { status: 'simulated' } });
  expect(cancelledYes.calls).not.toContain('publish:sim-pass-1');
  const { calls, ports } = world();
  ports.simulate = async () => ({ rawOutput: { kind: 'site-deploy', status: 'rejected' } });
  const result = await runFlutterDeployJourney('앱 배포해 줘', ports);
  expect(result).toMatchObject({ stage: 'simulate', rawOutput: { status: 'rejected' } });
  expect(calls).not.toContain('ask');
  expect(calls).not.toContain('publish:sim-pass-1');
});

test('invalid build, missing PASS receipt, and premature URL produce failure cards', async () => {
  const missingApk = world();
  missingApk.ports.build = async () => ({ artifact: 'not-an-apk.txt' });
  expect(await runFlutterDeployJourney('앱', missingApk.ports)).toMatchObject({
    stage: 'build', rawOutput: { kind: 'site-deploy', status: 'failed' },
  });

  const missingReceipt = world();
  missingReceipt.ports.simulate = async () => ({ rawOutput: { kind: 'site-deploy', status: 'simulated' } });
  expect(await runFlutterDeployJourney('앱', missingReceipt.ports)).toMatchObject({
    stage: 'simulate', rawOutput: { status: 'failed', reason: 'simulation receipt missing' },
  });

  const prematureUrl = world();
  prematureUrl.ports.simulate = async () => ({ rawOutput: {
    kind: 'site-deploy', status: 'simulated', publicUrl: 'https://example.com/',
  }, receiptId: 'sim-pass-1' });
  expect(await runFlutterDeployJourney('앱', prematureUrl.ports)).toMatchObject({
    stage: 'simulate', rawOutput: { status: 'failed' },
  });

  const missingPublicUrl = world();
  missingPublicUrl.ports.publish = async () => ({ rawOutput: { kind: 'site-deploy', status: 'published' } });
  expect(await runFlutterDeployJourney('앱', missingPublicUrl.ports)).toMatchObject({
    stage: 'publish', rawOutput: { status: 'failed', reason: 'published URL does not match the created app origin' },
  });

  const wrongApp = world();
  wrongApp.ports.publish = async () => ({ rawOutput: { kind: 'site-deploy', status: 'published',
    publicUrl: 'https://lecture-scrap--other.elanous.app/' } });
  expect(await runFlutterDeployJourney('앱', wrongApp.ports)).toMatchObject({
    stage: 'publish', rawOutput: { status: 'failed', reason: 'published URL does not match the created app origin' },
  });

  const credentials = world();
  credentials.ports.publish = async () => ({ rawOutput: { kind: 'site-deploy', status: 'published',
    publicUrl: 'https://user:password@lecture-scrap--member.elanous.app/' } });
  expect(await runFlutterDeployJourney('앱', credentials.ports)).toMatchObject({
    stage: 'publish', rawOutput: { status: 'failed', reason: 'published URL does not match the created app origin' },
  });
});
