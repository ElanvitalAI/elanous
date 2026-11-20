/**
 * NEXUS T3 endpoint contract — WS URL builders.
 *
 * DOGFOOD §S2 (`/v1/voice/ws`) + §S3 (`/v1/acp`) 의 PWA-side counterpart.
 * `buildAcpWsUrl` / `buildVoiceWsUrl` 가 baseUrl → ws/wss upgrade URL 로
 * 변환할 때 protocol mapping + path append + edge cases 검증.
 */

import { describe, expect, it } from 'bun:test';

import { buildAcpWsUrl, buildVoiceWsUrl, isBareWebChatOrigin } from './daemon-config';

function cfg(baseUrl: string): { baseUrl: string; token: string; provider: string } {
  return { baseUrl, token: '', provider: 'anthropic' };
}

describe('buildAcpWsUrl', () => {
  it('http → ws + path /v1/acp', () => {
    expect(buildAcpWsUrl(cfg('http://localhost:31415'))).toBe('ws://localhost:31415/v1/acp');
  });

  it('https → wss + path /v1/acp (Tailscale Serve TLS)', () => {
    expect(buildAcpWsUrl(cfg('https://mbp.tailnet-example.ts.net:31415'))).toBe(
      'wss://mbp.tailnet-example.ts.net:31415/v1/acp',
    );
  });

  it('IPv4 host preserved', () => {
    expect(buildAcpWsUrl(cfg('http://100.64.0.2:31415'))).toBe('ws://100.64.0.2:31415/v1/acp');
  });

  it('returns empty string when baseUrl is empty (skip handshake)', () => {
    expect(buildAcpWsUrl(cfg(''))).toBe('');
  });

  it('preserves a non-default port', () => {
    expect(buildAcpWsUrl(cfg('http://localhost:8080'))).toBe('ws://localhost:8080/v1/acp');
  });

  it('overrides any pre-existing path on the baseUrl', () => {
    // baseUrl with a path is unusual but must collapse to the canonical
    // ACP path — the URL constructor treats `/v1/acp` as absolute when
    // it starts with `/`.
    expect(buildAcpWsUrl(cfg('http://localhost:31415/old/'))).toBe(
      'ws://localhost:31415/v1/acp',
    );
  });
});

describe('buildVoiceWsUrl', () => {
  it('http → ws + path /v1/voice/ws', () => {
    expect(buildVoiceWsUrl(cfg('http://localhost:31415'))).toBe(
      'ws://localhost:31415/v1/voice/ws',
    );
  });

  it('https → wss + path /v1/voice/ws (mic getUserMedia secure context)', () => {
    expect(buildVoiceWsUrl(cfg('https://mbp.tailnet-example.ts.net:31415'))).toBe(
      'wss://mbp.tailnet-example.ts.net:31415/v1/voice/ws',
    );
  });

  it('returns empty string when baseUrl is empty (skip voice WS open)', () => {
    expect(buildVoiceWsUrl(cfg(''))).toBe('');
  });
});

describe('isBareWebChatOrigin (MK #109711 — server-delivered meta)', () => {
  const doc = (content: string | null) => ({
    querySelector: (sel: string) =>
      sel === 'meta[name="elanous-bare-webchat"]' && content !== null
        ? { getAttribute: () => content }
        : null,
  });
  it('true only when the server-injected meta is "1"', () => {
    expect(isBareWebChatOrigin(doc('1') as never)).toBe(true);
    expect(isBareWebChatOrigin(doc('0') as never)).toBe(false);
    expect(isBareWebChatOrigin(doc(null) as never)).toBe(false);
  });
  it('false without a DOM (normal origin / SSR / test doubles)', () => {
    expect(isBareWebChatOrigin(undefined)).toBe(false);
    expect(isBareWebChatOrigin({} as never)).toBe(false);
  });
});
