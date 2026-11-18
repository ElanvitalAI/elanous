import { expect, test } from 'bun:test';
import { clearSessionProvider, parseSessionProvider, setSessionProvider } from '../../tui-client/session-provider.js';
import { readNextTuiStatusModel, resolveNextTuiSelection } from '../chat/status-model.js';
import { runNextTuiStatusBranchRoute } from './status.js';

test('/status shows the same session provider/model as the status bar (TUI-MODEL-DISPLAY-CONSISTENT)', async () => {
  const sessionId = 'model-display-consistent-session';
  try {
    setSessionProvider(sessionId, parseSessionProvider('glm', 'glm-5'));
    const lines: string[] = [];
    await runNextTuiStatusBranchRoute('/status', { addLines: (...next: string[]) => { lines.push(...next); }, sessionId } as never);
    expect(readNextTuiStatusModel(sessionId)).toBe('glm/glm-5');
    expect(resolveNextTuiSelection(sessionId)).toEqual({ provider: 'glm', model: 'glm-5' });
    expect(lines).toContain('Model: glm / glm-5');
  } finally { clearSessionProvider(sessionId); }
});

test('/status 연결 설정 judges the selected provider\'s own credential, not the global decision', async () => {
  const sessionId = 'status-connection-selected-session';
  const key = 'OPENROUTER_API_KEY';
  const previous = process.env[key];
  const lines = async (): Promise<string[]> => {
    const out: string[] = [];
    await runNextTuiStatusBranchRoute('/status', { addLines: (...next: string[]) => { out.push(...next); }, sessionId } as never);
    return out;
  };
  try {
    setSessionProvider(sessionId, parseSessionProvider('openrouter', 'openrouter/z-ai/glm-5.3'));
    process.env[key] = 'sk-or-v1-testkeytestkeytestkey';
    const withKey = await lines();
    expect(withKey.some((line) => line.startsWith('Connection: API key configured'))).toBe(true);
    expect(withKey.join('\n')).not.toContain('sk-or-v1');
    delete process.env[key];
    // No resolvable key for that provider: stay honest (a stored key on this machine would also be «설정됨»).
    const without = await lines();
    expect(without.some((line) => line.startsWith('Connection:'))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    clearSessionProvider(sessionId);
  }
});
