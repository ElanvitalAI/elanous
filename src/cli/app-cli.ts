import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { nexusRootDir } from '../nexus/paths.js';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { createAppLifecycleStore, type AppLifecycleStore } from '../nexus/apps/app-db.js';
import { appManifestToOpenApi, serializeOpenApi } from '../nexus/apps/app-openapi.js';
import { createAppSourceSnapshot, restoreAppSourceSnapshot, type AppSourceSnapshotOptions } from '../nexus/apps/app-source-snapshot.js';
import { createObjectStore, readRawConfig, resolveStorageConfig, type ObjectStore } from '../storage/object-store.js';

export interface AppBuildInput {
  readonly appSlug: string;
  readonly deploymentId: string;
  readonly sourceRoot: string;
  readonly expectedFingerprint?: string;
}

export interface AppBuildSource {
  readonly fingerprint: string;
  readonly sourceRevisionId: string;
  readonly sourcePath: string;
}

export interface AppCliDeps {
  readonly appsRoot?: string;
  readonly readFile?: typeof readFileSync;
  readonly objectStore?: Pick<ObjectStore, 'put' | 'get' | 'head' | 'list'>;
  readonly recordSnapshotEvent?: AppSourceSnapshotOptions['record'];
  readonly prepareBuildSource?: (input: AppBuildInput) => AppBuildSource;
  readonly buildFromSource?: (input: AppBuildSource) => void | Promise<void>;
  readonly write?: (text: string) => void;
  readonly error?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly lifecycleStore?: AppLifecycleStore;
}

function defaultObjectStore(): Pick<ObjectStore, 'put' | 'get' | 'head' | 'list'> {
  const configDir = getElanousConfigDir();
  return createObjectStore(resolveStorageConfig(readRawConfig(join(configDir, 'config.json'))));
}

function prepareBuildSource(input: AppBuildInput, store: Pick<ObjectStore, 'put' | 'get' | 'head' | 'list'>,
  record: AppSourceSnapshotOptions['record']): AppBuildSource {
  const snapshotOptions: Omit<AppSourceSnapshotOptions, 'objectStore' | 'record'> = {
    appSlug: input.appSlug,
    deploymentId: input.deploymentId,
    sourceRoot: input.sourceRoot,
  };
  const expectedFingerprint = input.expectedFingerprint
    ?? createAppSourceSnapshot({ ...snapshotOptions, objectStore: store, record }).fingerprint;
  const restored = restoreAppSourceSnapshot({ ...snapshotOptions, objectStore: store, record, expectedFingerprint });
  return { fingerprint: restored.fingerprint, ...restored.nextBuildInput };
}

function runAppBuild(source: AppBuildSource): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'build'], {
      cwd: source.sourcePath,
      env: { ...process.env, ELANOUS_APP_SOURCE_PATH: source.sourcePath, ELANOUS_APP_SOURCE_REVISION_ID: source.sourceRevisionId },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
    child.stdout?.pipe(process.stderr);
    child.once('error', () => reject(new Error('app build failed')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('app build failed')));
  });
}

export function renderAppOpenApi(slug: string, appsRoot: string, readFile: typeof readFileSync = readFileSync): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--') || slug.length > 63) {
    throw new Error('invalid app slug');
  }
  return renderAppOpenApiAt(slug, join(appsRoot, slug), readFile);
}

function renderAppOpenApiAt(slug: string, appDir: string, readFile: typeof readFileSync): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--') || slug.length > 63) {
    throw new Error('invalid app slug');
  }
  const source = readFile(join(appDir, 'app.yaml'), 'utf8');
  const parsed = parseAppManifest(String(source));
  if (!parsed.ok) throw new Error(`invalid app contract (${parsed.errors.map(issue => `${issue.path}: ${issue.reason}`).join('; ')})`);
  if (parsed.manifest.slug !== slug) throw new Error('app slug does not match its directory');
  return serializeOpenApi(appManifestToOpenApi(parsed.manifest));
}

export function registerAppCommands(program: Command, deps: AppCliDeps = {}): void {
  const app = program.command('app').description('Validate and build local app sources');
  app.command('lifecycle <slug>')
    .description('Read the durable app lifecycle history and tile projection')
    .action((slug: string) => {
      const write = deps.write ?? ((text: string) => process.stdout.write(text));
      const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
      const owned = !deps.lifecycleStore;
      const lifecycle = deps.lifecycleStore ?? createAppLifecycleStore();
      try {
        write(`${JSON.stringify({ appSlug: slug, ...lifecycle.view(slug) })}\n`);
      } catch (error) {
        process.stderr.write(`app lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
        setExitCode(1);
      } finally { if (owned) lifecycle.close(); }
    });
  app.command('openapi <slug>')
    .description('Generate deterministic OpenAPI 3.1 JSON from a local app contract')
    .action((slug: string) => {
      const write = deps.write ?? ((text: string) => process.stdout.write(text));
      const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
      try {
        write(renderAppOpenApi(slug, deps.appsRoot ?? join(nexusRootDir(), 'apps'), deps.readFile));
      } catch (error) {
        process.stderr.write(`app openapi: ${error instanceof Error ? error.message : String(error)}\n`);
        setExitCode(1);
      }
    });

  app.command('build <slug>')
    .description('Build one app from a verified immutable source snapshot')
    .requiredOption('--deployment-id <id>', 'deployment revision id')
    .option('--fingerprint <sha256>', 'reuse an existing source snapshot fingerprint')
    .action(async (slug: string, options: { deploymentId: string; fingerprint?: string }) => {
      const write = deps.write ?? ((text: string) => process.stdout.write(text));
      const error = deps.error ?? ((text: string) => process.stderr.write(text));
      const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
      try {
        const appsRoot = deps.appsRoot ?? join(nexusRootDir(), 'apps');
        const record = deps.recordSnapshotEvent ?? ((entry: Parameters<AppSourceSnapshotOptions['record']>[0]) => {
          debug.log('nexus.app.source-snapshot', entry.kind, { ...entry });
        });
        const source = (deps.prepareBuildSource ?? ((input) => prepareBuildSource(input, deps.objectStore ?? defaultObjectStore(), record)))({
          appSlug: slug,
          deploymentId: options.deploymentId,
          sourceRoot: join(appsRoot, slug),
          ...(options.fingerprint !== undefined ? { expectedFingerprint: options.fingerprint } : {}),
        });
        renderAppOpenApiAt(slug, source.sourcePath, deps.readFile ?? readFileSync);
        await (deps.buildFromSource ?? runAppBuild)(source);
        write(`${JSON.stringify({ appSlug: slug, deploymentId: options.deploymentId, fingerprint: source.fingerprint,
          sourceRevisionId: source.sourceRevisionId, sourcePath: source.sourcePath })}\n`);
      } catch (caught) {
        error(`app build: ${caught instanceof Error ? caught.message : String(caught)}\n`);
        setExitCode(1);
      }
    });
}
