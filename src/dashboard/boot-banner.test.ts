import { describe, expect, test } from 'bun:test';
import { bootBannerStatusLines, normalizeBootBannerMode, renderMinimalBootBand, type BootBannerHeld } from './boot-banner.js';
import { buildFirstScreenBand, type TuiDaemonLink } from './first-screen-band.js';
import { renderDashboardFirstScreenBand } from './index.js';
import { bootDashboardHitl } from './hitl-boot.js';
import { buildDashboardStatusLines } from './dashboard-status-lines.js';

// The seven rows the 대표 called noise on the first screen (#28).
const NOISE = [
  'elanous | daemon: connected (http://127.0.0.1:31415)',
  'PWA: https://host.ts.net/app/',
  '· Chat — ask for anything in plain language',
  '· Commands — /help lists every command',
  '· Skills — /run-skill <name> runs an installed skill',
  'Try typing: what can you do?',
  '[hitl] callback port 17645 was busy',
];

const connected = async (): Promise<TuiDaemonLink> => ({ status: 'connected', address: 'http://127.0.0.1:31415' });
const showPwa = async () => ({ status: 'registered' as const, urls: {
  pwa: { tailnet: 'https://host.ts.net/app/', loopback: 'http://127.0.0.1:3000/app/' },
  rest: { loopback: 'http://127.0.0.1:3000/v1/' },
  sse: { loopback: 'http://127.0.0.1:3000/v1/events' },
} });

function bootHitl(held: BootBannerHeld | null, lines: string[]): void {
  bootDashboardHitl({
    enabled: true,
    initDashboardHitl: async ({ onPortShift }) => { onPortShift({ wanted: 17645, actual: 17647 }); },
    stopDashboardHitl: async () => {},
    debugLog: () => {},
    isPushcutConfigured: () => true,
    pushWarningLine: (message) => { lines.push(message); },
    holdWarningLine: held ? (message) => { held.hitl = message; } : undefined,
    draw: () => {},
    registerBeforeExit: () => {},
    warnConsole: () => {},
  });
}

describe('boot banner mode', () => {
  test('defaults to minimal; only an explicit full restores the historical band', () => {
    expect(normalizeBootBannerMode(undefined)).toBe('minimal');
    expect(normalizeBootBannerMode('bogus')).toBe('minimal');
    expect(normalizeBootBannerMode('full')).toBe('full');
  });
});

describe('minimal boot banner', () => {
  test('healthy boot of an onboarded seat writes none of the seven noise rows; /status shows them', async () => {
    const lines: string[] = [];
    const held: BootBannerHeld = {};
    bootHitl(held, lines);
    await renderMinimalBootBand({
      history: [], lines, width: 120, locale: 'en', guidance: false, held,
      draw: () => {}, observe: () => {}, show: showPwa, daemonLink: connected,
    });
    await Bun.sleep(0);
    for (const noise of NOISE) expect(lines.some((line) => line.includes(noise))).toBe(false);
    expect(lines).toEqual([]);
    expect(held).toEqual({ daemon: NOISE[0], pwa: 'PWA: https://host.ts.net/app/', hitl: expect.stringContaining('[hitl] callback port 17645') });
    const status = buildDashboardStatusLines({
      daemonConnected: true, sessionSurfaceLines: [], view: 'v', focus: 'f', cwd: '/', preview: 'p',
      starterClosed: 'none', chatOnly: 'off', acp: 'idle', bootHeld: bootBannerStatusLines(held),
    });
    expect(status).toContain(NOISE[0]);
    expect(status).toContain('PWA: https://host.ts.net/app/');
    expect(status.some((line) => line.startsWith('[hitl] callback port 17645 was busy — bound 17647'))).toBe(true);
  });

  test('a failed daemon link writes exactly one row', async () => {
    for (const link of [
      { status: 'absent', startCommand: 'elanous nexus run --hmr' },
      { status: 'unhealthy', startCommand: 'elanous nexus run --hmr' },
      { status: 'error', stage: 'health' },
    ] as TuiDaemonLink[]) {
      const lines: string[] = [];
      let draws = 0;
      await renderMinimalBootBand({
        history: [], lines, width: 120, locale: 'en', guidance: false, held: {},
        draw: () => { draws++; }, observe: () => {}, show: async () => ({ status: 'absent' }),
        daemonLink: async () => link, styleFailure: (line) => `!${line}`,
      });
      expect(lines).toEqual([`!${buildFirstScreenBand({ width: 120, daemon: false, link, locale: 'en' })[0]}`]);
      expect(draws).toBe(1);
    }
    const thrown: string[] = [];
    await renderMinimalBootBand({
      history: [], lines: thrown, width: 120, locale: 'en', guidance: false, held: {},
      draw: () => {}, observe: () => {}, show: async () => ({ status: 'absent' }),
      daemonLink: async () => { throw new Error('boom'); },
    });
    expect(thrown).toEqual(['elanous | daemon: health lookup error']);
  });

  test('first run keeps the guidance rows; a resumed session gets nothing', async () => {
    const lines: string[] = [];
    await renderMinimalBootBand({
      history: [], lines, width: 120, locale: 'en', guidance: true, held: {},
      draw: () => {}, observe: () => {}, show: showPwa, daemonLink: connected,
    });
    expect(lines).toEqual(NOISE.slice(2, 6));
    const resumed = ['restored'];
    let probed = false;
    await renderMinimalBootBand({
      history: [{ role: 'user' }], lines: resumed, width: 120, guidance: true, held: {},
      draw: () => {}, observe: () => {}, show: async () => { probed = true; return { status: 'absent' }; },
      daemonLink: async () => { probed = true; return { status: 'checking' }; },
    });
    expect(resumed).toEqual(['restored']);
    expect(probed).toBe(false);
  });
});

describe('full boot banner', () => {
  test('keeps the historical first screen', async () => {
    const lines: string[] = [];
    bootHitl(null, lines);
    await renderDashboardFirstScreenBand({
      history: [], lines, width: 120, locale: 'en',
      draw: () => {}, observe: () => {}, show: showPwa, daemonLink: connected,
    });
    await Bun.sleep(0);
    for (const noise of NOISE) expect(lines.some((line) => line.includes(noise))).toBe(true);
  });
});
