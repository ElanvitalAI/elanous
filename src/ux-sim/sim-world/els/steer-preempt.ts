import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskNotificationQueue } from '../../../agent/task-notification.js';
import { streamLLMWithTools, type LLMProvider } from '../../../llm.js';
import { createNextTuiSteerInbox } from '../../../repl/next-tui-steer.js';
import { clearPendingUserInput, drainPendingUserInput } from '../../../session/pending-input.js';
import { installShellCapsuleSink, runShellCapsule } from '../../../turn-capsule/shell-capsule.js';
import type { CapsuleEvent } from '../../../turn-capsule/contract.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

interface BusyShellDevice { readonly sessionId: string; readonly decision: string }
export const simWorldDevices: readonly SimWorldDeviceDef<BusyShellDevice>[] = [{
  id: 'els-busy-shell-decision', title: 'long RunShell, authenticated decision steer, and blocked provider event injector',
  create: () => ({ sessionId: `sim-els-urgent-${Date.now()}`, decision: 'OP decision: stop the old plan and report' }),
}];

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'E-SEAT-STEER-BUSY-SHELL',
  title: 'OP decision enters a busy seat before the long RunShell finishes',
  devices: ['els-busy-shell-decision'],
  async run(ctx) {
    const device = ctx.device<BusyShellDevice>('els-busy-shell-decision');
    const root = mkdtempSync(join(tmpdir(), 'sim-els-steer-'));
    const queue = new TaskNotificationQueue(root);
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink(device.sessionId, (frame) => frames.push(frame));
    const applied: string[] = [];
    const inbox = createNextTuiSteerInbox(device.sessionId, (ids) => applied.push(...ids));
    const requests: string[] = [];
    let finishShell: ((value: string) => void) | undefined;
    let shellFinished = false;
    const provider: LLMProvider = {
      name: 'sim-els-steer', defaultModel: 'sim-els-steer', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) {
        requests.push(JSON.stringify(messages));
        if (requests.length === 1) yield { type: 'tool_call', id: 'long-shell', name: 'RunShell', args: {} };
        else yield { type: 'text', delta: 'decision applied' };
      },
    };
    try {
      const started = Date.now();
      const answer = await streamLLMWithTools([{ role: 'user', content: 'old work' }], {
        onText() {},
        dispatchTool: () => runShellCapsule({
          tool: 'RunShell', command: 'sleep 120', clockFromSpawn: true,
          start: (_signal, spawned) => {
            spawned();
            const held = new Promise<string>((resolve) => { finishShell = (value) => { shellFinished = true; resolve(value); }; });
            queueMicrotask(() => inbox.push('op-decision-1', device.decision, true));
            return held;
          },
          describe: (value) => ({ status: 'ok', output: value }), started: (id) => `capsule started ${id}`,
        }, { policy: { decide: () => ({ mode: 'sync', syncCapMs: Infinity, reason: 'ordinary-no-cap' }) }, queue, log: () => {} }),
      }, { provider, model: provider.defaultModel, sessionId: device.sessionId, maxTurns: 2,
        tools: [{ name: 'RunShell', description: 'long fake shell', parameters: { type: 'object' } }],
        drainPendingUserInput: () => drainPendingUserInput(device.sessionId) });
      const latencyMs = Date.now() - started;
      const enteredBeforeFinish = requests.length === 2 && requests[1]!.includes(device.decision) && !shellFinished;
      finishShell?.('finished later');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const passed = answer === 'decision applied' && enteredBeforeFinish && latencyMs < 30_000
        && applied.length === 1 && frames.filter((frame) => frame.type === 'capsule-progress').length === 1
        && frames.filter((frame) => frame.type === 'capsule-done').length === 1 && queue.drain().length === 1;
      ctx.recorder.event('busy-shell-decision-preempt', { passed, latencyMs, enteredBeforeFinish,
        requests: requests.length, applied: applied.length, frames: frames.map((frame) => frame.type), shellFinished });
      return passed ? { ok: true } : { ok: false, diff: 'decision did not preempt the busy shell and enter one request' };
    } finally {
      inbox.finish();
      sink.dispose();
      clearPendingUserInput(device.sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  },
}];
