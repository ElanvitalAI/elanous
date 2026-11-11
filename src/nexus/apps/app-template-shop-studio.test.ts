import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseAppManifest } from './app-contract.js';
import { createAppDatabase } from './app-db.js';
import { createAppActions, handleAppActionRequest, type AppActionDeclaration } from './app-actions.js';

const manifestPath = resolve(import.meta.dir, '../../../templates/next-app-shop-studio/app.yaml');

test('APP-TEMPLATE-SHOP-STUDIO serves created products publicly and queues owner-confirmed ad generation', async () => {
  const source = readFileSync(manifestPath, 'utf8');
  const parsed = parseAppManifest(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const manifest = parsed.manifest;
  const directory = mkdtempSync(join(tmpdir(), 'shop-studio-app-contract-'));
  const database = createAppDatabase([manifest], { directory });
  try {
    database.rpc('shop-studio', 'addProduct', {
      id: 'mug-1', title: '손으로 빚은 찻잔', description: '유약을 입혀 구운 찻잔',
      price_label: '28000원', image_key: 'apps/shop-studio/products/mug-1.png',
    }, 'owner');
    const publicProducts = database.rpc('shop-studio', 'listProducts', { limit: 50 }, 'public') as Array<Record<string, unknown>>; // Source: 내부 문서 `app-yaml-contract` §1 limit default.
    expect(publicProducts).toEqual([
      { id: 'mug-1', title: '손으로 빚은 찻잔', description: '유약을 입혀 구운 찻잔',
        price_label: '28000원', image_key: 'apps/shop-studio/products/mug-1.png', created_at: expect.any(String) },
    ]);
    expect(() => database.rpc('shop-studio', 'addProduct', {
      id: 'public-forbidden', title: '권한 없는 등록', description: '거부되어야 함',
      price_label: '0원', image_key: 'apps/shop-studio/products/forbidden.png',
    }, 'public')).toThrow();

    const generated: unknown[] = [];
    const actionImage = String(publicProducts[0]!.image_key).replace('apps/shop-studio/', '');
    expect(actionImage).toBe('products/mug-1.png');
    const readReferences: string[] = [];
    const action = manifest.actions?.makeAd;
    expect(action).toBeDefined();
    const actions = createAppActions({
      secrets: { async resolve({ reference }) { return reference.endsWith('key_id') ? 'fake-key-id' : 'fake-secret'; } },
      readImageObject: async ({ appSlug, reference }) => {
        readReferences.push(reference);
        return appSlug === 'shop-studio' && reference === actionImage
          ? { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } : undefined;
      },
      generate: async (input) => {
        generated.push(input);
        return { jobId: 'fake-job-1', eventsUrl: '/v1/apps/shop-studio/jobs/fake-job-1/events' };
      },
    });
    const declaration = action as unknown as AppActionDeclaration;
    let role: 'owner' | 'public' = 'public';
    const runtime = {
      async authorize(_request: Request, appSlug: string) { return role === 'owner' && appSlug === 'shop-studio'; },
      async getDeclaration(appSlug: string, name: string) { return appSlug === 'shop-studio' && name === 'makeAd' ? declaration : undefined; },
      async run(input: Parameters<typeof actions.run>[0]) { return actions.run(input); },
    };
    const request = (confirmSpend?: boolean) => handleAppActionRequest(new Request('http://nexus.invalid/v1/apps/shop-studio/actions/makeAd', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: actionImage, text: '찻잔의 잔잔한 표면을 보여 줘', ...(confirmSpend === undefined ? {} : { confirmSpend }) }),
    }), runtime);
    const publicResponse = await request(true);
    expect(publicResponse?.status).toBe(401);
    expect(generated).toHaveLength(0);
    role = 'owner';
    const unconfirmedResponse = await request();
    expect(unconfirmedResponse?.status).toBe(400);
    expect(generated).toHaveLength(0);
    const ownerResponse = await request(true);
    expect(ownerResponse?.status).toBe(202);
    const queued = await ownerResponse?.json();
    expect(queued).toEqual({ ok: true, jobId: 'fake-job-1', status: 'queued', eventsUrl: '/v1/apps/shop-studio/jobs/fake-job-1/events' });
    expect(generated).toHaveLength(1);
    expect(readReferences).toEqual([actionImage]);
    expect(JSON.stringify(queued)).not.toContain('fake-secret');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('APP-TEMPLATE-SHOP-STUDIO simulation declares fake-only device profiles and a product flow receipt', () => {
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as {
    simulate?: { connectors?: Record<string, { fake?: string; profile?: string }>; scenarios?: Array<{
      name: string; steps: Array<{ rpc?: string; as?: string }>; expect: Array<Record<string, unknown>>;
    }> };
  };
  expect(manifest.simulate?.connectors).toEqual({
    makeAd: { fake: 'generate-job', profile: 'ok' }, storage: { fake: 'object-store', profile: 'ok' },
  });
  const scenario = manifest.simulate?.scenarios?.[0];
  expect(scenario?.name).toBe('상품 등록과 공개 목록');
  expect(scenario?.steps.map((step) => `${step.rpc}:${step.as}`)).toEqual(['addProduct:owner', 'listProducts:public']);
  expect(scenario?.expect.map((item) => Object.values(item)[0])).toEqual([
    'rpc.addProduct.completed', 'rpc.listProducts.completed', 'products',
  ]);
  expect(scenario?.expect[2]).toEqual({ table: 'products', rows: 1 });
});
