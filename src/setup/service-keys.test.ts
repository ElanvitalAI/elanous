import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServiceKeyEnv, serviceKeyStatus, storeServiceKeys, verifyServiceKey } from './service-keys.js';
import { buildUserConfig } from '../user-config.js';
import { importServiceKeys } from '../cli/setup-keys.js';

const roots: string[] = [];
function cacheDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'service-key-setup-'));
  roots.push(path);
  return path;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('service key setup storage boundary', () => {
  test('imports only catalogued .env names and never returns values in the write result', () => {
    const root = cacheDir();
    const secret = 'sentinel-value-never-render';
    const parsed = parseServiceKeyEnv(`# optional\nexport XAI_API_KEY="${secret}"\nOPENROUTER_API_KEY=second-value # note`);
    const env: NodeJS.ProcessEnv = {};
    expect(storeServiceKeys(parsed, { cacheDir: root, env })).toEqual({ stored: ['OPENROUTER_API_KEY', 'XAI_API_KEY'] });
    expect(env.XAI_API_KEY).toBe(secret);
    expect(readFileSync(join(root, 'xai_api_key'), 'utf8')).toBe(`${secret}\n`);
    expect(statSync(join(root, 'xai_api_key')).mode & 0o777).toBe(0o600);
    const status = serviceKeyStatus({ env, cacheDir: root });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify({ stored: ['OPENROUTER_API_KEY', 'XAI_API_KEY'] })).not.toContain(secret);
  });

  test('rejects unknown, duplicate, malformed, and empty entries without echoing their values', () => {
    const sentinel = 'sentinel-never-echo-this';
    expect(() => parseServiceKeyEnv(`UNLISTED_TOKEN=${sentinel}`)).toThrow('unsupported env name: UNLISTED_TOKEN');
    expect(() => parseServiceKeyEnv(`XAI_API_KEY=${sentinel}\nXAI_API_KEY=another-secret`)).toThrow('duplicate env name: XAI_API_KEY');
    expect(() => parseServiceKeyEnv(`XAI_API_KEY="${sentinel}`)).toThrow('invalid quoted value for XAI_API_KEY');
    expect(() => parseServiceKeyEnv('XAI_API_KEY=')).toThrow('empty or invalid value for XAI_API_KEY');
  });

  test('status is metadata-only and reports cache presence without returning cached values', () => {
    const root = cacheDir();
    const sentinel = 'status-must-not-leak-this';
    storeServiceKeys(parseServiceKeyEnv(`EXA_API_KEY=${sentinel}`), { cacheDir: root, env: {} });
    const status = serviceKeyStatus({ env: {}, cacheDir: root });
    expect(status.find(item => item.id === 'exa')).toMatchObject({ id: 'exa', configured: true, envNames: ['EXA_API_KEY'] });
    expect(JSON.stringify(status)).not.toContain(sentinel);
  });

  test('stores catalogued keys without a verifier only with an explicit unverified notice', async () => {
    const root = cacheDir();
    const env: NodeJS.ProcessEnv = {};
    const output: string[] = [];
    const configPath = join(root, 'config.json');
    const result = await importServiceKeys(
      parseServiceKeyEnv('SUPADATA_API_KEY=sentinel-unverified'),
      { print: line => output.push(line) },
      { config: buildUserConfig(configPath), env, cacheDir: root },
    );
    expect(result).toEqual({ stored: ['SUPADATA_API_KEY'], rejected: [], unverified: ['SUPADATA_API_KEY'] });
    expect(env.SUPADATA_API_KEY).toBe('sentinel-unverified');
    expect(output.join('\n')).toContain('검증 없이 저장합니다');
    expect(output.join('\n')).not.toContain('sentinel-unverified');
  });

  test('Gemini key is sent in the authentication header, never in the request URL', async () => {
    const secret = 'gemini-key-sentinel';
    let requestedUrl = '';
    let requestHeaders: HeadersInit | undefined;
    const result = await verifyServiceKey('gemini-api', secret, {
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestHeaders = init?.headers;
        return new Response('{}', { status: 200 });
      },
    });
    expect(result).toEqual({ result: 'verified', httpStatus: 200 });
    expect(requestedUrl).not.toContain(secret);
    expect(requestedUrl).not.toContain('?key=');
    expect(new Headers(requestHeaders).get('x-goog-api-key')).toBe(secret);
  });
});
