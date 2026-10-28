// Tests for the experiment/voice-chat-realtime-rebind helpers
// (Ctrl+Shift+R toggle path). Verifies:
//   - toggleVoiceChatRealtime enters when controller is idle
//   - toggleVoiceChatRealtime exits when controller is active
//   - mutex with D5 base voice mode (Ctrl+Shift+V) returns 'mutex'
//     status without state change
//   - failed startListening returns a 'exit' action with status hint

import { describe, it, expect } from 'bun:test';
import { toggleVoiceChatRealtime } from '../src/dashboard/voice-chat/voice-chat-host-boot.js';
import type { BootDashboardVoiceChatResult } from '../src/dashboard/voice-chat/voice-chat-host-boot.js';

interface FakeController {
  active: boolean;
  exitCalls: Array<string | undefined>;
  isActive(): boolean;
  exit(reason?: string): void;
  getPhase(): string;
}

function makeFakeController(active = false): FakeController {
  return {
    active,
    exitCalls: [],
    isActive() { return this.active; },
    exit(reason) { this.exitCalls.push(reason); this.active = false; },
    getPhase() { return this.active ? 'listening' : 'inactive'; },
  };
}

interface FakePipeline {
  startCalls: number;
  cancelCalls: number;
  shouldFail: boolean;
  startListening(): Promise<boolean>;
  cancel(): Promise<void>;
}

function makeFakePipeline(opts: { shouldFail?: boolean } = {}): FakePipeline {
  return {
    startCalls: 0,
    cancelCalls: 0,
    shouldFail: opts.shouldFail ?? false,
    async startListening() {
      this.startCalls += 1;
      return !this.shouldFail;
    },
    async cancel() { this.cancelCalls += 1; },
  };
}

function makeVchat(controller: FakeController, pipeline: FakePipeline): BootDashboardVoiceChatResult {
  return {
    controller: controller as unknown as BootDashboardVoiceChatResult['controller'],
    pipeline: pipeline as unknown as BootDashboardVoiceChatResult['pipeline'],
    providerId: 'openai-realtime-stt',
    handleEsc: async () => {},
    notifyResponseDone: () => {},
    requestEnter: () => {},
  } as unknown as BootDashboardVoiceChatResult;
}

describe('toggleVoiceChatRealtime', () => {
  it("enters listening when controller is idle", async () => {
    const ctrl = makeFakeController(false);
    const pipe = makeFakePipeline();
    const vchat = makeVchat(ctrl, pipe);
    const result = await toggleVoiceChatRealtime(vchat);
    expect(result.action).toBe('enter');
    expect(result.status).toContain('voice-chat started');
    expect(pipe.startCalls).toBe(1);
    expect(pipe.cancelCalls).toBe(0);
  });

  it('exits when controller is already active', async () => {
    const ctrl = makeFakeController(true);
    const pipe = makeFakePipeline();
    const vchat = makeVchat(ctrl, pipe);
    const result = await toggleVoiceChatRealtime(vchat);
    expect(result.action).toBe('exit');
    expect(result.status).toContain('exited');
    expect(pipe.cancelCalls).toBe(1);
    expect(pipe.startCalls).toBe(0);
    expect(ctrl.exitCalls.length).toBe(1);
    expect(ctrl.active).toBe(false);
  });

  it('refuses with mutex when D5 voice mode is active', async () => {
    const ctrl = makeFakeController(false);
    const pipe = makeFakePipeline();
    const vchat = makeVchat(ctrl, pipe);
    const result = await toggleVoiceChatRealtime(vchat, {
      d5VoiceActive: () => true,
    });
    expect(result.action).toBe('mutex');
    expect(result.status).toContain('Ctrl+Shift+V');
    // Mutex must NOT touch the controller or pipeline.
    expect(pipe.startCalls).toBe(0);
    expect(pipe.cancelCalls).toBe(0);
    expect(ctrl.active).toBe(false);
  });

  it('reports exit-as-noop when startListening fails', async () => {
    const ctrl = makeFakeController(false);
    const pipe = makeFakePipeline({ shouldFail: true });
    const vchat = makeVchat(ctrl, pipe);
    const result = await toggleVoiceChatRealtime(vchat);
    expect(result.action).toBe('exit');
    expect(result.status).toContain('failed to start');
    expect(pipe.startCalls).toBe(1);
  });
});

describe('SLASH_COMMANDS registry — voice slashes registered', () => {
  it("'/vc' and '/voice-chat' stay registered but are hidden from the compact slash picker", async () => {
    const { SLASH_COMMANDS, filterSlashCommands } = await import('../src/chat/index.js');
    const haveVoiceChat = SLASH_COMMANDS.some((c) => c.name === 'voice-chat');
    const haveVcAlias = SLASH_COMMANDS.some((c) => (c.aliases ?? []).includes('vc'));
    expect(haveVoiceChat).toBe(true);
    expect(haveVcAlias).toBe(true);
    const ranked = filterSlashCommands('vc', SLASH_COMMANDS);
    expect(ranked.map((c) => c.name)).not.toContain('voice-chat');
    expect(SLASH_COMMANDS.find((c) => c.name === 'voice-chat')?.hidden).toBe(true);
  });

  it("'/auto-tts' + 'tts' stay registered but are hidden from the compact slash picker", async () => {
    const { SLASH_COMMANDS, filterSlashCommands } = await import('../src/chat/index.js');
    const haveAutoTts = SLASH_COMMANDS.some((c) => c.name === 'auto-tts');
    const haveTtsAlias = SLASH_COMMANDS.some((c) => (c.aliases ?? []).includes('tts'));
    expect(haveAutoTts).toBe(true);
    expect(haveTtsAlias).toBe(true);
    const ranked = filterSlashCommands('tts', SLASH_COMMANDS);
    expect(ranked.map((c) => c.name)).not.toContain('auto-tts');
    expect(SLASH_COMMANDS.find((c) => c.name === 'auto-tts')?.hidden).toBe(true);
  });
});
