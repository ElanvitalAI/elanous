import { describe, expect, test } from 'bun:test';

import { discoverChromeBinary, isWindowsInterop } from '../src/browser-cdp/client.js';

const WINDOWS_WSL_CANDIDATES = [
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

describe('Windows browser discovery from WSL', () => {
  test('prefers Linux Chrome in WSL, then checks Windows Edge and Chrome candidates in order', () => {
    const linuxCandidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
    for (const expected of WINDOWS_WSL_CANDIDATES) {
      expect(discoverChromeBinary({
        env: {},
        platform: 'linux',
        readFile: (path) => path === '/proc/version' ? 'Linux version 5.15.0-Microsoft-standard-WSL2' : null,
        existsSync: (path) => path === expected,
      })).toBe(expected);
    }

    const inspected: string[] = [];
    expect(discoverChromeBinary({
      env: {},
      platform: 'linux',
      readFile: () => 'Linux version 5.15.0-microsoft-standard-WSL2',
      existsSync: (path) => {
        inspected.push(path);
        return path === '/usr/bin/google-chrome';
      },
    })).toBe('/usr/bin/google-chrome');
    expect(inspected).toEqual(['/usr/bin/google-chrome']);

    inspected.length = 0;
    expect(discoverChromeBinary({
      env: {},
      platform: 'linux',
      readFile: () => 'Linux version 5.15.0-microsoft-standard-WSL2',
      existsSync: (path) => {
        inspected.push(path);
        return false;
      },
    })).toBeNull();
    expect(inspected).toEqual([...linuxCandidates, ...WINDOWS_WSL_CANDIDATES]);
  });

  test('does not inspect Windows candidates outside Windows interop', () => {
    expect(discoverChromeBinary({
      env: {},
      platform: 'linux',
      readFile: () => 'Linux version 6.8.0-generic',
      existsSync: (path) => path === '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    })).toBeNull();
  });

  test('uses a safe default proc-version reader when no reader is injected', () => {
    expect(() => discoverChromeBinary({
      env: {},
      platform: 'linux',
      existsSync: () => false,
    })).not.toThrow();
  });

  test('detects Microsoft WSL and safely rejects missing proc data', () => {
    expect(isWindowsInterop('Linux version 5.15.0-Microsoft-standard-WSL2')).toBeTrue();
    expect(isWindowsInterop('Linux version 5.15.0-microsoft-standard-WSL2')).toBeTrue();
    expect(isWindowsInterop(null)).toBeFalse();
  });
});
