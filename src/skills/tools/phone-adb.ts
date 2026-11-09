import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import type { LLMToolSpec } from '../../llm/tool-spec.js';
import { DecisionLedger, type RaiseInput } from '../../decisions/decision-ledger.js';
import { debug } from '../../debug/log.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';

export type PhoneAdbSafety = 'SAFE_COMPLETE' | 'CONFIRM_FIRST' | 'NEVER_AUTO';
export interface AdbCommandResult { readonly stdout: Buffer; readonly stderr: Buffer; readonly exitCode: number }
export type AdbCommandRunner = (args: readonly string[], timeoutMs?: number) => Promise<AdbCommandResult>;
export interface PhoneAdbDeps {
  readonly runAdb?: AdbCommandRunner;
  readonly outputDir?: string;
  readonly requestDecision?: (input: RaiseInput, ref: string, approvalId?: string) => Promise<{ id: string; status: 'pending' | 'approved' | 'denied' }>;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}
export type PhoneAdbResult = { output: string; mediaType?: 'image/png'; dataB64?: string; isError?: true };

class AdbExecutionError extends Error {
  constructor(message: string, readonly outcome: 'not-started' | 'unknown') {
    super(message);
    this.name = 'AdbExecutionError';
  }
}

const MAX_TEXT_LENGTH = 2_000;
const COMMAND_TIMEOUT_MS = 12_000;
const SENSITIVE = /\b(password|passcode|one[- ]?time|otp|verification.?code|security.?code|secret|token|cvv|cvc|iban|credit.?card|pay(?:ment)?|buy|transfer|delete|remove|purchase|checkout|send.?money)\b/i;

function defaultRunner(args: readonly string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<AdbCommandResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const child = spawn('adb', [...args], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5037' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AdbExecutionError(`adb could not start: ${error.message}`, 'not-started'));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new AdbExecutionError('adb command timed out after dispatch; device outcome is unknown', 'unknown'));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1 });
    });
  });
}

function parseSerials(stdout: string): string[] {
  return stdout.split(/\r?\n/).slice(1).flatMap((line) => {
    const match = /^([^\s]+)\s+device(?:\s|$)/.exec(line);
    return match ? [match[1]!] : [];
  });
}

function isTailnetHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
  if (lower.endsWith('.ts.net')) return true;
  if (isIP(lower) === 4) {
    const parts = lower.split('.').map(Number);
    return parts[0] === 127 || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
  }
  return /^fd7a:115c:a1e0:/i.test(lower) || lower === '::1';
}

export function isAllowedAdbSerial(serial: string): boolean {
  if (!serial || /[\s;|&`$<>]/.test(serial)) return false;
  const colon = serial.lastIndexOf(':');
  if (colon < 0) return /^[A-Za-z0-9._-]{4,128}$/.test(serial);
  const host = serial.slice(0, colon).replace(/^\[|\]$/g, '');
  const port = serial.slice(colon + 1);
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && isTailnetHost(host);
}

function log(deps: PhoneAdbDeps, event: string, data: Record<string, unknown>): void {
  try { (deps.log ?? ((name, detail) => debug.log('phone.adb', name, detail)))(event, data); } catch { /* observation must not hide the phone result */ }
}

async function runAdb(args: readonly string[], deps: PhoneAdbDeps): Promise<Buffer> {
  const result = await (deps.runAdb ?? defaultRunner)(args, COMMAND_TIMEOUT_MS);
  if (result.exitCode !== 0) throw new AdbExecutionError(`adb exited ${result.exitCode}; device outcome is unknown: ${result.stderr.toString('utf8').slice(0, 500)}`, 'unknown');
  return result.stdout;
}

function mutationFailure(action: string, serial: string, error: unknown, deps: PhoneAdbDeps): PhoneAdbResult {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof AdbExecutionError && error.outcome === 'not-started') return refuses(action, reason, { serial }, deps);
  log(deps, 'command-outcome-unknown', { action, serial, safety: 'CONFIRM_FIRST', outcome: 'unknown', reason });
  return { output: `PhoneAdb ${action} safety=CONFIRM_FIRST mutation=outcome-unknown device=${serial} reason=${reason}; inspect the device before retrying` };
}

async function selectDevice(raw: Record<string, unknown>, deps: PhoneAdbDeps): Promise<string> {
  const requested = typeof raw.device_id === 'string' ? raw.device_id.trim() : '';
  const devices = parseSerials((await runAdb(['devices', '-l'], deps)).toString('utf8'));
  const serial = requested || (devices.length === 1 ? devices[0]! : '');
  if (!serial) throw new Error(devices.length ? 'device_id is required when more than one adb device is connected' : 'no connected adb device');
  if (!isAllowedAdbSerial(serial)) throw new Error('adb device must be USB/emulator, loopback or tailnet only');
  if (!devices.includes(serial)) throw new Error('adb device is not connected or is unauthorized');
  return serial;
}

async function dimensions(serial: string, deps: PhoneAdbDeps): Promise<{ width: number; height: number }> {
  const output = (await runAdb(['-s', serial, 'shell', 'wm', 'size'], deps)).toString('utf8');
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const match = matches.at(-1);
  if (!match) throw new Error('adb did not report the current screen dimensions');
  const physicalWidth = Number(match[1]);
  const physicalHeight = Number(match[2]);
  if (!Number.isSafeInteger(physicalWidth) || !Number.isSafeInteger(physicalHeight) || physicalWidth < 1 || physicalHeight < 1) throw new Error('adb reported invalid screen dimensions');
  const displayState = (await runAdb(['-s', serial, 'shell', 'dumpsys', 'input'], deps)).toString('utf8');
  const defaultViewport = displayState.split(/\r?\n/)
    .find((line) => /\b(?:DisplayViewport|Viewport(?:\s+\w+)?):/.test(line) && /\bdisplayId\s*=\s*0\b/.test(line));
  const orientation = defaultViewport
    ? /orientation\s*[:=]?\s*([0-3])\b/i.exec(defaultViewport)
    : /SurfaceOrientation\s*[:=]?\s*([0-3])\b/i.exec(displayState);
  if (!orientation) throw new Error('adb did not report the current display orientation');
  const rotated = Number(orientation[1]) % 2 === 1;
  return rotated ? { width: physicalHeight, height: physicalWidth } : { width: physicalWidth, height: physicalHeight };
}

function saveScreenshot(png: Buffer, deps: PhoneAdbDeps): string {
  const outputDir = deps.outputDir ?? mkdtempSync(join(tmpdir(), 'elanous-phone-adb-'));
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const path = join(outputDir, `screen-${Date.now()}.png`);
  writeFileSync(path, png, { mode: 0o600 });
  return path;
}

async function screenshot(serial: string, deps: PhoneAdbDeps): Promise<{ path: string; bytes: number; png: Buffer }> {
  const png = await runAdb(['-s', serial, 'exec-out', 'screencap', '-p'], deps);
  if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('adb screenshot was not a PNG');
  return { path: saveScreenshot(png, deps), bytes: png.length, png };
}

function nodeAttributes(node: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of node.matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) attributes[match[1]!] = match[2]!;
  return attributes;
}

function sensitiveNode(attributes: Record<string, string>): boolean {
  return attributes.password?.toLowerCase() === 'true'
    || /password|passcode|secret|token|otp|code|credit.?card|cvv|iban/i.test(attributes['resource-id'] ?? '')
    || /password|passcode|secret|token|otp|code|credit.?card|cvv|iban/i.test(attributes.class ?? '')
    || Object.values(attributes).some((value) => SENSITIVE.test(value));
}

function secretUiValue(value: string): boolean {
  const trimmed = value.trim();
  return SENSITIVE.test(trimmed)
    || /(?<!\d)\d{4,8}(?!\d)/.test(trimmed)
    || /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{4,16}$/.test(trimmed)
    || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)
    || /^[A-Fa-f0-9]{32,}$/.test(trimmed);
}

interface UiNodeContext {
  readonly attributes: Record<string, string>;
  readonly sensitive: boolean;
}

function uiNodeContexts(xml: string): UiNodeContext[] {
  const inherited: boolean[] = [];
  const contexts: UiNodeContext[] = [];
  for (const tag of xml.match(/<\/?node\b[^>]*>/g) ?? []) {
    if (tag.startsWith('</')) {
      inherited.pop();
      continue;
    }
    const attributes = nodeAttributes(tag);
    const sensitive = Boolean(inherited.at(-1)) || sensitiveNode(attributes)
      || [attributes.text, attributes['content-desc']].some((value) => value !== undefined && secretUiValue(value));
    contexts.push({ attributes, sensitive });
    if (!tag.endsWith('/>')) inherited.push(sensitive);
  }
  return contexts;
}

function redactUiDump(xml: string): string {
  const contexts = uiNodeContexts(xml);
  const sensitiveAncestors: boolean[] = [];
  let contextIndex = 0;
  return xml.replace(/<\/?node\b[^>]*>/g, (tag) => {
    if (tag.startsWith('</')) {
      sensitiveAncestors.pop();
      return tag;
    }
    const context = contexts[contextIndex++];
    const sensitive = context?.sensitive ?? true;
    const redacted = sensitive ? tag.replace(/\b(text|content-desc)="[^"]*"/g, '$1="[REDACTED]"') : tag;
    if (!tag.endsWith('/>')) sensitiveAncestors.push(sensitive);
    return redacted;
  });
}

async function rawUiDump(serial: string, deps: PhoneAdbDeps): Promise<string> {
  const remotePath = `/data/local/tmp/elanous-phone-ui-${randomUUID()}.xml`;
  await runAdb(['-s', serial, 'shell', 'uiautomator', 'dump', remotePath], deps);
  try {
    const xml = (await runAdb(['-s', serial, 'exec-out', 'cat', remotePath], deps)).toString('utf8');
    if (!xml.includes('<hierarchy')) throw new Error('adb did not return a UI hierarchy');
    return xml;
  } finally {
    await runAdb(['-s', serial, 'shell', 'rm', '-f', remotePath], deps);
  }
}

async function inspectSensitiveTarget(serial: string, x: number, y: number, deps: PhoneAdbDeps): Promise<boolean> {
  const xml = await rawUiDump(serial, deps);
  for (const node of uiNodeContexts(xml)) {
    const attrs = node.attributes;
    const bounds = typeof attrs.bounds === 'string' ? /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds) : null;
    if (!node.sensitive) continue;
    if (!bounds) return true;
    const [, left, top, right, bottom] = bounds.map(Number);
    if (x >= left! && x <= right! && y >= top! && y <= bottom!) return true;
  }
  return false;
}

async function inspectFocusedInput(serial: string, deps: PhoneAdbDeps): Promise<string | undefined> {
  const xml = await rawUiDump(serial, deps);
  const focused = uiNodeContexts(xml).filter(({ attributes }) => attributes.focused?.toLowerCase() === 'true');
  if (focused.length !== 1) return 'input-target-unknown';
  const [{ attributes: target, sensitive }] = focused;
  if (!target || sensitive) return 'sensitive-input-target';
  const editable = target.editable?.toLowerCase() === 'true'
    || /(?:EditText|AutoCompleteTextView)$/.test(target.class ?? '');
  return editable ? undefined : 'input-target-unknown';
}

function approvalFingerprint(action: string, serial: string, payload: Record<string, unknown>): string {
  const canonical = JSON.stringify({ action, serial, payload });
  return `phone-adb:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function consumePhoneApprovalOnce(approvalId: string, fingerprint: string, stateRoot = elanousStateRoot()): boolean {
  const directory = join(stateRoot, 'phone-adb', 'consumed-decisions');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${approvalId}.json`);
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try { writeSync(fd, JSON.stringify({ approvalId, fingerprint, consumedAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
  return true;
}

async function requestApproval(
  action: string,
  serial: string,
  payload: Record<string, unknown>,
  approvalId: string | undefined,
  deps: PhoneAdbDeps,
): Promise<{ id: string; status: 'pending' | 'approved' | 'denied' }> {
  const fingerprint = approvalFingerprint(action, serial, payload);
  const detail = action === 'tap'
    ? `coordinates=${String(payload.x)},${String(payload.y)}`
    : action === 'type'
      ? `text=${String(payload.text)}`
      : `url=${String(payload.url)}`;
  if (deps.requestDecision) {
    const ref = `${fingerprint}:${approvalId ?? 'new'}`;
    const input: RaiseInput = {
      title: `Android phone ${action} request`, category: 'security',
      scqa: { s: `An Android adb ${action} action was requested for device ${serial}: ${detail}.`, c: 'Phone actions can change signed-in application state.', q: 'Allow this exact action?', a: 'Run it only after an explicit human decision.' },
      options: [
        { key: 'approve', label: 'Allow once', consequence: 'Run only this exact action once.' },
        { key: 'deny', label: 'Deny', consequence: 'Do not change the phone.' },
      ],
      recommendation: { skipped: true, reason: 'Phone actions require a human decision.' },
      raisedBy: { agent: 'phone-adb', track: 'T' }, refs: [ref],
    };
    return deps.requestDecision(input, ref, approvalId);
  }
  const input: RaiseInput = {
    title: `Android phone ${action} request`, category: 'security',
    scqa: {
      s: `An Android adb ${action} action was requested for device ${serial}: ${detail}.`,
      c: 'Phone actions can affect a signed-in account or change application state.',
      q: 'Allow this exact action on the connected device?',
      a: 'Run it only after an explicit human decision; otherwise leave the device unchanged.',
    },
    options: [
      { key: 'approve', label: 'Allow once', consequence: 'Run only this exact action once.' },
      { key: 'deny', label: 'Deny', consequence: 'Do not change the phone.' },
    ],
    recommendation: { skipped: true, reason: 'Phone actions require a human decision.' },
    raisedBy: { agent: 'phone-adb', track: 'T' },
  };
  const ledger = new DecisionLedger();
  if (!approvalId) {
    const existing = ledger.list({ status: 'open' }).find((entry) => entry.refs?.some((ref) => ref.startsWith(`${fingerprint}:`)));
    const ref = `${fingerprint}:${randomUUID()}`;
    const entry = existing ?? ledger.raiseOnce({ ...input, refs: [ref] }, ref);
    return { id: entry.id, status: 'pending' };
  }
  if (!/^[A-Z0-9-]{1,80}$/.test(approvalId)) return { id: approvalId, status: 'denied' };
  const entry = ledger.list({ status: 'all' }).find((row) => row.id === approvalId);
  if (!entry || !entry.refs?.some((ref) => ref.startsWith(`${fingerprint}:`))) return { id: approvalId, status: 'denied' };
  if (entry.status === 'open') return { id: entry.id, status: 'pending' };
  if (entry.status === 'decided' && entry.choice === 'approve' && entry.decidedBy?.kind === 'human'
    && consumePhoneApprovalOnce(entry.id, fingerprint)) return { id: entry.id, status: 'approved' };
  return { id: entry.id, status: 'denied' };
}

function pendingText(action: string, approval: { id: string; status: 'pending' | 'approved' | 'denied' }): string | undefined {
  if (approval.status === 'pending') return `PhoneAdb ${action} safety=CONFIRM_FIRST decision_id=${approval.id} approval_id=${approval.id} status=pending; no phone action was executed.`;
  if (approval.status === 'denied') return `PhoneAdb ${action} safety=NEVER_AUTO decision_id=${approval.id} status=denied; no phone action was executed.`;
  return undefined;
}

function refuses(action: string, reason: string, details: Record<string, unknown>, deps: PhoneAdbDeps): PhoneAdbResult {
  log(deps, 'refused', { action, safety: 'NEVER_AUTO', reason, ...details });
  return { output: `PhoneAdb ${action} safety=NEVER_AUTO refused=${reason}`, isError: true };
}

function params(name: string, description: string, properties: Record<string, unknown>, required: string[]): LLMToolSpec {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

const deviceId = { type: 'string', description: 'Connected USB/emulator serial or loopback/tailnet adb endpoint.' };
export function buildPhoneAdbScreenshotTool(): LLMToolSpec {
  return params('PhoneAdbScreenshot', 'Capture the connected Android screen as PNG; only local adb server and USB/emulator/tailnet targets are allowed.', { device_id: deviceId }, []);
}
export function buildPhoneAdbUiDumpTool(): LLMToolSpec {
  return params('PhoneAdbUiDump', 'Read the Android UI hierarchy. Password and secret field text is redacted.', { device_id: deviceId }, []);
}
export function buildPhoneAdbTapTool(): LLMToolSpec {
  return params('PhoneAdbTap', 'Tap a screen coordinate after raising a human decision. Pass approval_id from the pending decision only after a human approves it. Coordinates are checked against live device dimensions.', { device_id: deviceId, x: { type: 'integer' }, y: { type: 'integer' }, approval_id: { type: 'string' } }, ['x', 'y']);
}
export function buildPhoneAdbTypeTool(): LLMToolSpec {
  return params('PhoneAdbType', 'Type plain text after raising a human decision. Pass approval_id from the pending decision only after a human approves it. Secret-shaped fields and sensitive action text are never automated.', { device_id: deviceId, text: { type: 'string', maxLength: MAX_TEXT_LENGTH }, approval_id: { type: 'string' } }, ['text']);
}
export function buildPhoneAdbOpenUrlTool(): LLMToolSpec {
  return params('PhoneAdbOpenUrl', 'Open an HTTP(S) URL on the Android device after raising a human decision. Pass approval_id from the pending decision only after a human approves it. URL host must be loopback or tailnet.', { device_id: deviceId, url: { type: 'string', maxLength: 2048 }, approval_id: { type: 'string' } }, ['url']);
}

export async function dispatchPhoneAdbScreenshot(raw: Record<string, unknown>, deps: PhoneAdbDeps = {}): Promise<PhoneAdbResult> {
  try {
    const serial = await selectDevice(raw, deps);
    const size = await dimensions(serial, deps);
    const image = await screenshot(serial, deps);
    log(deps, 'action', { action: 'screenshot', serial, safety: 'SAFE_COMPLETE', dimensions: size, attachmentRef: image.path, bytes: image.bytes, ok: true });
    return { output: `PhoneAdbScreenshot safety=SAFE_COMPLETE device=${serial} screen=${size.width}x${size.height} attachment=${image.path} bytes=${image.bytes}`, mediaType: 'image/png', dataB64: image.png.toString('base64') };
  } catch (error) { return refuses('screenshot', error instanceof Error ? error.message : String(error), {}, deps); }
}

export async function dispatchPhoneAdbUiDump(raw: Record<string, unknown>, deps: PhoneAdbDeps = {}): Promise<PhoneAdbResult> {
  try {
    const serial = await selectDevice(raw, deps);
    const size = await dimensions(serial, deps);
    const rawXml = await rawUiDump(serial, deps);
    const contexts = uiNodeContexts(rawXml);
    const xml = redactUiDump(rawXml);
    if (contexts.some((node) => node.sensitive)) {
      log(deps, 'action', { action: 'ui_dump', serial, safety: 'SAFE_COMPLETE', dimensions: size, screenshotWithheld: true, reason: 'sensitive-ui', ok: true });
      return { output: `PhoneAdbUiDump safety=SAFE_COMPLETE device=${serial} screen=${size.width}x${size.height} screenshot=withheld-sensitive-ui\n${xml}` };
    }
    const image = await screenshot(serial, deps);
    log(deps, 'action', { action: 'ui_dump', serial, safety: 'SAFE_COMPLETE', dimensions: size, attachmentRef: image.path, bytes: image.bytes, ok: true });
    return { output: `PhoneAdbUiDump safety=SAFE_COMPLETE device=${serial} screen=${size.width}x${size.height} attachment=${image.path}\n${xml}`, mediaType: 'image/png', dataB64: image.png.toString('base64') };
  } catch (error) { return refuses('ui_dump', error instanceof Error ? error.message : String(error), {}, deps); }
}

async function finishAction(action: string, serial: string, deps: PhoneAdbDeps, data: Record<string, unknown>): Promise<PhoneAdbResult> {
  log(deps, 'action-completed', { action, serial, safety: 'CONFIRM_FIRST', ok: true, ...data });
  const [sizeResult, imageResult] = await Promise.allSettled([dimensions(serial, deps), screenshot(serial, deps)]);
  const size = sizeResult.status === 'fulfilled' ? sizeResult.value : undefined;
  const image = imageResult.status === 'fulfilled' ? imageResult.value : undefined;
  const observationFailures = [sizeResult, imageResult].flatMap((result) => result.status === 'rejected'
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
  if (observationFailures.length) log(deps, 'observation-failed', { action, serial, errors: observationFailures });
  const detail = [
    size ? `screen=${size.width}x${size.height}` : undefined,
    image ? `attachment=${image.path} bytes=${image.bytes}` : undefined,
    observationFailures.length ? `observation=partial errors=${observationFailures.join('; ')}` : 'observation=complete',
  ].filter(Boolean).join(' ');
  return {
    output: `PhoneAdb ${action} safety=CONFIRM_FIRST device=${serial} mutation=completed ${detail}`,
    ...(image ? { mediaType: 'image/png' as const, dataB64: image.png.toString('base64') } : {}),
  };
}

export async function dispatchPhoneAdbTap(raw: Record<string, unknown>, deps: PhoneAdbDeps = {}): Promise<PhoneAdbResult> {
  const action = 'tap';
  let serial = '';
  let mutationAttempted = false;
  try {
    const x = raw.x; const y = raw.y;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || Number(x) < 0 || Number(y) < 0) return refuses(action, 'invalid-coordinate', { x, y }, deps);
    serial = await selectDevice(raw, deps);
    const size = await dimensions(serial, deps);
    if (Number(x) >= size.width || Number(y) >= size.height) return refuses(action, 'coordinate-out-of-bounds', { serial, x, y, dimensions: size }, deps);
    if (await inspectSensitiveTarget(serial, Number(x), Number(y), deps)) return refuses(action, 'sensitive-control', { serial, x, y }, deps);
    const approval = await requestApproval(action, serial, { x, y }, typeof raw.approval_id === 'string' ? raw.approval_id : undefined, deps);
    log(deps, 'action', { action, serial, safety: approval.status === 'approved' ? 'CONFIRM_FIRST' : 'CONFIRM_FIRST', decisionId: approval.id, ok: approval.status === 'approved' });
    const pending = pendingText(action, approval);
    if (pending) return { output: pending, ...(approval.status === 'denied' ? { isError: true as const } : {}) };
    mutationAttempted = true;
    await runAdb(['-s', serial, 'shell', 'input', 'tap', String(x), String(y)], deps);
    mutationAttempted = false;
    return await finishAction(action, serial, deps, { x, y, decisionId: approval.id });
  } catch (error) { return mutationAttempted ? mutationFailure(action, serial, error, deps) : refuses(action, error instanceof Error ? error.message : String(error), {}, deps); }
}

function encodedInput(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export async function dispatchPhoneAdbType(raw: Record<string, unknown>, deps: PhoneAdbDeps = {}): Promise<PhoneAdbResult> {
  const action = 'type';
  let serial = '';
  let mutationAttempted = false;
  try {
    const text = raw.text;
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return refuses(action, 'invalid-text', {}, deps);
    if (/%s/i.test(text)) return refuses(action, 'unsupported-text-escape', {}, deps);
    if (SENSITIVE.test(text)) return refuses(action, 'sensitive-text', {}, deps);
    serial = await selectDevice(raw, deps);
    const focusRefusal = await inspectFocusedInput(serial, deps);
    if (focusRefusal) return refuses(action, focusRefusal, { serial }, deps);
    const approval = await requestApproval(action, serial, { text }, typeof raw.approval_id === 'string' ? raw.approval_id : undefined, deps);
    log(deps, 'action', { action, serial, safety: 'CONFIRM_FIRST', decisionId: approval.id, ok: approval.status === 'approved', textBytes: Buffer.byteLength(text) });
    const pending = pendingText(action, approval);
    if (pending) return { output: pending, ...(approval.status === 'denied' ? { isError: true as const } : {}) };
    const encoded = encodedInput(text.replaceAll(' ', '%s'));
    const remoteCommand = `decoded=$(printf %s '${encoded}' | base64 -d); input text "$decoded"`;
    mutationAttempted = true;
    await runAdb(['-s', serial, 'shell', remoteCommand], deps);
    mutationAttempted = false;
    return await finishAction(action, serial, deps, { decisionId: approval.id, textBytes: Buffer.byteLength(text) });
  } catch (error) { return mutationAttempted ? mutationFailure(action, serial, error, deps) : refuses(action, error instanceof Error ? error.message : String(error), {}, deps); }
}

function allowedDemoUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 2048 || SENSITIVE.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isTailnetHost(url.hostname)) return undefined;
    return url;
  } catch { return undefined; }
}

export async function dispatchPhoneAdbOpenUrl(raw: Record<string, unknown>, deps: PhoneAdbDeps = {}): Promise<PhoneAdbResult> {
  const action = 'open_url';
  let serial = '';
  let mutationAttempted = false;
  try {
    const url = allowedDemoUrl(raw.url);
    if (!url) return refuses(action, 'url-must-use-loopback-or-tailnet-http', {}, deps);
    serial = await selectDevice(raw, deps);
    const approval = await requestApproval(action, serial, { url: url.toString() }, typeof raw.approval_id === 'string' ? raw.approval_id : undefined, deps);
    log(deps, 'action', { action, serial, safety: 'CONFIRM_FIRST', decisionId: approval.id, host: url.hostname, ok: approval.status === 'approved' });
    const pending = pendingText(action, approval);
    if (pending) return { output: pending, ...(approval.status === 'denied' ? { isError: true as const } : {}) };
    const encoded = encodedInput(url.toString());
    const remoteCommand = `url=$(printf %s '${encoded}' | base64 -d); am start -a android.intent.action.VIEW -d "$url"`;
    mutationAttempted = true;
    await runAdb(['-s', serial, 'shell', remoteCommand], deps);
    mutationAttempted = false;
    return await finishAction(action, serial, deps, { decisionId: approval.id, host: url.hostname });
  } catch (error) { return mutationAttempted ? mutationFailure(action, serial, error, deps) : refuses(action, error instanceof Error ? error.message : String(error), {}, deps); }
}

export function buildPhoneAdbTools(): LLMToolSpec[] {
  return [
    buildPhoneAdbScreenshotTool,
    buildPhoneAdbUiDumpTool,
    buildPhoneAdbTapTool,
    buildPhoneAdbTypeTool,
    buildPhoneAdbOpenUrlTool,
  ].map((build) => build());
}
