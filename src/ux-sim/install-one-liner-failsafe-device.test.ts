import { expect, test } from 'bun:test';
import { runInstallOneLinerFailsafeSimulation } from './install-one-liner-failsafe-device.js';

test('documented one-line install refuses a 504 download and removes its temporary installer', async () => {
  const result = await runInstallOneLinerFailsafeSimulation();
  expect(result).toEqual({
    pass: true,
    gatewayTimeout: {
      curlStatus: 22,
      commandStatus: 22,
      httpStatus: '504',
      installerStarted: false,
      installerInvocationCount: 0,
      syntaxCheckCount: 0,
      temporaryInstallerRemoved: true,
    },
    emptyGatewayError: {
      curlStatus: 0,
      status: 1,
      installerStarted: false,
      installerInvocationCount: 0,
      temporaryInstallerRemoved: true,
    },
    partialGatewayTimeout: {
      curlStatus: 22,
      installerStarted: false,
      installerInvocationCount: 0,
      temporaryInstallerRemoved: true,
    },
    success: {
      curlStatus: 0,
      status: 0,
      installerArgs: ['--yes'],
      installerInvocationCount: 1,
      temporaryInstallerRemoved: true,
    },
  });
});
