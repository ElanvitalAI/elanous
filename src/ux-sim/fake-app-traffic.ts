const DEFAULT_WINDOW_MS = 60_000;

export type AppTrafficLevel = 'normal' | 'warning' | 'throttled' | 'blocked';
export type AppTrafficBlockReason = 'traffic-cap' | 'admin';

export interface AppTrafficOptions {
  readonly now?: () => number;
  readonly windowMs?: number;
  readonly warningBytes?: number;
  readonly throttleBytes?: number;
  readonly blockBytes?: number;
  readonly throttleDelayMs?: number;
}

export interface AppTrafficDecision {
  readonly accepted: boolean;
  readonly level: AppTrafficLevel;
  readonly status: number;
  readonly throttleDelayMs?: number;
  readonly reason?: AppTrafficBlockReason;
}

export interface AppTrafficUsage {
  readonly windowStartedAt: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
}

export interface AppTrafficLedgerEntry {
  readonly appSlug: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly totalBytes: number;
  readonly status: number;
}

export interface AppTrafficStream {
  readonly isOpen: boolean;
  readonly reason?: AppTrafficBlockReason;
  addRequestBytes(bytes: number): AppTrafficDecision;
  addResponseBytes(bytes: number): AppTrafficDecision;
  finish(status?: number): void;
}

export interface AppTrafficRequest {
  readonly decision: AppTrafficDecision;
  readonly stream?: AppTrafficStream;
}

export interface AppTrafficPort {
  beginRequest(appSlug: string, requestBytes?: number): AppTrafficRequest;
  adminBlock(appSlug: string): void;
  adminUnblock(appSlug: string): void;
  usage(appSlug: string): AppTrafficUsage;
  ledger(): readonly AppTrafficLedgerEntry[];
}

interface MutableUsage {
  windowStartedAt: number;
  requestBytes: number;
  responseBytes: number;
}

interface AppState {
  usage: MutableUsage;
  adminBlocked: boolean;
  readonly streams: Set<StreamState>;
}

interface StreamState {
  readonly appSlug: string;
  requestBytes: number;
  responseBytes: number;
  open: boolean;
  lastDecision: AppTrafficDecision;
}

export interface AppTrafficContractCase {
  readonly id: string;
  readonly name: string;
  readonly options?: Pick<AppTrafficOptions, 'windowMs' | 'warningBytes' | 'throttleBytes' | 'blockBytes' | 'throttleDelayMs'>;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
}

export interface AppTrafficContractResult {
  readonly id: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>>;
  readonly passed: boolean;
}

export interface AppTrafficContractPortFactory {
  create(options?: AppTrafficContractCase['options']): AppTrafficPort;
  advanceTime(ms: number): void;
}

export const APP_TRAFFIC_CONTRACT_CASES: readonly AppTrafficContractCase[] = [
  {
    id: 'byte-accounting', name: 'sum request and response bytes without recording bodies',
    options: { warningBytes: 10, throttleBytes: 20, blockBytes: 30 },
    input: { appSlug: 'notes', requestBytes: 3, responseBytes: 4 },
    expected: { accepted: true, level: 'normal', usage: { requestBytes: 3, responseBytes: 4, totalBytes: 7 }, ledger: [{ appSlug: 'notes', requestBytes: 3, responseBytes: 4, totalBytes: 7, status: 200 }], ledgerFieldsOnly: true },
  },
  {
    id: 'threshold-order', name: 'warn, throttle, then block as a window accumulates traffic',
    options: { windowMs: 100, warningBytes: 5, throttleBytes: 8, blockBytes: 12, throttleDelayMs: 25 },
    input: { appSlug: 'notes', firstRequestBytes: 5, firstResponseBytes: 2, secondRequestBytes: 1, secondResponseBytes: 4, deniedRequestBytes: 1 },
    expected: { levels: ['warning', 'warning', 'throttled', 'blocked', 'blocked'], secondThrottleDelayMs: 25, blockReason: 'traffic-cap', secondStreamClosed: true, deniedStatus: 429 },
  },
  {
    id: 'window-reset', name: 'reset byte usage when the accounting window expires',
    options: { windowMs: 100, warningBytes: 2, throttleBytes: 4, blockBytes: 6 },
    input: { appSlug: 'notes', firstRequestBytes: 6, advanceMs: 100, secondRequestBytes: 1 },
    expected: { levels: ['blocked', 'normal'], usage: { requestBytes: 1, responseBytes: 0, totalBytes: 1 }, ledgerRows: 2 },
  },
  {
    id: 'admin-kill-switch', name: 'stop active app streams and reject new traffic immediately',
    options: { warningBytes: 100, throttleBytes: 200, blockBytes: 300 },
    input: { appSlug: 'notes', neighborSlug: 'tasks', appRequestBytes: 4, neighborRequestBytes: 2, neighborResponseBytes: 3, afterUnblockBytes: 1 },
    expected: { activeClosed: true, activeReason: 'admin', adminReason: 'admin', adminStatus: 503, neighborAccepted: true, neighborUsageBytes: 5, unblockedAccepted: true, ledger: [{ appSlug: 'notes', requestBytes: 4, responseBytes: 0, totalBytes: 4, status: 503 }, { appSlug: 'notes', requestBytes: 1, responseBytes: 0, totalBytes: 1, status: 503 }, { appSlug: 'tasks', requestBytes: 2, responseBytes: 3, totalBytes: 5, status: 200 }, { appSlug: 'notes', requestBytes: 1, responseBytes: 0, totalBytes: 1, status: 200 }] },
  },
  {
    id: 'app-isolation', name: 'keep counters separate for app slugs with a shared prefix',
    options: { warningBytes: 2, throttleBytes: 4, blockBytes: 5 },
    input: { appSlug: 'notes', similarAppSlug: 'notes-team', firstRequestBytes: 5, secondRequestBytes: 1 },
    expected: { levels: ['blocked', 'normal'], reasons: ['traffic-cap', null], usage: [{ requestBytes: 5, responseBytes: 0, totalBytes: 5 }, { requestBytes: 1, responseBytes: 0, totalBytes: 1 }] },
  },
];

function validAppSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function bytesOrThrow(value: number): number {
  if (!validByteCount(value)) throw new Error('traffic byte count must be a nonnegative safe integer');
  return value;
}

function usageSnapshot(usage: MutableUsage): AppTrafficUsage {
  return {
    windowStartedAt: usage.windowStartedAt,
    requestBytes: usage.requestBytes,
    responseBytes: usage.responseBytes,
    totalBytes: usage.requestBytes + usage.responseBytes,
  };
}

export function createFakeAppTraffic(options: AppTrafficOptions = {}): AppTrafficPort {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const warningBytes = options.warningBytes ?? 5 * 1024 * 1024;
  const throttleBytes = options.throttleBytes ?? 8 * 1024 * 1024;
  const blockBytes = options.blockBytes ?? 10 * 1024 * 1024;
  const throttleDelayMs = options.throttleDelayMs ?? 250;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('traffic window must be positive');
  if (!validByteCount(warningBytes) || !validByteCount(throttleBytes) || !validByteCount(blockBytes)
    || warningBytes > throttleBytes || throttleBytes > blockBytes) throw new Error('traffic thresholds must be ordered nonnegative byte counts');
  if (!Number.isFinite(throttleDelayMs) || throttleDelayMs < 0) throw new Error('traffic throttle delay must be nonnegative');

  const apps = new Map<string, AppState>();
  const entries: AppTrafficLedgerEntry[] = [];

  function stateFor(appSlug: string): AppState {
    if (!validAppSlug(appSlug)) throw new Error(`invalid app slug: ${appSlug}`);
    let state = apps.get(appSlug);
    if (!state) {
      state = { usage: { windowStartedAt: now(), requestBytes: 0, responseBytes: 0 }, adminBlocked: false, streams: new Set() };
      apps.set(appSlug, state);
    }
    return state;
  }

  function refreshWindow(state: AppState): void {
    const current = now();
    if (current < state.usage.windowStartedAt || current - state.usage.windowStartedAt >= windowMs) {
      state.usage = { windowStartedAt: current, requestBytes: 0, responseBytes: 0 };
    }
  }

  function decisionFor(state: AppState): AppTrafficDecision {
    const totalBytes = state.usage.requestBytes + state.usage.responseBytes;
    if (state.adminBlocked) return { accepted: false, level: 'blocked', status: 503, reason: 'admin' };
    if (totalBytes >= blockBytes) return { accepted: false, level: 'blocked', status: 429, reason: 'traffic-cap' };
    if (totalBytes >= throttleBytes) return { accepted: true, level: 'throttled', status: 200, throttleDelayMs };
    if (totalBytes >= warningBytes) return { accepted: true, level: 'warning', status: 200 };
    return { accepted: true, level: 'normal', status: 200 };
  }

  function appendEntry(stream: StreamState, status: number): void {
    entries.push({
      appSlug: stream.appSlug,
      requestBytes: stream.requestBytes,
      responseBytes: stream.responseBytes,
      totalBytes: stream.requestBytes + stream.responseBytes,
      status,
    });
  }

  function closeStream(state: AppState, stream: StreamState, status: number, decision: AppTrafficDecision): void {
    if (!stream.open) return;
    stream.open = false;
    stream.lastDecision = decision;
    state.streams.delete(stream);
    appendEntry(stream, status);
  }

  function addBytes(state: AppState, stream: StreamState, field: 'requestBytes' | 'responseBytes', value: number): AppTrafficDecision {
    const bytes = bytesOrThrow(value);
    if (!stream.open) return stream.lastDecision;
    refreshWindow(state);
    state.usage[field] += bytes;
    stream[field] += bytes;
    const decision = decisionFor(state);
    stream.lastDecision = decision;
    if (!decision.accepted) closeStream(state, stream, decision.status, decision);
    return decision;
  }

  function beginRequest(appSlug: string, requestBytes = 0): AppTrafficRequest {
    const state = stateFor(appSlug);
    const bytes = bytesOrThrow(requestBytes);
    refreshWindow(state);
    state.usage.requestBytes += bytes;
    const decision = decisionFor(state);
    if (!decision.accepted) {
      appendEntry({ appSlug, requestBytes: bytes, responseBytes: 0, open: false, lastDecision: decision }, decision.status);
      return { decision };
    }
    const stream: StreamState = { appSlug, requestBytes: bytes, responseBytes: 0, open: true, lastDecision: decision };
    state.streams.add(stream);
    return {
      decision,
      stream: {
        get isOpen() { return stream.open; },
        get reason() { return stream.lastDecision.reason; },
        addRequestBytes(value) { return addBytes(state, stream, 'requestBytes', value); },
        addResponseBytes(value) { return addBytes(state, stream, 'responseBytes', value); },
        finish(status = 200) {
          if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('traffic status must be an HTTP status code');
          closeStream(state, stream, status, stream.lastDecision);
        },
      },
    };
  }

  return {
    beginRequest,
    adminBlock(appSlug) {
      const state = stateFor(appSlug);
      state.adminBlocked = true;
      const decision = decisionFor(state);
      for (const stream of [...state.streams]) closeStream(state, stream, 503, decision);
    },
    adminUnblock(appSlug) { stateFor(appSlug).adminBlocked = false; },
    usage(appSlug) {
      const state = stateFor(appSlug);
      refreshWindow(state);
      return usageSnapshot(state.usage);
    },
    ledger() { return entries.map((entry) => ({ ...entry })); },
  };
}

export function runAppTrafficContractCase(contract: AppTrafficContractCase, factory: AppTrafficContractPortFactory): AppTrafficContractResult {
  const port = factory.create(contract.options);
  let actual: Readonly<Record<string, unknown>>;
  switch (contract.id) {
    case 'byte-accounting': {
      const input = contract.input as { appSlug: string; requestBytes: number; responseBytes: number; marker: string };
      const request = port.beginRequest(input.appSlug, input.requestBytes);
      request.stream!.addResponseBytes(input.responseBytes);
      request.stream!.finish(200);
      const ledger = port.ledger();
      actual = { accepted: request.decision.accepted, level: request.decision.level, usage: port.usage(input.appSlug), ledger, ledgerFieldsOnly: ledger.every((entry) => Object.keys(entry).every((key) => ['appSlug', 'requestBytes', 'responseBytes', 'totalBytes', 'status'].includes(key))) };
      const { windowStartedAt: _windowStartedAt, ...usage } = port.usage(input.appSlug);
      actual = { ...actual, usage };
      break;
    }
    case 'threshold-order': {
      const input = contract.input as { appSlug: string; firstRequestBytes: number; firstResponseBytes: number; secondRequestBytes: number; secondResponseBytes: number; deniedRequestBytes: number };
      const first = port.beginRequest(input.appSlug, input.firstRequestBytes);
      const firstResponse = first.stream!.addResponseBytes(input.firstResponseBytes);
      first.stream?.finish();
      const second = port.beginRequest(input.appSlug, input.secondRequestBytes);
      const secondResponse = second.stream!.addResponseBytes(input.secondResponseBytes);
      const denied = port.beginRequest(input.appSlug, input.deniedRequestBytes);
      actual = {
        levels: [first.decision.level, firstResponse.level, second.decision.level, secondResponse.level, denied.decision.level],
        secondThrottleDelayMs: second.decision.throttleDelayMs,
        blockReason: secondResponse.reason,
        secondStreamClosed: second.stream!.isOpen === false,
        deniedStatus: denied.decision.status,
      };
      break;
    }
    case 'window-reset': {
      const input = contract.input as { appSlug: string; firstRequestBytes: number; advanceMs: number; secondRequestBytes: number };
      const first = port.beginRequest(input.appSlug, input.firstRequestBytes);
      first.stream?.finish();
      factory.advanceTime(input.advanceMs);
      const second = port.beginRequest(input.appSlug, input.secondRequestBytes);
      second.stream!.finish();
      const { windowStartedAt: _windowStartedAt, ...usage } = port.usage(input.appSlug);
      actual = { levels: [first.decision.level, second.decision.level], usage, ledgerRows: port.ledger().length };
      break;
    }
    case 'admin-kill-switch': {
      const input = contract.input as { appSlug: string; neighborSlug: string; appRequestBytes: number; neighborRequestBytes: number; neighborResponseBytes: number; afterUnblockBytes: number };
      const active = port.beginRequest(input.appSlug, input.appRequestBytes);
      const neighbor = port.beginRequest(input.neighborSlug, input.neighborRequestBytes);
      port.adminBlock(input.appSlug);
      const denied = port.beginRequest(input.appSlug, 1);
      neighbor.stream!.addResponseBytes(input.neighborResponseBytes);
      neighbor.stream!.finish(200);
      port.adminUnblock(input.appSlug);
      const afterUnblock = port.beginRequest(input.appSlug, input.afterUnblockBytes);
      afterUnblock.stream!.finish(200);
      actual = {
        activeClosed: active.stream!.isOpen === false,
        activeReason: active.stream!.reason,
        adminReason: denied.decision.reason,
        adminStatus: denied.decision.status,
        neighborAccepted: neighbor.decision.accepted,
        neighborUsageBytes: port.usage(input.neighborSlug).totalBytes,
        unblockedAccepted: afterUnblock.decision.accepted,
        ledger: port.ledger(),
      };
      break;
    }
    case 'app-isolation': {
      const input = contract.input as { appSlug: string; similarAppSlug: string; firstRequestBytes: number; secondRequestBytes: number };
      const first = port.beginRequest(input.appSlug, input.firstRequestBytes);
      const second = port.beginRequest(input.similarAppSlug, input.secondRequestBytes);
      second.stream!.finish();
      const { windowStartedAt: _firstStartedAt, ...firstUsage } = port.usage(input.appSlug);
      const { windowStartedAt: _secondStartedAt, ...secondUsage } = port.usage(input.similarAppSlug);
      actual = { levels: [first.decision.level, second.decision.level], reasons: [first.decision.reason ?? null, second.decision.reason ?? null], usage: [firstUsage, secondUsage] };
      break;
    }
    default: throw new Error(`unknown app traffic contract: ${contract.id}`);
  }
  const passed = contractValuesEqual(actual, contract.expected);
  return { id: contract.id, expected: contract.expected, actual, passed };
}

function contractValuesEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      const actualHasIndex = Object.prototype.hasOwnProperty.call(actual, index);
      const expectedHasIndex = Object.prototype.hasOwnProperty.call(expected, index);
      if (actualHasIndex !== expectedHasIndex) return false;
      if (actualHasIndex && !contractValuesEqual(actual[index], expected[index])) return false;
    }
    return true;
  }
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = Object.keys(expectedRecord).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && contractValuesEqual(actualRecord[key], expectedRecord[key]));
}

export function runAppTrafficContractMatrix(factory: AppTrafficContractPortFactory): AppTrafficContractResult[] {
  return APP_TRAFFIC_CONTRACT_CASES.map((contract) => runAppTrafficContractCase(contract, factory));
}
