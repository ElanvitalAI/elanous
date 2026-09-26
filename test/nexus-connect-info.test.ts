// T4.A — /v1/nexus/connect-info endpoint.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  advertisedHostname,
  buildConnectInfo,
  buildMintTokenResponse,
  ConnectInfoAdvertisementError,
  hostnameFromRequestHost,
  isLoopbackHost,
  isWildcardBindHost,
  handleConnectInfoGet,
  handleConnectTokenMint,
  parseRequestAuthority,
  type ConnectInfoCtx,
} from '../src/nexus/api/connect-info.js';

describe('T4.A · isLoopbackHost', () => {
  test('127.0.0.1 / localhost / ::1 = loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });
  test('Tailscale name / 0.0.0.0 / LAN IP = NOT loopback', () => {
    expect(isLoopbackHost('mbp.tailnet')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });
});

describe('T4.A · buildConnectInfo · loopback auto_token', () => {
  // 🔐 2026-09-26: 토큰 파일이 있어도 HTTP 로 원문을 싣지 않는다(tailnet serve 가 localhost 로 프록시 → 루프백 바인드로 못 가른다).
  test('loopback + token file present → auto_token still null (never ships the raw bearer)', () => {
    const tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-connect-info-'));
    const tokenPath = joinPath(tmp, 'acp-token');
    writeFileSync(tokenPath, 'mySecretBearer\n', { mode: 0o600 });
    const ctx: ConnectInfoCtx = {
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: tokenPath,
    };
    const body = buildConnectInfo(ctx);
    expect(body.acp_url).toBe('ws://127.0.0.1:31415/v1/acp');
    expect(body.voice_url).toBe('ws://127.0.0.1:31415/v1/voice/ws');
    expect(body.auto_token).toBeNull();
    expect(JSON.stringify(body)).not.toContain('mySecretBearer');
    expect(body.token_required).toBe(true);
    rmSync(tmp, { recursive: true });
  });

  test('loopback + token file absent → auto_token null', () => {
    const ctx: ConnectInfoCtx = {
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: '/nonexistent/path/to/acp-token',
    };
    const body = buildConnectInfo(ctx);
    expect(body.auto_token).toBeNull();
    expect(body.token_required).toBe(true);
    expect(body.token_hint).toContain('paste content');
  });

  test('loopback + empty token file → auto_token null (not empty string)', () => {
    const tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-connect-info-'));
    const tokenPath = joinPath(tmp, 'acp-token');
    writeFileSync(tokenPath, '   \n', { mode: 0o600 });
    const ctx: ConnectInfoCtx = {
      hostname: 'localhost',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: tokenPath,
    };
    const body = buildConnectInfo(ctx);
    expect(body.auto_token).toBeNull();
    rmSync(tmp, { recursive: true });
  });

  test('non-loopback host → auto_token always null even when file exists', () => {
    const tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-connect-info-'));
    const tokenPath = joinPath(tmp, 'acp-token');
    writeFileSync(tokenPath, 'shouldNotLeak\n', { mode: 0o600 });
    const ctx: ConnectInfoCtx = {
      hostname: 'mbp.tailnet',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: tokenPath,
    };
    const body = buildConnectInfo(ctx);
    expect(body.auto_token).toBeNull();
    expect(body.token_required).toBe(true);
    expect(body.acp_url).toBe('ws://mbp.tailnet:31415/v1/acp');
    rmSync(tmp, { recursive: true });
  });

  test('server_label default = `<host> (NEXUS <ver>)`', () => {
    const ctx: ConnectInfoCtx = {
      hostname: 'mbp.tailnet',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: null,
    };
    const body = buildConnectInfo(ctx);
    expect(body.server_label).toBe('mbp.tailnet (NEXUS 0.17.0)');
  });

  test('server_label override wins', () => {
    const ctx: ConnectInfoCtx = {
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      serverLabel: 'home-mac',
      acpTokenOverride: null,
    };
    expect(buildConnectInfo(ctx).server_label).toBe('home-mac');
  });
});

describe('T4.A · handleConnectInfoGet HTTP shape', () => {
  test('returns 200 + JSON body', async () => {
    const ctx: ConnectInfoCtx = {
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: 'tokenABC',
    };
    const res = handleConnectInfoGet(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { auto_token: string | null; acp_url: string };
    expect(body.auto_token).toBeNull();
    expect(body.acp_url).toBe('ws://127.0.0.1:31415/v1/acp');
  });
});

describe('T4.D · buildMintTokenResponse + handleConnectTokenMint', () => {
  test('reads acp-token override + returns expiresAt=null', () => {
    const body = buildMintTokenResponse({
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: 'theBearer',
    });
    expect(body.token).toBe('theBearer');
    expect(body.expiresAt).toBeNull();
    expect(body.hint.length).toBeGreaterThan(0);
  });

  test('reads acp-token from disk when override absent', () => {
    const tmp = mkdtempSync(joinPath(tmpdir(), 'elanous-mint-'));
    const path = joinPath(tmp, 'acp-token');
    writeFileSync(path, 'fileBearer\n', { mode: 0o600 });
    const body = buildMintTokenResponse({
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: path,
    });
    expect(body.token).toBe('fileBearer');
    rmSync(tmp, { recursive: true });
  });

  test('throws when token file missing → handleConnectTokenMint = 503', async () => {
    const res = handleConnectTokenMint({
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenPath: '/nonexistent/path',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('token-unavailable');
  });

  test('handleConnectTokenMint happy → 201 + JSON body', async () => {
    const res = handleConnectTokenMint({
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: 'okBearer',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; expiresAt: number | null };
    expect(body.token).toBe('okBearer');
    expect(body.expiresAt).toBeNull();
  });
});

describe('T4.A · advertised host · wildcard bind uses request Host', () => {
  test('0.0.0.0 / :: / empty bind = wildcard', () => {
    expect(isWildcardBindHost('0.0.0.0')).toBe(true);
    expect(isWildcardBindHost('::')).toBe(true);
    expect(isWildcardBindHost('')).toBe(true);
    expect(isWildcardBindHost('127.0.0.1')).toBe(false);
    expect(isWildcardBindHost('mbp.tailnet')).toBe(false);
  });

  test('hostnameFromRequestHost strips :port and IPv6 brackets', () => {
    expect(hostnameFromRequestHost('100.64.0.3:31415')).toBe('100.64.0.3');
    expect(hostnameFromRequestHost('grokb1.tailnet')).toBe('grokb1.tailnet');
    expect(hostnameFromRequestHost('[::1]:31415')).toBe('::1');
  });

  test('parseRequestAuthority keeps an explicit Host port', () => {
    expect(parseRequestAuthority('example.com:8443')).toEqual({ hostname: 'example.com', port: 8443 });
    expect(parseRequestAuthority('[::1]:8443')).toEqual({ hostname: '::1', port: 8443 });
    expect(parseRequestAuthority('example.com')).toEqual({ hostname: 'example.com' });
    expect(parseRequestAuthority('[::1]')).toEqual({ hostname: '::1' });
    expect(parseRequestAuthority('')).toBeNull();
  });

  test('wildcard bind + specific Host → acp_url / voice_url / server_label use that Host', () => {
    const body = buildConnectInfo({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: '100.64.0.3:31415',
      acpTokenOverride: 'shouldNotLeak',
    });
    expect(body.acp_url).toBe('ws://100.64.0.3:31415/v1/acp');
    expect(body.voice_url).toBe('ws://100.64.0.3:31415/v1/voice/ws');
    expect(body.server_label).toBe('100.64.0.3 (NEXUS 0.17.0)');
    expect(JSON.stringify(body)).not.toContain('0.0.0.0');
  });

  test(':: bind + Host header → advertised host, never the wildcard string', () => {
    const body = buildConnectInfo({
      hostname: '::',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'grokb1.tailnet:31415',
      acpTokenOverride: null,
    });
    expect(body.acp_url).toBe('ws://grokb1.tailnet:31415/v1/acp');
    expect(body.voice_url).toContain('grokb1.tailnet');
    expect(body.server_label).toContain('grokb1.tailnet');
    expect(body.acp_url).not.toContain('::');
  });

  test('empty bind + Host → request host, not an empty wildcard leak in URLs', () => {
    const body = buildConnectInfo({
      hostname: '',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'lan-box.local',
      acpTokenOverride: null,
    });
    expect(body.acp_url).toBe('ws://lan-box.local:31415/v1/acp');
    expect(advertisedHostname({
      hostname: '',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'lan-box.local',
    })).toBe('lan-box.local');
  });

  test('concrete bind 127.0.0.1 keeps existing URLs even when request Host differs', () => {
    const body = buildConnectInfo({
      hostname: '127.0.0.1',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: '100.64.0.3:31415',
      acpTokenOverride: 'tokenABC',
    });
    expect(body.acp_url).toBe('ws://127.0.0.1:31415/v1/acp');
    expect(body.voice_url).toBe('ws://127.0.0.1:31415/v1/voice/ws');
    expect(body.server_label).toBe('127.0.0.1 (NEXUS 0.17.0)');
    expect(body.auto_token).toBeNull();
    expect(body.token_required).toBe(true);
  });

  test('two different Hosts on the same wildcard bind advertise different acp_url', () => {
    const base: ConnectInfoCtx = {
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: 'secret',
    };
    const a = buildConnectInfo({ ...base, requestHost: 'grokb1.tailnet:31415' });
    const b = buildConnectInfo({ ...base, requestHost: '100.64.0.3:31415' });
    expect(a.acp_url).toBe('ws://grokb1.tailnet:31415/v1/acp');
    expect(b.acp_url).toBe('ws://100.64.0.3:31415/v1/acp');
    expect(a.acp_url).not.toBe(b.acp_url);
  });

  test('wildcard bind + remote Host → auto_token stays null (loopback-only policy)', () => {
    const body = buildConnectInfo({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: '100.64.0.3:31415',
      acpTokenOverride: 'shouldNotLeak',
    });
    expect(body.auto_token).toBeNull();
    expect(body.token_required).toBe(true);
    expect(body.token_hint).toContain('paste content');
  });

  test('handleConnectInfoGet on wildcard bind uses requestHost in JSON body', async () => {
    const res = handleConnectInfoGet({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'grokb1',
      acpTokenOverride: 'nope',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      acp_url: string;
      voice_url: string;
      server_label: string;
      auto_token: string | null;
    };
    expect(body.acp_url).toBe('ws://grokb1:31415/v1/acp');
    expect(body.voice_url).toBe('ws://grokb1:31415/v1/voice/ws');
    expect(body.server_label).toBe('grokb1 (NEXUS 0.17.0)');
    expect(body.auto_token).toBeNull();
    expect(JSON.stringify(body)).not.toContain('0.0.0.0');
  });

  test('wildcard bind + Host with explicit port keeps that port, not bind.port', () => {
    const body = buildConnectInfo({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'example.com:8443',
      acpTokenOverride: null,
    });
    expect(body.acp_url).toBe('ws://example.com:8443/v1/acp');
    expect(body.voice_url).toBe('ws://example.com:8443/v1/voice/ws');
    expect(body.server_label).toBe('example.com (NEXUS 0.17.0)');
    expect(body.acp_url).not.toContain(':31415');
  });

  test('wildcard bind + Host without port falls back to bind.port', () => {
    const body = buildConnectInfo({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: 'example.com',
      acpTokenOverride: null,
    });
    expect(body.acp_url).toBe('ws://example.com:31415/v1/acp');
    expect(body.voice_url).toBe('ws://example.com:31415/v1/voice/ws');
  });

  test('wildcard bind + bracketed IPv6 Host with port advertises that authority', () => {
    const body = buildConnectInfo({
      hostname: '::',
      port: 31415,
      nexusVersion: '0.17.0',
      requestHost: '[::1]:8443',
      acpTokenOverride: null,
    });
    expect(body.acp_url).toBe('ws://[::1]:8443/v1/acp');
    expect(body.voice_url).toBe('ws://[::1]:8443/v1/voice/ws');
    expect(body.server_label).toBe('::1 (NEXUS 0.17.0)');
    expect(body.acp_url).not.toMatch(/ws:\/\/:/);
  });

  test('wildcard bind without requestHost fails closed instead of empty-host URLs', () => {
    expect(() =>
      buildConnectInfo({
        hostname: '0.0.0.0',
        port: 31415,
        nexusVersion: '0.17.0',
        acpTokenOverride: null,
      }),
    ).toThrow(ConnectInfoAdvertisementError);
    expect(() =>
      buildConnectInfo({
        hostname: '0.0.0.0',
        port: 31415,
        nexusVersion: '0.17.0',
        requestHost: '   ',
        acpTokenOverride: null,
      }),
    ).toThrow(ConnectInfoAdvertisementError);
  });

  test('handleConnectInfoGet on wildcard bind without requestHost returns 400', async () => {
    const res = handleConnectInfoGet({
      hostname: '0.0.0.0',
      port: 31415,
      nexusVersion: '0.17.0',
      acpTokenOverride: 'nope',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; acp_url?: string; server_label?: string };
    expect(body.error).toBe('connect-info-host-required');
    expect(body.acp_url).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('ws://:');
  });
});
