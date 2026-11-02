import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sanitizeForPtyInput } from '../agent-mission/provision.js';

export interface VisibleMissionPty {
  snapshot(): string;
  /** A false result means the PTY input handle rejected the write. */
  write(bytes: string): boolean | number | void;
  isAlive(): boolean;
  /** Child process exit status once the PTY has stopped. Undefined while it is still running. */
  exitCode?(): number | null;
}

export interface VisibleMissionResult {
  ok: boolean;
  path: string;
  content?: string;
  firstLine?: string;
  promptReady: boolean;
  missionVisible: boolean;
  /** Every UTF-8 byte in the mission prompt was accepted by the PTY input handle. */
  missionTyped?: boolean;
  /** Enter was accepted only after the complete mission became visible. */
  missionSubmitted?: boolean;
  /** Child PTY exit status recorded after the mission was submitted, or when it died earlier. */
  exitCode?: number | null;
  promptReturned: boolean;
  completionMarker: boolean;
  /** Bounded first PTY frame, retained to diagnose startup screens that intercepted input. */
  initialScreen?: string;
  startupScreen?: AgentStartupScreen;
  failureStage?: 'prompt-readiness' | 'mission-write' | 'mission-visibility' | 'mission-submit' | 'mission-completion' | 'result-read' | 'marker-write' | 'marker-visibility' | 'marker-submit' | 'marker-completion' | 'pty-error';
  failureScreen?: string;
  error?: string;
}

export type VisibleAgentCli = 'codex' | 'claude' | 'grok';
export type AgentStartupScreen = 'codex-update-choice' | 'claude-update-choice' | 'claude-login' | 'claude-workspace-trust';

export interface VisibleMissionDeps {
  pty: VisibleMissionPty;
  agent?: VisibleAgentCli;
  mission: string;
  outputPath: string;
  handleTrust(screen: string, write: (bytes: string) => void): boolean;
  onStartupScreen?(screen: AgentStartupScreen): void;
  readFile?(path: string): string;
  sleep?(ms: number): Promise<void>;
  readyTimeoutMs?: number;
  visibilityTimeoutMs?: number;
  completionTimeoutMs?: number;
  pollMs?: number;
}

const sleepDefault = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const INPUT_CHUNK_BYTES = 256;
const INPUT_CHUNK_DELAY_MS = 10;

async function writeMissionInput(text: string, pty: VisibleMissionPty, sleep: (ms: number) => Promise<void>): Promise<{ complete: boolean; acceptedBytes: number; totalBytes: number }> {
  let chunk = '';
  let chunkBytes = 0;
  let acceptedBytes = 0;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (chunk && chunkBytes + charBytes > INPUT_CHUNK_BYTES) {
      if (pty.write(chunk) === false) return { complete: false, acceptedBytes, totalBytes };
      acceptedBytes += chunkBytes;
      await sleep(INPUT_CHUNK_DELAY_MS);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += charBytes;
  }
  if (chunk && pty.write(chunk) === false) return { complete: false, acceptedBytes, totalBytes };
  acceptedBytes += chunkBytes;
  return { complete: true, acceptedBytes, totalBytes };
}

export function isAgentInputPrompt(screen: string): boolean {
  const plain = stripAnsi(screen);
  return /(?:^|\n)\s*(?:│\s*)?[›❯](?:\s*(?:Ask\b|Try\b|$)|\s*│)/m.test(plain)
    || /Ask anything|Ask (?:Codex|Claude)(?: Code)? to do anything|What would you like to do\?/i.test(plain);
}

/** Classify only known startup blockers; never copy arbitrary PTY contents into logs. */
export function classifyAgentStartupScreen(agent: VisibleAgentCli | undefined, screen: string): AgentStartupScreen | undefined {
  const plain = stripAnsi(screen);
  if (agent === 'codex' && /update available/i.test(plain) && /\besc(?:ape)?\s+(?:to\s+)?skip\b/i.test(plain)) return 'codex-update-choice';
  if (agent === 'claude' && /update available/i.test(plain)) return 'claude-update-choice';
  if (agent === 'claude' && /(?:sign in|log in|login|authentication required|claude\.ai\/login)/i.test(plain)) return 'claude-login';
  if (agent === 'claude' && /(?:Yes, I trust this folder|Quick safety check|Accessing workspace)/i.test(plain)) return 'claude-workspace-trust';
  return undefined;
}

/** Drive a visible agent PTY, verify its result, then request a separate completion marker. */
export async function runVisibleAgentMission(deps: VisibleMissionDeps): Promise<VisibleMissionResult> {
  const sleep = deps.sleep ?? sleepDefault;
  const pollMs = deps.pollMs ?? 150;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  let promptReady = false;
  let missionVisible = false;
  let missionTyped = false;
  let missionSubmitted = false;
  let promptReturned = false;
  let completionMarker = false;
  let initialScreen: string | undefined;
  let startupScreen: AgentStartupScreen | undefined;
  let codexUpdateSkipSent = false;
  let startupScreenReported = false;
  let lastObservedScreen = '';
  let exitCode: number | null | undefined;
  const completionDeadline = Date.now() + (deps.completionTimeoutMs ?? 300_000);
  const stageDeadline = (timeoutMs: number): number => Math.min(completionDeadline, Date.now() + timeoutMs);
  const snapshot = (): string => { lastObservedScreen = deps.pty.snapshot(); return lastObservedScreen; };
  const safeSnapshot = (): string => { try { return snapshot(); } catch { return lastObservedScreen; } };
  const recordExit = (): number | null | undefined => {
    try {
      const code = deps.pty.exitCode?.();
      if (code !== undefined && code !== null) exitCode = code;
      else if (exitCode === undefined && code !== undefined) exitCode = code;
    } catch { /* a detached PTY may no longer expose its exit status */ }
    return exitCode;
  };
  const failure = (result: Omit<VisibleMissionResult, 'ok' | 'failureStage' | 'failureScreen'>, stage: NonNullable<VisibleMissionResult['failureStage']>, screen = safeSnapshot()): VisibleMissionResult => ({
    ...result, missionTyped, missionSubmitted, ...(recordExit() !== undefined ? { exitCode: recordExit() } : {}), ok: false, failureStage: stage, failureScreen: screenTail(screen),
  });
  const observeStartupScreen = (screen: string): AgentStartupScreen | undefined => {
    const detected = classifyAgentStartupScreen(deps.agent, screen);
    // This field describes the blocker present in the current/final frame,
    // not a startup dialog that has already been dismissed.
    startupScreen = detected;
    if (detected) {
      if (!startupScreenReported) {
        startupScreenReported = true;
        deps.onStartupScreen?.(detected);
      }
    }
    return detected;
  };
  try {
  // Readiness is settled by the observed prompt/input echo; this is only one
  // shared safety cap, not a per-stage 60s/5s guess.
  const safetyCapMs = deps.completionTimeoutMs ?? 300_000;
  const readyDeadline = stageDeadline(deps.readyTimeoutMs ?? safetyCapMs);
  let lastScreen = '';

  while (Date.now() < readyDeadline) {
    if (!deps.pty.isAlive()) {
      // The process may exit before the first poll; its final frame can still
      // identify the startup screen that prevented the prompt from appearing.
      recordExit();
      try {
        lastScreen = snapshot();
        initialScreen ??= redactSensitive(stripAnsi(lastScreen)).slice(-1_200);
        observeStartupScreen(lastScreen);
      } catch { /* an exited remote PTY may no longer expose its final frame */ }
      return failure({ path: deps.outputPath, promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, ...(initialScreen ? { initialScreen } : {}), ...(startupScreen ? { startupScreen } : {}), error: 'Agent PTY exited before its prompt appeared' }, 'prompt-readiness', lastScreen);
    }
    lastScreen = snapshot();
    initialScreen ??= redactSensitive(stripAnsi(lastScreen)).slice(-1_200);
    const detectedScreen = observeStartupScreen(lastScreen);
    if (detectedScreen) {
      if (detectedScreen === 'codex-update-choice') {
        if (!codexUpdateSkipSent) {
          codexUpdateSkipSent = true;
          deps.pty.write('\u001b');
        }
        // Codex may retain its dismissed update banner beside the live
        // composer. Once Escape was sent, let the prompt check win in that
        // frame instead of waiting forever for the banner to disappear.
        if (!isAgentInputPrompt(lastScreen)) {
          await sleep(500);
          continue;
        }
      }
    }
    // Backend handlers recognize their own narrow auth/trust prompts; gating
    // readiness on workspace-trust text leaves other first-run screens stuck.
    if (detectedScreen !== 'codex-update-choice' && deps.handleTrust(lastScreen, bytes => deps.pty.write(bytes))) {
      await sleep(500);
      continue;
    }
    if (isAgentInputPrompt(lastScreen)) { promptReady = true; break; }
    await sleep(pollMs);
  }
  if (!promptReady) {
    return failure({
      path: deps.outputPath, promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false,
      initialScreen,
      ...(startupScreen ? { startupScreen } : {}),
      error: 'Agent input prompt was not observed before the startup safety cap',
    }, 'prompt-readiness', lastScreen);
  }

  const mission = sanitizeForPtyInput(deps.mission, 4_000);
  if (!mission) return failure({ path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Mission text is empty after input sanitization' }, 'mission-write');
  try {
    readFile(deps.outputPath);
    return failure({ path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Result path already exists; refusing to reuse a previous mission file' }, 'result-read');
  } catch (error) {
    if (!isFileNotFound(error)) {
      return failure({ path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: `Could not verify a fresh result path: ${error instanceof Error ? error.message : String(error)}` }, 'result-read');
    }
  }
  const missionPrompt = `Write the result to the exact file path ${deps.outputPath} (create parent directories if needed). ${mission}`;
  const missionWrite = await writeMissionInput(missionPrompt, deps.pty, sleep);
  missionTyped = missionWrite.complete;
  if (!missionTyped) {
    return failure({ path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, initialScreen, ...(startupScreen ? { startupScreen } : {}), error: `Mission input write was rejected after ${missionWrite.acceptedBytes}/${missionWrite.totalBytes} UTF-8 bytes` }, 'mission-write');
  }
  const visibleMissionTail = Array.from(mission).slice(-24).join('');
  const visibilityDeadline = stageDeadline(deps.visibilityTimeoutMs ?? safetyCapMs);
  while (Date.now() < visibilityDeadline) {
    if (!deps.pty.isAlive()) recordExit();
    const visibleText = normalizeVisibleText(snapshot());
    if (visibleText.includes(normalizeVisibleText(visibleMissionTail))) { missionVisible = true; break; }
    if (!deps.pty.isAlive()) break;
    await sleep(Math.min(pollMs || 25, Math.max(1, visibilityDeadline - Date.now())));
  }
  if (!missionVisible) {
    return failure({ path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, initialScreen, ...(startupScreen ? { startupScreen } : {}), error: 'Mission text was not visible in the agent PTY before submission' }, 'mission-visibility');
  }
  if (deps.pty.write('\r') === false) {
    return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned: false, completionMarker: false, initialScreen, ...(startupScreen ? { startupScreen } : {}), error: 'Mission submit key was rejected by the agent PTY' }, 'mission-submit');
  }
  missionSubmitted = true;

  let resultFileObserved = false;
  while (Date.now() < completionDeadline) {
    if (!deps.pty.isAlive()) { recordExit(); break; }
    lastScreen = snapshot();
    if (deps.handleTrust(lastScreen, bytes => deps.pty.write(bytes))) {
      await sleep(500);
      continue;
    }
    if (!resultFileObserved) {
      try {
        const candidate = readFile(deps.outputPath);
        resultFileObserved = Boolean(candidate.trim());
      } catch { /* the agent has not written the result file yet */ }
    }
    if (resultFileObserved && isAgentInputPrompt(lastScreen)) { promptReturned = true; break; }
    await sleep(pollMs);
  }
  if (!resultFileObserved) {
    return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not create a non-empty result file before the timeout' }, 'mission-completion', lastScreen);
  }
  if (!promptReturned) {
    return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not return to its input prompt after writing the result file' }, 'mission-completion', lastScreen);
  }

  let content: string;
  try { content = readFile(deps.outputPath); }
  catch (error) {
    return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: `Result file disappeared after the agent returned: ${error instanceof Error ? error.message : String(error)}` }, 'result-read', safeSnapshot());
  }
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Result file is empty' }, 'result-read');

  // Keep the marker request separate and short: the marker itself never occurs
  // in the mission prompt, so only the agent's final output can satisfy it.
  const completionMarkerText = `M-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const completionMarkerPath = `${deps.outputPath}.completion-${completionMarkerText}`;
  const markerPrompt = `Say ${completionMarkerText} alone and write it to the exact file path ${completionMarkerPath}.`;
  if (deps.pty.write(markerPrompt) === false) {
    return failure({ path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker input write was rejected by the agent PTY' }, 'marker-write');
  }
  const markerVisibleDeadline = stageDeadline(deps.visibilityTimeoutMs ?? safetyCapMs);
  let markerRequestVisible = false;
  while (Date.now() < markerVisibleDeadline) {
    const markerInputScreen = stripAnsi(snapshot()).replace(/\s+/g, ' ');
    if (markerInputScreen.includes(completionMarkerText)) { markerRequestVisible = true; break; }
    await sleep(Math.min(pollMs || 25, Math.max(1, markerVisibleDeadline - Date.now())));
  }
  if (!markerRequestVisible) {
    return failure({ path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker request was not visible in the agent PTY' }, 'marker-visibility');
  }
  if (screenShowsCompletionMarker(snapshot(), completionMarkerText)) {
    return failure({ path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker appeared in the PTY input before submission' }, 'marker-submit');
  }
  if (deps.pty.write('\r') === false) {
    return failure({ path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker submit key was rejected by the agent PTY' }, 'marker-submit');
  }

  while (Date.now() < completionDeadline) {
    try {
      if (readFile(completionMarkerPath).trim() === completionMarkerText) { completionMarker = true; break; }
    } catch { /* the agent has not written the completion marker file yet */ }
    if (!deps.pty.isAlive()) { recordExit(); break; }
    try {
      if (screenShowsCompletionMarker(snapshot(), completionMarkerText)) { completionMarker = true; break; }
    } catch { /* detached PTYs may no longer expose a screen snapshot */ }
    await sleep(pollMs);
  }
  if (!completionMarker) {
    return failure({ path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not show its completion marker before the timeout' }, 'marker-completion');
  }
  recordExit();
  return { ok: true, path: deps.outputPath, content, firstLine, promptReady, missionVisible, missionTyped, missionSubmitted, ...(exitCode !== undefined ? { exitCode } : {}), promptReturned, completionMarker, initialScreen, ...(startupScreen ? { startupScreen } : {}) };
  } catch (error) {
    return failure({ path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker, ...(initialScreen ? { initialScreen } : {}), ...(startupScreen ? { startupScreen } : {}), error: error instanceof Error ? error.message : String(error) }, 'pty-error');
  }
}

function screenShowsCompletionMarker(screen: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:(?:[•⏺└│╰⎿])\\s*)?${escaped}\\s*$`, 'm').test(stripAnsi(screen));
}

function screenTail(screen: string): string {
  return redactSensitive(stripAnsi(screen)).slice(-1_200);
}

function redactSensitive(screen: string): string {
  return screen
    .replace(/(authorization\s*:\s*(?:basic|bearer|token|apikey|api[- ]key)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi, '$1[redacted]')
    .replace(/((?:[A-Z0-9_]*(?:api[_-]?key|api[_-]?token|access[_-]?key|secret|password|credential|auth[_-]?token|refresh[_-]?token)))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi, '$1=[redacted credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk|xai|gsk|gh[pousr])[-_][A-Za-z0-9_-]{8,}/g, '[redacted credential]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/(account[-_ ]+token)\s*[:=]?\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[redacted credential]');
}

function stripAnsi(screen: string): string {
  return screen.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizeVisibleText(screen: string): string {
  return stripAnsi(screen).replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
