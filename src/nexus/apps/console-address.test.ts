import { describe, expect, test } from 'bun:test';
import { parsePublicAppHost } from '../../relay/relay-server.js';
import { consoleAddress, publicAppAddress, simulationPreviewAddress } from './console-address.js';

describe('NEXUS-CONSOLE-ADDRESS simulation contract', () => {
  test('keeps the hosted management console on its isolated domain and local console on its Nexus PWA origin', () => {
    const worlds = [
      { name: 'hosted Nexus', input: { kind: 'hosted' } as const, expected: 'https://console.elanous.ai' },
      { name: 'loopback Nexus', input: { kind: 'local', nexusOrigin: 'http://127.0.0.1:31415/path-is-ignored' } as const, expected: 'http://127.0.0.1:31415' },
      { name: 'tailnet Nexus', input: { kind: 'local', nexusOrigin: 'https://nexus.example.ts.net' } as const, expected: 'https://nexus.example.ts.net' },
    ];

    for (const world of worlds) {
      expect(consoleAddress(world.input), world.name).toBe(world.expected);
    }
  });

  test('maps a simulation preview into the one-label public app host without sharing the console origin', () => {
    const preview = simulationPreviewAddress({ appSlug: 'voice-note', userSlug: 'alice' });
    const previewUrl = new URL(preview);

    expect(preview).toBe('https://voice-note-sim--alice.elanous.app');
    expect(parsePublicAppHost(previewUrl.host, 'elanous.app')).toEqual({ app: 'voice-note-sim', user: 'alice' });
    expect(publicAppAddress({ appSlug: 'voice-note', userSlug: 'alice' })).toBe('https://voice-note--alice.elanous.app');
    expect(previewUrl.origin).not.toBe(consoleAddress({ kind: 'hosted' }));
    expect(previewUrl.hostname.endsWith('.elanous.app')).toBe(true);
    expect(new URL(consoleAddress({ kind: 'hosted' })).hostname.endsWith('.elanous.ai')).toBe(true);
  });

  test('rejects origins and app/user labels that cannot form a safe public address', () => {
    expect(() => consoleAddress({ kind: 'local', nexusOrigin: 'javascript:alert(1)' })).toThrow();
    expect(() => consoleAddress({ kind: 'local', nexusOrigin: 'https://user:pass@nexus.example.ts.net' })).toThrow();
    expect(() => simulationPreviewAddress({ appSlug: 'notes--other', userSlug: 'alice' })).toThrow();
    expect(() => simulationPreviewAddress({ appSlug: 'notes', userSlug: 'a' })).toThrow();
  });

  test('accepts the largest app and user labels that fit the relay after the preview suffix', () => {
    const appSlug = 'a'.repeat(20);
    const userSlug = 'u'.repeat(20);
    expect(simulationPreviewAddress({ appSlug, userSlug }))
      .toBe(`https://${appSlug}-sim--${userSlug}.elanous.app`);
  });

  test('rejects labels whose preview host would exceed the relay label limits', () => {
    expect(() => simulationPreviewAddress({ appSlug: 'a'.repeat(21), userSlug: 'alice' }))
      .toThrow('cannot form a simulation preview address');
    expect(() => simulationPreviewAddress({ appSlug: 'notes', userSlug: 'u'.repeat(21) }))
      .toThrow('cannot form a public app address');
  });
});
