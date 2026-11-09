import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPhoneAdbOpenUrlTool,
  buildPhoneAdbScreenshotTool,
  buildPhoneAdbTapTool,
  buildPhoneAdbTools,
  buildPhoneAdbTypeTool,
  buildPhoneAdbUiDumpTool,
  consumePhoneApprovalOnce,
  dispatchPhoneAdbOpenUrl,
  dispatchPhoneAdbScreenshot,
  dispatchPhoneAdbTap,
  dispatchPhoneAdbType,
  dispatchPhoneAdbUiDump,
  isAllowedAdbSerial,
  type PhoneAdbDeps,
} from './phone-adb.js';
import { createFakeAdbPhoneWorld } from '../../ux-sim/fake-adb-phone-world.js';
import type { RaiseInput } from '../../decisions/decision-ledger.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(options: { decision?: 'pending' | 'approved' | 'denied'; uiDump?: string; rotation?: 0 | 1 | 2 | 3; secondaryRotation?: 0 | 1 | 2 | 3; viewportFormat?: 'display-viewport' | 'viewport-internal' } = {}) {
  const world = createFakeAdbPhoneWorld({
    ...(options.uiDump ? { uiDump: options.uiDump } : {}),
    ...(options.rotation === undefined ? {} : { rotation: options.rotation }),
    ...(options.secondaryRotation === undefined ? {} : { secondaryRotation: options.secondaryRotation }),
    ...(options.viewportFormat === undefined ? {} : { viewportFormat: options.viewportFormat }),
  });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const decisions: RaiseInput[] = [];
  const outputDir = mkdtempSync(join(tmpdir(), 'phone-adb-test-'));
  tempDirs.push(outputDir);
  const injected: PhoneAdbDeps = {
    outputDir,
    runAdb: async (args) => ({ stdout: await world.run(args), stderr: Buffer.alloc(0), exitCode: 0 }),
    requestDecision: async (input, ref, approvalId) => {
      decisions.push(input);
      return ({
      id: approvalId ?? `decision-${ref.slice(-8)}`,
      status: options.decision === 'denied' ? 'denied' : approvalId === 'decision-approved' ? (options.decision ?? 'approved') : 'pending',
      });
    },
    log: (event, data) => events.push({ event, data }),
  };
  return { world, events, decisions, outputDir, injected };
}

test('registers exactly five narrow Android adb tools', () => {
  expect(buildPhoneAdbTools().map((tool) => tool.name)).toEqual([
    'PhoneAdbScreenshot', 'PhoneAdbUiDump', 'PhoneAdbTap', 'PhoneAdbType', 'PhoneAdbOpenUrl',
  ]);
  expect(buildPhoneAdbScreenshotTool().parameters.additionalProperties).toBe(false);
  expect(buildPhoneAdbUiDumpTool().parameters.additionalProperties).toBe(false);
  expect(buildPhoneAdbTapTool().parameters.additionalProperties).toBe(false);
  expect(buildPhoneAdbTypeTool().parameters.additionalProperties).toBe(false);
  expect(buildPhoneAdbOpenUrlTool().parameters.additionalProperties).toBe(false);
});

test('screenshot returns an attachment reference and uses the device-reported Fold dimensions', async () => {
  const state = deps();
  const result = await dispatchPhoneAdbScreenshot({}, state.injected);
  const attachment = /attachment=(\S+)/.exec(result.output)?.[1];
  expect(result.output).toContain('screen=2176x1812');
  expect(result.output).toContain('safety=SAFE_COMPLETE');
  expect(attachment && existsSync(attachment)).toBe(true);
  expect(readFileSync(attachment!)).toEqual(expect.any(Buffer));
  expect(result.mediaType).toBe('image/png');
  expect(Buffer.from(result.dataB64!, 'base64')).toEqual(readFileSync(attachment!));
  expect(state.events.map((row) => row.event)).toEqual(['action']);
  expect(state.events[0]?.data.attachmentRef).toBe(attachment);
  expect(state.world.networkAttempts).toEqual([]);
});

test('screen coordinates use dimensions after querying current display rotation', async () => {
  const state = deps({ rotation: 1 });
  const result = await dispatchPhoneAdbScreenshot({}, state.injected);
  expect(result.output).toContain('screen=1812x2176');
  expect(state.world.commands.some((args) => args.join(' ') === `-s ${state.world.serial} shell dumpsys input`)).toBe(true);
});

test('primary display orientation wins when a secondary display reports another rotation', async () => {
  const state = deps({ rotation: 0, secondaryRotation: 1, viewportFormat: 'viewport-internal' });
  const result = await dispatchPhoneAdbScreenshot({}, state.injected);
  expect(result.output).toContain('screen=2176x1812');
});

test('UI dump redacts sensitive subtrees and withholds the matching screen image', async () => {
  const state = deps({ uiDump: '<hierarchy><node resource-id="login/otp" text="Verification code" bounds="[0,0][100,100]"><node text="hunter2" bounds="[1,1][99,99]" /></node><node resource-id="login/code" text="123456" bounds="[0,100][100,200]" /><node resource-id="login/code" text="AB12CD" bounds="[0,200][100,300]" /></hierarchy>' });
  const result = await dispatchPhoneAdbUiDump({}, state.injected);
  expect(result.output).toContain('text="[REDACTED]"');
  expect(result.output).toContain('resource-id="login/otp" text="[REDACTED]"');
  expect(result.output).not.toContain('hunter2');
  expect(result.output).not.toContain('123456');
  expect(result.output).not.toContain('AB12CD');
  expect(result.output).toContain('screenshot=withheld-sensitive-ui');
  expect(result.mediaType).toBeUndefined();
  expect(state.world.commands.some((args) => args.includes('screencap'))).toBe(false);
  expect(result.output).toContain('safety=SAFE_COMPLETE');
});

test('non-sensitive UI dump still includes a screenshot', async () => {
  const result = await dispatchPhoneAdbUiDump({}, deps().injected);
  expect(result.output).toContain('attachment=');
  expect(result.mediaType).toBe('image/png');
});

test('tap validates live dimensions and records a decision before touching the device', async () => {
  const pending = deps();
  const result = await dispatchPhoneAdbTap({ x: 2176, y: 20 }, pending.injected);
  expect(result.output).toContain('NEVER_AUTO');
  expect(result.output).toContain('coordinate-out-of-bounds');
  expect(pending.world.commands.some((args) => args.includes('tap'))).toBe(false);
  expect(pending.events.at(-1)?.event).toBe('refused');

  const approved = deps({ decision: 'approved' });
  const executed = await dispatchPhoneAdbTap({ x: 1088, y: 906, approval_id: 'decision-approved' }, approved.injected);
  expect(executed.output).toContain('safety=CONFIRM_FIRST');
  expect(executed.output).toContain('attachment=');
  expect(executed.mediaType).toBe('image/png');
  expect(Buffer.from(executed.dataB64!, 'base64')).toEqual(readFileSync(/attachment=(\S+)/.exec(executed.output)![1]!));
  expect(approved.world.commands.some((args) => args.includes('tap'))).toBe(true);
  expect(approved.world.commands.some((args) => args.includes('shell') && args.includes('input') && args.includes('tap'))).toBe(true);
});

test('pending and denied tap decisions never execute a device mutation', async () => {
  for (const decision of ['pending', 'denied'] as const) {
    const state = deps({ decision });
    const result = await dispatchPhoneAdbTap({ x: 400, y: 300 }, state.injected);
    expect(result.output).toContain(`status=${decision}`);
    expect(state.world.commands.some((args) => args.includes('tap'))).toBe(false);
  }
});

test('secret-shaped UI controls and sensitive text are NEVER_AUTO', async () => {
  const state = deps({ decision: 'approved', uiDump: '<hierarchy><node text="Sign in" password="true" resource-id="field/1" bounds="[0,0][500,500]" /></hierarchy>' });
  const tap = await dispatchPhoneAdbTap({ x: 100, y: 100 }, state.injected);
  expect(tap.output).toContain('sensitive-control');
  const type = await dispatchPhoneAdbType({ text: 'my password is hunter2' }, state.injected);
  expect(type.output).toContain('sensitive-text');
  expect(state.world.commands.some((args) => args.includes('tap') || args.includes('text'))).toBe(false);
  const deleteButton = deps({ uiDump: '<hierarchy><node text="Delete" resource-id="button/1" bounds="[0,0][500,500]" /></hierarchy>' });
  expect((await dispatchPhoneAdbTap({ x: 10, y: 10 }, deleteButton.injected)).output).toContain('sensitive-control');
  expect(deleteButton.world.commands.some((args) => args.includes('tap'))).toBe(false);
});

test('type refuses sensitive focused fields and unknown focus instead of guessing', async () => {
  const sensitive = deps({ uiDump: '<hierarchy><node class="android.widget.EditText" focused="true" editable="true" resource-id="auth/password" password="true" bounds="[0,0][500,100]" /></hierarchy>' });
  expect((await dispatchPhoneAdbType({ text: 'ordinary text' }, sensitive.injected)).output).toContain('sensitive-input-target');
  expect(sensitive.world.commands.some((args) => args.includes('input'))).toBe(false);
  const unknown = deps({ uiDump: '<hierarchy><node class="android.widget.EditText" editable="true" bounds="[0,0][500,100]" /></hierarchy>' });
  expect((await dispatchPhoneAdbType({ text: 'ordinary text' }, unknown.injected)).output).toContain('input-target-unknown');
  expect(unknown.world.commands.some((args) => args.includes('input'))).toBe(false);
  const inherited = deps({ uiDump: '<hierarchy><node resource-id="auth/otp"><node class="android.widget.EditText" focused="true" editable="true" bounds="[0,0][500,100]" /></node></hierarchy>' });
  expect((await dispatchPhoneAdbType({ text: 'ordinary text' }, inherited.injected)).output).toContain('sensitive-input-target');
  expect(inherited.world.commands.some((args) => args.includes('input'))).toBe(false);
});

test('type displays the approved value and puts only base64 payload in the joined adb shell command', async () => {
  const state = deps({ decision: 'approved' });
  const text = 'Fold $(id); demo ready';
  const result = await dispatchPhoneAdbType({ text, approval_id: 'decision-approved' }, state.injected);
  expect(result.output).toContain('attachment=');
  expect(state.decisions[0]?.scqa.s).toContain(text);
  const command = state.world.commands.find((args) => args[2] === 'shell' && args.length === 4);
  expect(command?.[3]).toBe(`decoded=$(printf %s '${Buffer.from(text.replaceAll(' ', '%s')).toString('base64')}' | base64 -d); input text "$decoded"`);
  expect(command?.[3]).not.toContain(text);
});

test('type refuses text whose percent-space escape would change the approved value', async () => {
  const state = deps({ decision: 'approved' });
  const result = await dispatchPhoneAdbType({ text: '100%s', approval_id: 'decision-approved' }, state.injected);
  expect(result.output).toContain('unsupported-text-escape');
  expect(state.decisions).toHaveLength(0);
  expect(state.world.commands.some((args) => args[2] === 'shell' && args[3]?.includes('input text'))).toBe(false);
});

test('open-url only targets loopback or tailnet and asks through the decision ledger', async () => {
  const blocked = deps({ decision: 'approved' });
  const external = await dispatchPhoneAdbOpenUrl({ url: 'https://example.com/' }, blocked.injected);
  expect(external.output).toContain('NEVER_AUTO');
  expect(blocked.world.commands).toEqual([]);

  const pending = deps();
  const waiting = await dispatchPhoneAdbOpenUrl({ url: 'http://127.0.0.1:4173/' }, pending.injected);
  expect(waiting.output).toContain('status=pending');
  expect(pending.world.commands.some((args) => args.includes('android.intent.action.VIEW'))).toBe(false);
  expect(pending.decisions[0]?.scqa.s).toContain('http://127.0.0.1:4173/');

  const approved = deps({ decision: 'approved' });
  const opened = await dispatchPhoneAdbOpenUrl({ url: 'https://phone-demo.ts.net/', approval_id: 'decision-approved' }, approved.injected);
  expect(opened.output).toContain('attachment=');
  const command = approved.world.commands.find((args) => args[2] === 'shell' && args.length === 4);
  expect(command?.[3]).toBe(`url=$(printf %s '${Buffer.from('https://phone-demo.ts.net/').toString('base64')}' | base64 -d); am start -a android.intent.action.VIEW -d "$url"`);
});

test('successful mutation remains successful when the follow-up screenshot fails', async () => {
  const state = deps({ decision: 'approved' });
  const baseRunner = state.injected.runAdb!;
  const injected: PhoneAdbDeps = {
    ...state.injected,
    runAdb: async (args, timeout) => {
      if (args.includes('screencap') && state.world.commands.some((command) => command.includes('tap'))) {
        throw new Error('simulated screenshot failure');
      }
      return baseRunner(args, timeout);
    },
  };
  const result = await dispatchPhoneAdbTap({ x: 1088, y: 906, approval_id: 'decision-approved' }, injected);
  expect(result.output).toContain('mutation=completed');
  expect(result.output).toContain('observation=partial');
  expect(result.output).not.toContain('safety=NEVER_AUTO');
  expect(state.events.map((row) => row.event)).toContain('action-completed');
  expect(state.events.map((row) => row.event)).toContain('observation-failed');
});

test('adb disconnect after dispatch reports mutation outcome unknown, not refused', async () => {
  const state = deps({ decision: 'approved' });
  const baseRunner = state.injected.runAdb!;
  const injected: PhoneAdbDeps = {
    ...state.injected,
    runAdb: async (args, timeout) => {
      const result = await baseRunner(args, timeout);
      if (args[2] === 'shell' && args[3] === 'input') throw new Error('connection lost after adb dispatch');
      return result;
    },
  };
  const result = await dispatchPhoneAdbTap({ x: 1088, y: 906, approval_id: 'decision-approved' }, injected);
  expect(result.output).toContain('mutation=outcome-unknown');
  expect(result.output).not.toContain('safety=NEVER_AUTO');
  expect(state.events.map((row) => row.event)).toContain('command-outcome-unknown');
  expect(state.world.commands.some((args) => args.includes('tap'))).toBe(true);
});

test('adb target validation permits USB/emulator, loopback and tailnet only', () => {
  expect(isAllowedAdbSerial('R58FAKEPHONE')).toBe(true);
  expect(isAllowedAdbSerial('emulator-5554')).toBe(true);
  expect(isAllowedAdbSerial('127.0.0.1:5555')).toBe(true);
  expect(isAllowedAdbSerial('100.88.1.2:5555')).toBe(true);
  expect(isAllowedAdbSerial('phone-demo.ts.net:5555')).toBe(true);
  expect(isAllowedAdbSerial('192.168.1.2:5555')).toBe(false);
  expect(isAllowedAdbSerial('8.8.8.8:5555')).toBe(false);
  expect(isAllowedAdbSerial('phone;rm -rf:5555')).toBe(false);
});

test('human approval is durably one-time even after a repeated invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'phone-adb-approval-once-'));
  tempDirs.push(root);
  expect(consumePhoneApprovalOnce('D-20261108-01', 'fingerprint', root)).toBe(true);
  expect(consumePhoneApprovalOnce('D-20261108-01', 'fingerprint', root)).toBe(false);
});
