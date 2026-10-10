// BEDROCK-PROVIDER — 자격·리전·서명·모델 id 순수 시험. ⛔ 실 AWS 호출 0 · 실 자격 값 0(가짜 값만).
import { expect, test } from 'bun:test';
import { redactSecretText } from '../debug/log.js';
import {
  BEDROCK_DEFAULT_MODEL,
  BedrockCredentialsUnresolvedError,
  bedrockAvailable,
  bedrockCanonicalClaudeId,
  bedrockCredentialSignal,
  bedrockCredentialSignalLabel,
  sanitizeCredentialErrorName,
  validBedrockRegion,
  bedrockMessagesUrl,
  buildSignedBedrockRequest,
  defaultBedrockSigner,
  findBedrockModel,
  isBedrockModelId,
  bedrockChildRelayEnv,
  regionFromAwsConfigText,
  resolveBedrockModelId,
  resolveBedrockRegion,
} from './bedrock.js';

const noFiles = { readText: () => undefined };
const FAKE = { accessKeyId: 'AKIDFAKEFAKEFAKE', secretAccessKey: 'fake-secret-not-real' };

test('model ids: alias · bare claude · wire passthrough · canonical', () => {
  expect(resolveBedrockModelId('bedrock/claude-sonnet-5-5')).toBe('anthropic.claude-sonnet-5-5');
  expect(resolveBedrockModelId('claude-haiku-5-5')).toBe('anthropic.claude-haiku-5-5');
  expect(resolveBedrockModelId('anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
  expect(resolveBedrockModelId('us.anthropic.claude-sonnet-5-5')).toBe('us.anthropic.claude-sonnet-5-5');
  expect(resolveBedrockModelId(undefined)).toBe(BEDROCK_DEFAULT_MODEL);
  expect(bedrockCanonicalClaudeId('global.anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  expect(isBedrockModelId('anthropic.claude-sonnet-5-5')).toBe(true);
  expect(isBedrockModelId('bedrock/claude-sonnet-5-5')).toBe(true);
  expect(isBedrockModelId('claude-sonnet-5-5')).toBe(false);
  expect(isBedrockModelId('gpt-6-sol')).toBe(false);
  expect(findBedrockModel('claude-sonnet-5-5')?.id).toBe('anthropic.claude-sonnet-5-5');
  expect(findBedrockModel('bedrock/claude-haiku-5-5')?.tier).toBe('cheap');
  expect(findBedrockModel('claude-sonnet-9-9')).toBeUndefined();
});

test('region: env first, then active profile region from config text, else undefined', () => {
  expect(resolveBedrockRegion({ env: { AWS_REGION: 'us-west-2', AWS_DEFAULT_REGION: 'eu-west-1' }, ...noFiles })).toBe('us-west-2');
  expect(resolveBedrockRegion({ env: { AWS_DEFAULT_REGION: 'eu-west-1' }, ...noFiles })).toBe('eu-west-1');
  const cfg = '[default]\nregion = us-east-1\n[profile work]\nregion=ap-northeast-2\n';
  expect(resolveBedrockRegion({ env: {}, readText: () => cfg })).toBe('us-east-1');
  expect(resolveBedrockRegion({ env: { AWS_PROFILE: 'work' }, readText: () => cfg })).toBe('ap-northeast-2');
  expect(resolveBedrockRegion({ env: { AWS_PROFILE: 'none' }, readText: () => cfg })).toBeUndefined();
  expect(resolveBedrockRegion({ env: {}, ...noFiles })).toBeUndefined();
  expect(regionFromAwsConfigText('[profile default]\nregion = sa-east-1', 'default')).toBe('sa-east-1');
});

test('available = candidate when the region resolves (credentials left to the chain — IMDS-only hosts count)', () => {
  expect(bedrockAvailable({ env: { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' }, ...noFiles })).toBe(false);
  // codex 확인판 must-fix ①: 리전 ⊕ EC2 인스턴스 역할(IMDS)만 — 신호는 없어도 «가용 후보».
  expect(bedrockCredentialSignal({ env: { AWS_REGION: 'us-east-1' }, ...noFiles })).toBeUndefined();
  expect(bedrockCredentialSignalLabel({ env: { AWS_REGION: 'us-east-1' }, ...noFiles })).toBe('chain');
  expect(bedrockAvailable({ env: { AWS_REGION: 'us-east-1' }, ...noFiles })).toBe(true);
  expect(bedrockCredentialSignal({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/x' }, ...noFiles })).toBe('container');
  expect(bedrockCredentialSignal({ env: { AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/token' }, ...noFiles })).toBe('web-identity');
  expect(bedrockAvailable({ env: { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' }, ...noFiles })).toBe(true);
  expect(bedrockCredentialSignal({ env: { AWS_BEARER_TOKEN_BEDROCK: 't' }, ...noFiles })).toBe('bearer-env');
});

test('credential signal from files counts only credential-bearing key names in the active profile', () => {
  const files = (cred: string | undefined, cfg: string | undefined) => ({
    readText: (p: string) => (p.endsWith('credentials') ? cred : p.endsWith('config') ? cfg : undefined),
  });
  // region 만 있는 config — 자격 신호 아님(=미가용). ⛔ 리뷰 1R: 파일 존재만으로 가용이 되지 않는다.
  const regionOnly = files(undefined, '[default]\nregion = us-east-1\n');
  expect(bedrockCredentialSignal({ env: {}, ...regionOnly })).toBeUndefined();
  expect(bedrockAvailable({ env: {}, ...regionOnly })).toBe(true);  // 리전이 풀리면 후보 — 자격은 체인이 판정
  expect(bedrockCredentialSignal({ env: {}, ...files('[default]\naws_access_key_id = X\n', undefined) })).toBe('shared-credentials-file');
  expect(bedrockCredentialSignal({ env: { AWS_PROFILE: 'other' }, ...files('[default]\naws_access_key_id = X\n', undefined) })).toBeUndefined();
  const sso = files(undefined, '[profile work]\nsso_session = corp\nregion = us-west-2\n');
  expect(bedrockCredentialSignal({ env: { AWS_PROFILE: 'work' }, ...sso })).toBe('shared-config-profile');
  expect(bedrockAvailable({ env: { AWS_PROFILE: 'work' }, ...sso })).toBe(true);
  expect(bedrockCredentialSignal({ env: { AWS_PROFILE: 'a' }, ...files(undefined, '[profile a]\nrole_arn = r\n') })).toBe('shared-config-profile');
  expect(bedrockCredentialSignal({ env: { AWS_PROFILE: 'a' }, ...files(undefined, '[profile a]\noutput = json\n') })).toBeUndefined();
});

test('chain failure → BedrockCredentialsUnresolvedError carrying the error name only', async () => {
  const err = await buildSignedBedrockRequest({
    region: 'us-east-1', body: {}, env: {},
    resolveCredentials: async () => { const e = new Error('secret-ish detail /home/x/.aws'); e.name = 'CredentialsProviderError'; throw e; },
  }).catch((e) => e);
  expect(err).toBeInstanceOf(BedrockCredentialsUnresolvedError);
  expect(String(err.message)).toContain('CredentialsProviderError');
  expect(String(err.message)).not.toContain('/home/x/.aws');
});

test('signed request: url · anthropic-version header · stream:true · injected signer gets credentials', async () => {
  let seen: { region?: string; hasCreds?: boolean } = {};
  const req = await buildSignedBedrockRequest({
    region: 'us-east-1',
    body: { model: 'anthropic.claude-sonnet-5-5', messages: [] },
    env: {},
    resolveCredentials: async () => FAKE,
    sign: async ({ region, headers, credentials }) => {
      seen = { region, hasCreds: credentials.accessKeyId === FAKE.accessKeyId };
      return { ...headers, authorization: 'AWS4-HMAC-SHA256 test' };
    },
  });
  expect(req.url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
  expect(req.headers['anthropic-version']).toBe('2023-06-01');
  expect(req.headers.authorization).toBe('AWS4-HMAC-SHA256 test');
  expect(JSON.parse(req.body).stream).toBe(true);
  expect(seen).toEqual({ region: 'us-east-1', hasCreds: true });
});

test('bearer token path uses x-api-key and never calls the credential chain', async () => {
  const req = await buildSignedBedrockRequest({
    region: 'us-west-2', body: {}, env: { AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' },
    resolveCredentials: async () => { throw new Error('must not be called'); },
  });
  expect(req.headers['x-api-key']).toBe('tok-fake');
  expect(req.headers.authorization).toBeUndefined();
});

test('default signer (offline, fake creds) signs for service bedrock-mantle', async () => {
  const url = bedrockMessagesUrl('us-east-1');
  const headers = await defaultBedrockSigner({
    url, region: 'us-east-1', headers: { 'content-type': 'application/json' }, body: '{}', credentials: FAKE,
  });
  expect(headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIDFAKEFAKEFAKE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/,
  );
  expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  // 서명은 본문 해시를 담는다 — 같은 시각·자격이라도 본문이 바뀌면 서명이 바뀐다.
  const other = await defaultBedrockSigner({
    url, region: 'us-east-1', headers: { 'content-type': 'application/json' }, body: '{"x":1}', credentials: FAKE,
  });
  if (other['x-amz-date'] === headers['x-amz-date']) expect(other.authorization).not.toBe(headers.authorization);
});

test('relayed secret env values are masked by the log text redactor (KEY=value form)', () => {
  const secretKeys = ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_CONTAINER_AUTHORIZATION_TOKEN'];
  for (const k of secretKeys) {
    expect(Object.keys(bedrockChildRelayEnv({ [k]: 'v' }))).toEqual([k]);
    const out = redactSecretText(`${k}=abcdEFGH12345678xyz`);
    expect(out).toBe(`${k}=***`);
  }
  expect(redactSecretText('AKIAABCDEFGHIJKLMNOP')).not.toContain('ABCDEFGHIJKLMNOP');
});

test('credential error names: allow-list passes, anything else becomes a fixed string', async () => {
  const named = (n: unknown) => Object.assign(new Error('x'), { name: n });
  expect(sanitizeCredentialErrorName(named('CredentialsProviderError'))).toBe('CredentialsProviderError');
  expect(sanitizeCredentialErrorName(named('TimeoutError'))).toBe('TimeoutError');
  expect(sanitizeCredentialErrorName(named('AKIAABCDEFGHIJKLMNOP /home/me/.aws'))).toBe('CredentialResolutionError');
  expect(sanitizeCredentialErrorName(named(42))).toBe('CredentialResolutionError');
  expect(sanitizeCredentialErrorName(undefined)).toBe('CredentialResolutionError');
  const err = await buildSignedBedrockRequest({
    region: 'us-east-1', body: {}, env: {},
    resolveCredentials: async () => { throw named('leak-me-profile-work'); },
  }).catch((e) => e);
  expect(err).toBeInstanceOf(BedrockCredentialsUnresolvedError);
  expect(String(err.message)).toContain('CredentialResolutionError');
  expect(String(err.message)).not.toContain('leak-me');
});

test('malicious region values never reach a URL or carry credentials (codex 2R must-fix)', async () => {
  for (const bad of ['us-east-1@evil.example/', 'evil.example#', 'us-east-1.evil.example', 'us-east-1/../x', 'US-EAST-1', '']) {
    expect(validBedrockRegion(bad)).toBeUndefined();
    expect(resolveBedrockRegion({ env: { AWS_REGION: bad }, ...noFiles })).toBeUndefined();
    expect(bedrockAvailable({ env: { AWS_REGION: bad, AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' }, ...noFiles })).toBe(false);
    expect(() => bedrockMessagesUrl(bad)).toThrow(/리전 값/);
    const err = await buildSignedBedrockRequest({ region: bad, body: {}, env: { AWS_BEARER_TOKEN_BEDROCK: 'tok-fake' } }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  }
  // config 파일의 region 도 같은 검증.
  expect(resolveBedrockRegion({ env: {}, readText: () => '[default]\nregion = us-east-1@evil.example\n' })).toBeUndefined();
  for (const good of ['us-east-1', 'ap-northeast-2', 'us-gov-west-1', 'eu-central-2', 'il-central-1']) {
    expect(validBedrockRegion(good)).toBe(good);
  }
});
