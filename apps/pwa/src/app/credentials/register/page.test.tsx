import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { CredentialRegisterView } from './CredentialRegisterView';
import { CredentialClaimView } from './claim/CredentialClaimView';
import CredentialClaimPage from './claim/page';
import CredentialRegisterPage from './page';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { createNexusClient, type CredentialSlotWire } from '@/nexus/client';
import { createFakeCred } from '../../../../../../src/ux-sim/fake-cred';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function decodeQrDataUri(source: string) {
  const svg = decodeURIComponent(source.replace(/^data:image\/svg\+xml,/, ''));
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
}

const slot: CredentialSlotWire = { id: 'cred:openai.api_key', label: 'OpenAI', present: false, lastCheckedAt: null,
  registerable: true, registrationPath: '/credentials/register', healthStatus: 'missing', healthLabel: '없음' };

test('fake registration exchanges one-use link and writes only with its scoped bearer', async () => {
  const secret = 'fake-key-never-in-receipt';
  const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-token', fetchImpl: (async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if (url.pathname === '/v1/credentials/registration-links') return Response.json({ slot: slot.id,
      url: 'https://nexus.example.test/app/credentials/register/claim/#t=els_fake-one-use', expiresAt: 1 });
    if (url.pathname === '/v1/setup/credential-claim') return Response.json({ slot: slot.id, bearer: 'scoped-bearer' });
    if (url.pathname === '/v1/setup/credential-register') return Response.json({ saved: true, slot: slot.id, verification: 'verified', value: secret });
    throw new Error('unexpected request');
  }) as typeof fetch });
  const result = await client.registerCredentialSlot(slot.id, secret);
  expect(result).toEqual({ saved: true, slot: slot.id, verification: 'verified' });
  expect(calls.map(({ path, authorization }) => ({ path, authorization }))).toEqual([
    { path: '/v1/credentials/registration-links', authorization: 'Bearer owner-token' },
    { path: '/v1/setup/credential-claim', authorization: null },
    { path: '/v1/setup/credential-register', authorization: 'Bearer scoped-bearer' },
  ]);
  expect(calls[2]?.body).toEqual({ slot: slot.id, value: secret });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('owner registration view creates a QR link without displaying or storing a credential value', async () => {
  const claimUrl = 'https://nexus.example.test/app/credentials/register/claim/#t=fake-link';
  let created = 0;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => { created++; return { slot: id, url: claimUrl, expiresAt: Date.now() + 60_000 }; }}
    revokeLink={async () => ({ revoked: true })} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('휴대폰 등록 QR');
  expect(rendered).toContain('data:image/svg+xml');
  expect(rendered).not.toContain('fake-link');
  expect(tree.root.findAllByType('input')).toHaveLength(0);
  expect(created).toBe(1);
  expect((await decodeQrDataUri(tree.root.findByType('img').props.src))?.data).toBe(claimUrl);
  await act(async () => tree.unmount());
});

test('QR encoding failure gives the owner an explicit retry action', async () => {
  let linkCount = 0;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => { linkCount++; return { slot: id, url: 'https://nexus.example.test/app/credentials/register/claim/#t=retry-link', expiresAt: Date.now() + 60_000 }; }}
    revokeLink={async () => ({ revoked: true })}
    encodeQr={async () => { throw new Error('encoder unavailable'); }} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(JSON.stringify(tree.toJSON())).toContain('QR을 만들지 못했습니다');
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === 'QR 다시 만들기')!.props.onClick(); await Promise.resolve(); });
  expect(linkCount).toBe(2);
  await act(async () => tree.unmount());
});

test('owner can revoke a current QR and the one-use token is cleared from the view', async () => {
  let revokedToken = '';
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => ({ slot: id, url: 'https://nexus.example.test/app/credentials/register/claim/#t=cancel-this-link', expiresAt: Date.now() + 60_000 })}
    revokeLink={async (token) => { revokedToken = token; return { revoked: true }; }} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '현재 QR 폐기')!.props.onClick(); await Promise.resolve(); });
  expect(revokedToken).toBe('cancel-this-link');
  expect(JSON.stringify(tree.toJSON())).not.toContain('cancel-this-link');
  expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('failed QR replacement preserves its active link until the owner can retry revocation', async () => {
  let revokeCount = 0;
  let createCount = 0;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => ({ slot: id, url: `https://nexus.example.test/app/credentials/register/claim/#t=retry-${++createCount}`, expiresAt: Date.now() + 60_000 })}
    revokeLink={async () => { if (++revokeCount === 1) throw new Error('temporary failure'); return { revoked: true }; }} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '새 QR 만들기')!.props.onClick(); await Promise.resolve(); });
  expect(JSON.stringify(tree.toJSON())).toContain('링크를 폐기하지 못했습니다');
  expect(JSON.stringify(tree.toJSON())).toContain('휴대폰 등록 QR');
  expect(createCount).toBe(1);
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '새 QR 만들기')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(revokeCount).toBe(2);
  expect(createCount).toBe(2);
  await act(async () => tree.unmount());
});

test('failed QR replacement after successful revocation leaves the owner a retry action', async () => {
  let createCount = 0;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => { createCount++; if (createCount === 2) throw new Error('temporary issue');
      return { slot: id, url: `https://nexus.example.test/app/credentials/register/claim/#t=retry-after-revoke-${createCount}`, expiresAt: Date.now() + 60_000 }; }}
    revokeLink={async () => ({ revoked: true })} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '새 QR 만들기')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  expect(JSON.stringify(tree.toJSON())).toContain('등록 링크를 만들지 못했습니다');
  expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(0);
  expect(tree.root.findByType('button').props.children).toBe('휴대폰 등록 QR 만들기');
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('QR revocation and replacement cannot race', async () => {
  let finishRevoke!: (result: { revoked: true }) => void;
  let createCount = 0;
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId={slot.id} load={async () => ({ credentials: [slot] })}
    createLink={async (id) => ({ slot: id, url: `https://nexus.example.test/app/credentials/register/claim/#t=race-${++createCount}`, expiresAt: Date.now() + 60_000 })}
    revokeLink={() => new Promise((resolve) => { finishRevoke = resolve; })} />); await Promise.resolve(); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '현재 QR 폐기')!.props.onClick(); await Promise.resolve(); });
  const replace = tree.root.findAllByType('button').find((button) => button.props.children === '새 QR 만들기')!;
  expect(replace.props.disabled).toBe(true);
  replace.props.onClick();
  expect(createCount).toBe(1);
  await act(async () => { finishRevoke({ revoked: true }); await Promise.resolve(); });
  expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a mismatched link cannot claim or submit a credential value', async () => {
  const paths: string[] = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-token', fetchImpl: (async (input) => {
    paths.push(new URL(String(input)).pathname);
    return Response.json({ slot: 'cred:elevenlabs.api_key', url: 'https://nexus.example.test/app/credentials/register/claim/#t=els_wrong' });
  }) as typeof fetch });
  await expect(client.registerCredentialSlot(slot.id, 'fake-value')).rejects.toThrow('자격 등록 링크를 확인할 수 없습니다.');
  expect(paths).toEqual(['/v1/credentials/registration-links']);
});

test('owner client revokes the one-use token with the owner session', async () => {
  const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-session', fetchImpl: (async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    return Response.json({ revoked: true });
  }) as typeof fetch });
  await expect(client.revokeCredentialRegistrationLink('one-use-link-token')).resolves.toEqual({ revoked: true });
  expect(calls).toEqual([{ path: '/v1/credentials/registration-links/revoke', authorization: 'Bearer owner-session', body: { t: 'one-use-link-token' } }]);
});

test('relative Nexus base URL validates the registration link against the browser origin', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://nexus.example.test/credentials/' } } });
  try {
    const client = createNexusClient({ baseUrl: '/', fetchImpl: (async (input) => {
      const path = new URL(String(input), 'https://nexus.example.test').pathname;
      if (path === '/v1/credentials/registration-links') return Response.json({ slot: slot.id,
        url: 'https://nexus.example.test/app/credentials/register/claim/#t=els_relative', expiresAt: Date.now() + 60_000 });
      if (path === '/v1/setup/credential-claim') return Response.json({ slot: slot.id, bearer: 'scoped' });
      return Response.json({ saved: true, slot: slot.id, verification: 'verified' });
    }) as typeof fetch });
    expect(await client.registerCredentialSlot(slot.id, 'fake-value')).toEqual({ saved: true, slot: slot.id, verification: 'verified' });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('simulated owner QR to phone claim writes through a one-use scoped bearer without storing the credential value', async () => {
  const secret = 'simulated-phone-credential-never-persisted';
  const paths: Array<{ path: string; authorization: string | null }> = [];
  const fakeCred = createFakeCred({ now: () => 10_000 });
  let linkClaimed = false;
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    paths.push({ path: url.pathname, authorization });
    if (url.pathname === '/v1/credentials/registration-links') return Response.json({ slot: slot.id,
      url: 'https://nexus.example.test/app/credentials/register/claim/#t=one-use-fake-link', expiresAt: 20_000 });
    if (url.pathname === '/v1/setup/credential-claim') {
      expect(authorization).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({ t: 'one-use-fake-link' });
      if (linkClaimed) return Response.json({ error: 'replayed' }, { status: 401 });
      linkClaimed = true;
      return Response.json({ slot: slot.id, label: 'OpenAI', setupUrl: 'https://provider.example.test/key', bearer: 'one-use-scoped-bearer', expiresAt: 15_000 });
    }
    if (url.pathname === '/v1/setup/credential-register') {
      expect(authorization).toBe('Bearer one-use-scoped-bearer');
      expect(JSON.parse(String(init?.body))).toEqual({ slot: slot.id, value: secret });
      fakeCred.install(slot.id, { permissions: ['invoke'], expiresAt: 15_000 });
      return Response.json({ saved: true, slot: slot.id, verification: 'verified', value: secret });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  }) as typeof fetch;
  const owner = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-session', fetchImpl });
  const phone = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl });
  const link = await owner.createCredentialRegistrationLink(slot.id);
  const token = new URL(link.url).hash.slice(1).replace(/^t=/, '');
  const claim = await phone.claimCredentialRegistrationLink(token);
  const receipt = await phone.submitCredentialRegistration(claim.slot, claim.bearer, secret);
  expect(receipt).toEqual({ saved: true, slot: slot.id, verification: 'verified' });
  expect(paths.slice(0, 3)).toEqual([
    { path: '/v1/credentials/registration-links', authorization: 'Bearer owner-session' },
    { path: '/v1/setup/credential-claim', authorization: null },
    { path: '/v1/setup/credential-register', authorization: 'Bearer one-use-scoped-bearer' },
  ]);
  expect(fakeCred.inspect(slot.id)).toEqual({ present: true, generation: 1, expiresAt: 15_000, permissions: ['invoke'] });
  expect(JSON.stringify({ link, claim: { ...claim, bearer: '[redacted]' }, receipt, inventory: fakeCred.inspect(slot.id) })).not.toContain(secret);
  await expect(phone.claimCredentialRegistrationLink(token)).rejects.toThrow();
});

test('phone claim route uses the Nexus context client to claim and register against the fake credential device', async () => {
  const secret = 'phone-route-secret-canary';
  const fakeCred = createFakeCred({ now: () => Date.now() });
  let claimed = false;
  let claimRequests = 0;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { pathname: '/app/credentials/register/claim/', search: '', hash: '' };
  let historyUrl = '';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location,
    history: { replaceState: (_state: unknown, _title: string, url: string) => { historyUrl = String(url); location.hash = ''; } },
  } });
  let tree!: ReturnType<typeof create>;
  try {
    const fetchImpl = (async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.pathname === '/v1/credentials/registration-links') return Response.json({ slot: slot.id,
        url: 'https://nexus.example.test/app/credentials/register/claim/#t=route-one-use-token', expiresAt: Date.now() + 60_000 });
      if (url.pathname === '/v1/setup/credential-claim') {
        claimRequests++;
        expect(authorization).toBeNull();
        expect(JSON.parse(String(init?.body))).toEqual({ t: 'route-one-use-token' });
        if (claimed) return Response.json({ error: 'replayed' }, { status: 401 });
        claimed = true;
        return Response.json({ slot: slot.id, label: slot.label, setupUrl: 'https://provider.example.test/key', bearer: 'phone-scoped-bearer', expiresAt: Date.now() + 60_000 });
      }
      if (url.pathname === '/v1/setup/credential-register') {
        expect(authorization).toBe('Bearer phone-scoped-bearer');
        expect(JSON.parse(String(init?.body))).toEqual({ slot: slot.id, value: secret });
        fakeCred.install(slot.id, { permissions: ['invoke'], expiresAt: Date.now() + 60_000 });
        return Response.json({ saved: true, slot: slot.id, verification: 'verified', value: secret });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch;
    const owner = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-session', fetchImpl });
    const link = await owner.createCredentialRegistrationLink(slot.id);
    location.hash = new URL(link.url).hash;
    const phone = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl });
    await act(async () => { tree = create(<NexusProvider client={phone}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); });
    expect(historyUrl).toBe('/app/credentials/register/claim/');
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: secret } }));
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('저장했습니다');
    expect(JSON.stringify(tree.toJSON())).not.toContain(secret);
    expect(JSON.stringify(tree.toJSON())).not.toContain('phone-scoped-bearer');
    expect(fakeCred.inspect(slot.id).present).toBe(true);
    await act(async () => tree.unmount());
    await act(async () => { tree = create(<CredentialClaimPage />); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('링크가 없습니다');
    expect(claimRequests).toBe(1);
    await act(async () => tree.unmount());
    await expect(phone.claimCredentialRegistrationLink('route-one-use-token')).rejects.toThrow();
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('phone claim route reuses an in-flight claim after the Nexus client temporarily disappears', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { pathname: '/app/credentials/register/claim/', search: '', hash: '#t=survive-client-reconnect' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location,
    history: { replaceState: (_state: unknown, _title: string, url: string) => { location.hash = ''; } } } });
  let finishClaim!: (response: Response) => void;
  let claimCalls = 0;
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl: (async () => {
    claimCalls++;
    return await new Promise<Response>((resolve) => { finishClaim = resolve; });
  }) as unknown as typeof fetch });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<NexusProvider client={client}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    expect(claimCalls).toBe(1);
    await act(async () => { tree.update(<NexusProvider client={null}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('넥서스 연결을 기다리고 있습니다');
    finishClaim(Response.json({ slot: slot.id, label: slot.label, setupUrl: 'https://provider.example.test/key', bearer: 'reused-bearer', expiresAt: Date.now() + 60_000 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { tree.update(<NexusProvider client={client}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByType('input')).toHaveLength(1);
    expect(claimCalls).toBe(1);
  } finally {
    await act(async () => tree?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('phone save result survives a Nexus disconnect and reconnect', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { pathname: '/app/credentials/register/claim/', search: '', hash: '#t=save-across-reconnect' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location,
    history: { replaceState: (_state: unknown, _title: string, _url: string) => { location.hash = ''; } } } });
  let finishSave!: (response: Response) => void;
  let claimCalls = 0;
  let saveCalls = 0;
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl: (async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/setup/credential-claim') {
      claimCalls++;
      return Response.json({ slot: slot.id, label: slot.label, setupUrl: 'https://provider.example.test/key', bearer: 'reconnect-bearer', expiresAt: Date.now() + 60_000 });
    }
    if (path === '/v1/setup/credential-register') {
      saveCalls++;
      return await new Promise<Response>((resolve) => { finishSave = resolve; });
    }
    throw new Error(`unexpected path ${path}`);
  }) as typeof fetch });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<NexusProvider client={client}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'reconnect-secret' } }));
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
    expect(saveCalls).toBe(1);
    await act(async () => { tree.update(<NexusProvider client={null}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('저장 중…');
    finishSave(Response.json({ saved: true, slot: slot.id, verification: 'verified' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('저장했습니다');
    await act(async () => { tree.update(<NexusProvider client={client}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); });
    expect(JSON.stringify(tree.toJSON())).toContain('저장했습니다');
    expect(claimCalls).toBe(1);
    expect(saveCalls).toBe(1);
  } finally {
    await act(async () => tree?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('owner QR survives reconnect, replaces after reconnect, and completes an in-flight revoke on disconnect', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { pathname: '/app/credentials/register/', search: `?slot=${encodeURIComponent(slot.id)}`, hash: '' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location } });
  let revokeCalls = 0;
  let createCalls = 0;
  let finishRevoke!: (response: Response) => void;
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-session', fetchImpl: (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/credentials/slots') return Response.json({ credentials: [slot] });
    if (url.pathname === '/v1/credentials/registration-links') return Response.json({ slot: slot.id,
      url: `https://nexus.example.test/app/credentials/register/claim/#t=owner-reconnect-${++createCalls}`, expiresAt: Date.now() + 60_000 });
    if (url.pathname === '/v1/credentials/registration-links/revoke') {
      revokeCalls++;
      if (revokeCalls === 2) return await new Promise<Response>((resolve) => { finishRevoke = resolve; });
      return Response.json({ revoked: true });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  }) as typeof fetch });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<NexusProvider client={client}><CredentialRegisterPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { tree.root.findByType('button').props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
    await act(async () => { tree.update(<NexusProvider client={null}><CredentialRegisterPage /></NexusProvider>); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
    await act(async () => { tree.update(<NexusProvider client={client}><CredentialRegisterPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
    await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '새 QR 만들기')!.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    expect(revokeCalls).toBe(1);
    expect(createCalls).toBe(2);
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
    await act(async () => { tree.root.findAllByType('button').find((button) => button.props.children === '현재 QR 폐기')!.props.onClick(); await Promise.resolve(); });
    await act(async () => { tree.update(<NexusProvider client={null}><CredentialRegisterPage /></NexusProvider>); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(1);
    finishRevoke(Response.json({ revoked: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(tree.root.findAllByProps({ 'aria-label': '휴대폰 등록 QR' })).toHaveLength(0);
    await act(async () => { tree.update(<NexusProvider client={client}><CredentialRegisterPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    expect(revokeCalls).toBe(2);
    expect(tree.root.findByType('button').props.children).toBe('휴대폰 등록 QR 만들기');
  } finally {
    await act(async () => tree?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('claim route removes the fragment before Nexus is available', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const location = { pathname: '/app/credentials/register/claim/', search: '', hash: '#t=slow-client-token' };
  let historyUrl = '';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location,
    history: { replaceState: (_state: unknown, _title: string, url: string) => { historyUrl = String(url); location.hash = ''; } },
  } });
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<CredentialClaimPage />); await Promise.resolve(); });
    expect(historyUrl).toBe('/app/credentials/register/claim/');
    expect(location.hash).toBe('');
    expect(JSON.stringify(tree.toJSON())).toContain('넥서스 연결을 기다리고 있습니다');
    await act(async () => tree.unmount());
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('claim request is reused when the effect reruns and saved values and bearer are cleared', async () => {
  const secret = 'phone-secret-canary-not-persisted';
  let tree!: ReturnType<typeof create>;
  let claimCalls = 0;
  let savedBearer = '';
  const claimLink = async (_token: string) => {
    claimCalls++;
    return { slot: slot.id, label: slot.label, setupUrl: 'https://provider.example.test/key', bearer: 'scoped-bearer', expiresAt: Date.now() + 60_000 };
  };
  const register = async (_slot: string, bearer: string, value: string) => {
    savedBearer = bearer;
    expect(value).toBe(secret);
    return { saved: true as const, slot: slot.id, verification: 'verified' as const };
  };
  await act(async () => { tree = create(<CredentialClaimView token="one-time-claim-token" claimLink={claimLink} register={register} />); await Promise.resolve(); });
  await act(async () => { tree.update(<CredentialClaimView token="one-time-claim-token" claimLink={async (token) => claimLink(token)} register={register} />); await Promise.resolve(); });
  expect(claimCalls).toBe(1);
  await act(async () => tree.root.findByType('input').props.onChange({ target: { value: secret } }));
  await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
  expect(savedBearer).toBe('scoped-bearer');
  expect(JSON.stringify(tree.toJSON())).toContain('저장했습니다');
  expect(JSON.stringify(tree.toJSON())).not.toContain(secret);
  expect(JSON.stringify(tree.toJSON())).not.toContain('scoped-bearer');
  expect(tree.root.findAllByType('input')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('claim page never writes the credential or bearer to browser storage and clears them after save', async () => {
  const secret = 'storage-canary-credential-value';
  const bearer = 'storage-canary-scoped-bearer';
  const writes: string[] = [];
  const storage = (name: string) => ({
    getItem: (_key: string) => null,
    setItem: (_key: string, _value: string) => { writes.push(`${name}.setItem`); },
    removeItem: (_key: string) => { writes.push(`${name}.removeItem`); },
    clear: () => { writes.push(`${name}.clear`); },
    key: (_index: number) => null,
    get length() { return 0; },
  });
  const local = storage('localStorage');
  const session = storage('sessionStorage');
  const indexedDB = {
    open: () => { writes.push('indexedDB.open'); throw new Error('unexpected IndexedDB access'); },
    deleteDatabase: () => { writes.push('indexedDB.deleteDatabase'); throw new Error('unexpected IndexedDB access'); },
  };
  const previous = new Map<string, PropertyDescriptor | undefined>(['window', 'localStorage', 'sessionStorage', 'indexedDB']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const location = { pathname: '/app/credentials/register/claim/', search: '', hash: '#t=storage-canary-link' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location, localStorage: local, sessionStorage: session, indexedDB,
    history: { replaceState: (_state: unknown, _title: string, _url: string) => { location.hash = ''; } },
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
  let tree!: ReturnType<typeof create>;
  try {
    const client = createNexusClient({ baseUrl: 'https://nexus.example.test', fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/setup/credential-claim') return Response.json({ slot: slot.id, label: slot.label,
        setupUrl: 'https://provider.example.test/key', bearer, expiresAt: Date.now() + 60_000 });
      if (path === '/v1/setup/credential-register') {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
        expect(JSON.parse(String(init?.body))).toEqual({ slot: slot.id, value: secret });
        return Response.json({ saved: true, slot: slot.id, verification: 'verified' });
      }
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch });
    await act(async () => { tree = create(<NexusProvider client={client}><CredentialClaimPage /></NexusProvider>); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: secret } }));
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); await Promise.resolve(); });
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('저장했습니다');
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(bearer);
    expect(tree.root.findAllByType('input')).toHaveLength(0);
    expect(writes).toEqual([]);
  } finally {
    await act(async () => tree?.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a changing claim client cannot undo a save in progress', async () => {
  const secret = 'pending-save-secret';
  let finishSave!: (result: { saved: true; slot: string; verification: 'verified' }) => void;
  let claimCalls = 0;
  let tree!: ReturnType<typeof create>;
  const claimLink = async () => { claimCalls++; return { slot: slot.id, label: slot.label, setupUrl: 'https://provider.example.test/key', bearer: 'saving-bearer', expiresAt: Date.now() + 60_000 }; };
  const register = async () => await new Promise<{ saved: true; slot: string; verification: 'verified' }>((resolve) => { finishSave = resolve; });
  await act(async () => { tree = create(<CredentialClaimView token="saving-token" claimLink={claimLink} register={register} />); await Promise.resolve(); });
  await act(async () => tree.root.findByType('input').props.onChange({ target: { value: secret } }));
  await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
  await act(async () => { tree.update(<CredentialClaimView token="saving-token" claimLink={async () => ({ slot: slot.id, label: slot.label,
    setupUrl: 'https://provider.example.test/key', bearer: 'duplicate-bearer', expiresAt: Date.now() + 60_000 })} register={register} />); await Promise.resolve(); });
  expect(JSON.stringify(tree.toJSON())).toContain('저장 중…');
  expect(claimCalls).toBe(1);
  await act(async () => { finishSave({ saved: true, slot: slot.id, verification: 'verified' }); await Promise.resolve(); });
  expect(JSON.stringify(tree.toJSON())).toContain('저장했습니다');
  await act(async () => tree.unmount());
});

test('registration-link API refuses a QR target outside the same Nexus claim route', async () => {
  const client = createNexusClient({ baseUrl: 'https://nexus.example.test', token: 'owner-session', fetchImpl: (async () =>
    Response.json({ slot: slot.id, url: 'https://evil.example.test/steal/#t=one-time-secret', expiresAt: Date.now() + 60_000 })) as unknown as typeof fetch });
  await expect(client.createCredentialRegistrationLink(slot.id)).rejects.toThrow('자격 등록 링크를 확인할 수 없습니다.');
});

test('failed phone save discards the scoped bearer and credential input', async () => {
  let tree!: ReturnType<typeof create>;
  try {
    await act(async () => { tree = create(<CredentialClaimView token="failed-save-token"
      claimLink={async () => ({ slot: slot.id, label: slot.label, setupUrl: '', bearer: 'scoped-failure-bearer', expiresAt: Date.now() + 60_000 })}
      register={async () => { throw new Error('scoped bearer already consumed'); }} />); await Promise.resolve(); });
    await act(async () => tree.root.findByType('input').props.onChange({ target: { value: 'failed-secret' } }));
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); await Promise.resolve(); });
    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain('새 QR을 요청');
    expect(rendered).not.toContain('scoped-failure-bearer');
    expect(rendered).not.toContain('failed-secret');
    expect(tree.root.findAllByType('input')).toHaveLength(0);
  } finally {
    await act(async () => tree?.unmount());
  }
});

test('unsupported slot has no value field or submit action', async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<CredentialRegisterView slotId="cred:higgsfield.secret"
    load={async () => ({ credentials: [{ ...slot, id: 'cred:higgsfield.secret', registerable: false, registrationPath: null }] })}
    createLink={async () => { throw new Error('must not issue'); }} revokeLink={async () => ({ revoked: true })} />); await Promise.resolve(); });
  expect(JSON.stringify(tree.toJSON())).toContain('등록할 수 없는 슬롯');
  expect(tree.root.findAllByType('input')).toHaveLength(0);
  await act(async () => tree.unmount());
});
