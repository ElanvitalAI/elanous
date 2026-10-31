import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sanitizeForPtyInput } from '../agent-mission/provision.js';

export interface VisibleMissionPty {
  snapshot(): string;
  write(bytes: string): void;
  isAlive(): boolean;
}

export interface VisibleMissionResult {
  ok: boolean;
  path: string;
  content?: string;
  firstLine?: string;
  promptReady: boolean;
  missionVisible: boolean;
  promptReturned: boolean;
  completionMarker: boolean;
  /** Bounded first PTY frame, retained to diagnose startup screens that intercepted input. */
  initialScreen?: string;
  startupScreen?: AgentStartupScreen;
  error?: string;
}

export type VisibleAgentCli = 'codex' | 'claude';
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
  let promptReturned = false;
  let completionMarker = false;
  let initialScreen: string | undefined;
  let startupScreen: AgentStartupScreen | undefined;
  let codexUpdateSkipSent = false;
  let startupScreenReported = false;
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
  const readyDeadline = Date.now() + (deps.readyTimeoutMs ?? 60_000);
  let lastScreen = '';

  while (Date.now() < readyDeadline) {
    if (!deps.pty.isAlive()) {
      // The process may exit before the first poll; its final frame can still
      // identify the startup screen that prevented the prompt from appearing.
      try {
        lastScreen = deps.pty.snapshot();
        initialScreen ??= lastScreen.slice(-1_200);
        observeStartupScreen(lastScreen);
      } catch { /* an exited remote PTY may no longer expose its final frame */ }
      return { ok: false, path: deps.outputPath, promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false, ...(initialScreen ? { initialScreen } : {}), ...(startupScreen ? { startupScreen } : {}), error: 'Agent PTY exited before its prompt appeared' };
    }
    lastScreen = deps.pty.snapshot();
    initialScreen ??= lastScreen.slice(-1_200);
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
    return {
      ok: false, path: deps.outputPath, promptReady: false, missionVisible: false, promptReturned: false, completionMarker: false,
      initialScreen,
      ...(startupScreen ? { startupScreen } : {}),
      error: 'Agent input prompt was not observed before the startup timeout',
    };
  }

  const mission = sanitizeForPtyInput(deps.mission, 4_000);
  if (!mission) return { ok: false, path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Mission text is empty after input sanitization' };
  try {
    readFile(deps.outputPath);
    return { ok: false, path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Result path already exists; refusing to reuse a previous mission file' };
  } catch (error) {
    if (!isFileNotFound(error)) {
      return { ok: false, path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: `Could not verify a fresh result path: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const missionPrompt = `Write the result to the exact file path ${deps.outputPath} (create parent directories if needed). ${mission}`;
  deps.pty.write(missionPrompt);
  const visibleMissionTail = mission.slice(-Math.min(24, mission.length));
  const visibilityDeadline = Date.now() + (deps.visibilityTimeoutMs ?? 5_000);
  while (Date.now() < visibilityDeadline) {
    const visibleText = normalizeVisibleText(deps.pty.snapshot());
    if (visibleText.includes(normalizeVisibleText(visibleMissionTail))) { missionVisible = true; break; }
    await sleep(Math.min(pollMs || 25, Math.max(1, visibilityDeadline - Date.now())));
  }
  if (!missionVisible) {
    return { ok: false, path: deps.outputPath, promptReady, missionVisible: false, promptReturned: false, completionMarker: false, initialScreen, ...(startupScreen ? { startupScreen } : {}), error: 'Mission text was not visible in the agent PTY before submission' };
  }
  deps.pty.write('\r');

  const completionDeadline = Date.now() + (deps.completionTimeoutMs ?? 300_000);
  let resultFileObserved = false;
  while (Date.now() < completionDeadline) {
    if (!deps.pty.isAlive()) break;
    lastScreen = deps.pty.snapshot();
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
    return { ok: false, path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not create a non-empty result file before the timeout' };
  }
  if (!promptReturned) {
    return { ok: false, path: deps.outputPath, promptReady, missionVisible, promptReturned: false, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not return to its input prompt after writing the result file' };
  }

  let content: string;
  try { content = readFile(deps.outputPath); }
  catch (error) {
    return { ok: false, path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: `Result file disappeared after the agent returned: ${error instanceof Error ? error.message : String(error)}` };
  }
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine) return { ok: false, path: deps.outputPath, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Result file is empty' };

  // Keep the marker request separate and short: the marker itself never occurs
  // in the mission prompt, so only the agent's final output can satisfy it.
  const completionMarkerText = `M-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const completionMarkerPath = `${deps.outputPath}.completion-${completionMarkerText}`;
  const markerPrompt = `Say ${completionMarkerText} alone and write it to the exact file path ${completionMarkerPath}.`;
  deps.pty.write(markerPrompt);
  const markerVisibleDeadline = Date.now() + (deps.visibilityTimeoutMs ?? 5_000);
  let markerRequestVisible = false;
  while (Date.now() < markerVisibleDeadline) {
    const markerInputScreen = stripAnsi(deps.pty.snapshot()).replace(/\s+/g, ' ');
    if (markerInputScreen.includes(completionMarkerText)) { markerRequestVisible = true; break; }
    await sleep(Math.min(pollMs || 25, Math.max(1, markerVisibleDeadline - Date.now())));
  }
  if (!markerRequestVisible) {
    return { ok: false, path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker request was not visible in the agent PTY' };
  }
  if (screenShowsCompletionMarker(deps.pty.snapshot(), completionMarkerText)) {
    return { ok: false, path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Completion marker appeared in the PTY input before submission' };
  }
  deps.pty.write('\r');

  while (Date.now() < completionDeadline) {
    try {
      if (readFile(completionMarkerPath).trim() === completionMarkerText) { completionMarker = true; break; }
    } catch { /* the agent has not written the completion marker file yet */ }
    if (!deps.pty.isAlive()) break;
    try {
      if (screenShowsCompletionMarker(deps.pty.snapshot(), completionMarkerText)) { completionMarker = true; break; }
    } catch { /* detached PTYs may no longer expose a screen snapshot */ }
    await sleep(pollMs);
  }
  if (!completionMarker) {
    return { ok: false, path: deps.outputPath, firstLine, promptReady, missionVisible, promptReturned, completionMarker: false, ...(startupScreen ? { startupScreen } : {}), error: 'Agent did not show its completion marker before the timeout' };
  }
  return { ok: true, path: deps.outputPath, content, firstLine, promptReady, missionVisible, promptReturned, completionMarker, initialScreen, ...(startupScreen ? { startupScreen } : {}) };
  } catch (error) {
    return {
      ok: false,
      path: deps.outputPath,
      promptReady,
      missionVisible,
      promptReturned,
      completionMarker,
      ...(initialScreen ? { initialScreen } : {}),
      ...(startupScreen ? { startupScreen } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function screenShowsCompletionMarker(screen: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*(?:(?:[•⏺└│╰⎿])\\s*)?${escaped}\\s*$`, 'm').test(stripAnsi(screen));
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
