import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { signCatalogPayload, type SignedCatalogPayload } from '../src/registry/catalog-server.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const keyPath = option('--key-file') ?? process.env.ELANOUS_CATALOG_SIGNING_KEY_FILE;
if (!keyPath) throw new Error('Pass --key-file or ELANOUS_CATALOG_SIGNING_KEY_FILE (private key is read only and never printed).');
const root = mkdtempSync(join(tmpdir(), 'elanous-catalog-build-'));
const envKeys = ['NODE_ENV', 'ELANOUS_STATE_DIR', 'ELANOUS_CATALOG_SERVER_CACHE', 'ELANOUS_CATALOG_PUBLIC_KEY_FILE', 'ELANOUS_CATALOG_DISCOVERY_SNAPSHOT'];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const previousConfigDir = getElanousConfigDirOverride();
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.ELANOUS_STATE_DIR = root;
setElanousConfigDir(root);
try {
  const { getCatalog } = await import('../src/registry/loader.js');
  const versionDoc = parseYaml(readFileSync(resolve('catalog/meta/catalogVersion.yaml'), 'utf8')) as { catalogVersion?: unknown };
  if (!Number.isSafeInteger(versionDoc.catalogVersion) || (versionDoc.catalogVersion as number) < 1) {
    throw new Error('catalog/meta/catalogVersion.yaml must contain a positive integer catalogVersion.');
  }
  const catalog = getCatalog();
  const payload: SignedCatalogPayload = {
    catalogVersion: versionDoc.catalogVersion as number,
    generatedAt: new Date().toISOString(),
    providers: [...catalog.providers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    models: [...catalog.models.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const signed = signCatalogPayload(payload, readFileSync(resolve(keyPath)));
  const outPath = resolve(option('--out') ?? 'dist/catalog/catalog.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  console.log(`Wrote signed catalog v${payload.catalogVersion}: ${outPath}`);
} finally {
  resetElanousConfigDir();
  if (previousConfigDir) setElanousConfigDir(previousConfigDir);
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
