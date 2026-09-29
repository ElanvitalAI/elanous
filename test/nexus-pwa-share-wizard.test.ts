// P.3 — First-boot PWA share wizard unit coverage.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  runPwaSharePrompt,
  type PwaSharePromptDeps,
  type ShareTailnetValue,
} from '../src/nexus/onboarding/pwa-share-prompt.js';
import type { TailscaleProbe } from '../src/nexus/onboarding/tailscale-probe.js';
import type { WizardIO } from '../src/onboarding.js';

interface DepsState {
  switchValue: ShareTailnetValue;
  probe: TailscaleProbe;
  pwaBuilt: boolean;
  chooseAnswer: boolean;
  buildExitCode: number;
  serveExitCode: number;
  saveCalls: ShareTailnetValue[];
  buildCalls: number;
  serveCalls: number;
  servedPorts: number[];
  chooseCalls: number;
  logs: string[];
  errors: string[];
}

function mkDeps(state: Partial<DepsState> = {}): { deps: PwaSharePromptDeps; state: DepsState } {
  const s: DepsState = {
    switchValue: 'ask',
    probe: {
      installed: true,
      alive: true,
      hostname: 'mbp',
      magicDnsHost: 'mbp.tail-abc.ts.net',
      ips: ['100.64.0.2'],
      binary: '/opt/homebrew/bin/tailscale',
    },
    pwaBuilt: true,
    chooseAnswer: true,
    buildExitCode: 0,
    serveExitCode: 0,
    saveCalls: [],
    buildCalls: 0,
    serveCalls: 0,
    servedPorts: [],
    chooseCalls: 0,
    logs: [],
    errors: [],
    ...state,
  };
  const io: WizardIO = {
    ask: async () => '',
    print: (l) => s.logs.push(l),
    close: () => {},
    choose: async (_prompt, options) => {
      s.chooseCalls += 1;
      return (options.find((o) => o.value === s.chooseAnswer) ?? options[0])!.value;
    },
    showStep: () => {},
    showSuccess: (msg) => s.logs.push(`success:${msg}`),
    showError: (_field, msg) => s.errors.push(msg),
  };
  const deps: PwaSharePromptDeps = {
    probeFn: async () => s.probe,
    buildFn: async () => {
      s.buildCalls += 1;
      return { exitCode: s.buildExitCode };
    },
    serveFn: async (_binary, port) => {
      s.serveCalls += 1;
      s.servedPorts.push(port);
      return { exitCode: s.serveExitCode };
    },
    readSwitch: () => s.switchValue,
    saveSwitch: (v) => {
      s.saveCalls.push(v);
      s.switchValue = v;
    },
    io,
    pwaBuilt: s.pwaBuilt,
    port: 31420,
    forceTty: true,
    out: {
      log: (l) => s.logs.push(l),
      error: (l) => s.errors.push(l),
    },
  };
  return { deps, state: s };
}

describe('P.3 · runPwaSharePrompt', () => {
  test('Nexus boot skips PWA onboarding when no HTTP listener was bound', () => {
    const source = readFileSync(new URL('../src/nexus/index.ts', import.meta.url), 'utf8');
    const boot = source.slice(source.indexOf('  // P.3 — first-boot PWA share wizard.'), source.indexOf('  // PWA share auto-mount'));
    expect(boot).toContain('shouldRunTailscale: httpPort !== undefined && shouldAskPwaShareSwitch()');
    expect(boot).toContain('if (httpPort === undefined) return;');
    expect(boot).not.toContain("throw new Error('NEXUS HTTP port unavailable for PWA onboarding')");
    expect(boot).toContain('port: httpPort,');
  });

  test('switch already enabled → skipped (no probe / no prompt)', async () => {
    const { deps, state } = mkDeps({ switchValue: 'enabled' });
    const result = await runPwaSharePrompt(deps);
    expect(result).toEqual({ action: 'skipped', reason: 'switch-set' });
    expect(state.chooseCalls).toBe(0);
    expect(state.saveCalls).toEqual([]);
  });

  test('switch already disabled → skipped', async () => {
    const { deps, state } = mkDeps({ switchValue: 'disabled' });
    const result = await runPwaSharePrompt(deps);
    expect(result).toEqual({ action: 'skipped', reason: 'switch-set' });
    expect(state.chooseCalls).toBe(0);
  });

  test('non-TTY → skipped (reason no-tty)', async () => {
    const { deps } = mkDeps();
    deps.forceTty = false;
    const result = await runPwaSharePrompt(deps);
    expect(result).toEqual({ action: 'skipped', reason: 'no-tty' });
  });

  test('Tailscale missing → install hint, switch stays ask', async () => {
    const { deps, state } = mkDeps({
      probe: { installed: false, alive: false },
    });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('tailscale-missing-hint');
    expect(state.saveCalls).toEqual([]);
    expect(state.logs.some((l) => l.includes('Tailscale not detected'))).toBe(true);
    expect(state.logs.some((l) => l.includes('https://tailscale.com/download'))).toBe(true);
  });

  test('Tailscale alive + user Y + already built → enabled (no rebuild)', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true, pwaBuilt: true });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('enabled');
    if (result.action === 'enabled') {
      expect(result.built).toBe(false);  // already built
    }
    expect(state.buildCalls).toBe(0);
    expect(state.serveCalls).toBe(1);
    expect(state.servedPorts).toEqual([31420]);
    expect(state.logs.some((line) => line.includes('https://mbp.tail-abc.ts.net:31420/app/'))).toBe(true);
    expect(state.saveCalls).toEqual(['enabled']);
  });

  test('bound-port input drives both the picker and serve after a missing build', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true, pwaBuilt: false });
    deps.port = 31421;
    const choose = deps.io.choose!;
    deps.io.choose = async (prompt, options, opts) => {
      expect(options[0]?.label).toContain('https://mbp.tail-abc.ts.net:31421/app/');
      return choose(prompt, options, opts);
    };
    const result = await runPwaSharePrompt(deps);
    expect(result).toMatchObject({ action: 'enabled', built: true });
    expect(state.buildCalls).toBe(1);
    expect(state.servedPorts).toEqual([31421]);
    expect(state.saveCalls).toEqual(['enabled']);
  });

  test('Tailscale alive + user Y + missing build → build then serve → enabled', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true, pwaBuilt: false });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('enabled');
    if (result.action === 'enabled') {
      expect(result.built).toBe(true);
    }
    expect(state.buildCalls).toBe(1);
    expect(state.serveCalls).toBe(1);
    expect(state.servedPorts).toEqual([31420]);
    expect(state.logs.some((line) => line.includes('https://mbp.tail-abc.ts.net:31420/app/'))).toBe(true);
    expect(state.saveCalls).toEqual(['enabled']);
  });

  test('user N → disabled (no build / no serve)', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: false });
    const result = await runPwaSharePrompt(deps);
    expect(result).toEqual({ action: 'disabled' });
    expect(state.buildCalls).toBe(0);
    expect(state.serveCalls).toBe(0);
    expect(state.saveCalls).toEqual(['disabled']);
  });

  test('default picker choice treated as Y', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('enabled');
    expect(state.saveCalls).toEqual(['enabled']);
  });

  test('Y + build fail → switch stays ask, hint emitted', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true, pwaBuilt: false, buildExitCode: 1 });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('tailscale-missing-hint');
    expect(state.serveCalls).toBe(0);   // never reached
    expect(state.saveCalls).toEqual([]);
    expect(state.errors.some((e) => e.includes('build failed'))).toBe(true);
  });

  test('Y + serve fail → switch stays ask, error emitted', async () => {
    const { deps, state } = mkDeps({ chooseAnswer: true, pwaBuilt: true, serveExitCode: 2 });
    const result = await runPwaSharePrompt(deps);
    expect(result.action).toBe('tailscale-missing-hint');
    expect(state.saveCalls).toEqual([]);
    expect(state.errors.some((e) => e.includes('tailscale serve failed'))).toBe(true);
  });
});
