import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { nexusRootDir } from '../nexus/paths.js';
import { parseAppManifest } from '../nexus/apps/app-contract.js';
import { appManifestToOpenApi, serializeOpenApi } from '../nexus/apps/app-openapi.js';

export interface AppCliDeps {
  readonly appsRoot?: string;
  readonly readFile?: typeof readFileSync;
  readonly write?: (text: string) => void;
  readonly setExitCode?: (code: number) => void;
}

export function renderAppOpenApi(slug: string, appsRoot: string, readFile: typeof readFileSync = readFileSync): string {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.includes('--') || slug.length > 63) {
    throw new Error('invalid app slug');
  }
  const source = readFile(join(appsRoot, slug, 'app.yaml'), 'utf8');
  const parsed = parseAppManifest(String(source));
  if (!parsed.ok) throw new Error(`invalid app contract (${parsed.errors.map(issue => `${issue.path}: ${issue.reason}`).join('; ')})`);
  if (parsed.manifest.slug !== slug) throw new Error('app slug does not match its directory');
  return serializeOpenApi(appManifestToOpenApi(parsed.manifest));
}

export function registerAppCommands(program: Command, deps: AppCliDeps = {}): void {
  const app = program.command('app').description('Validate and inspect local app contracts');
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
}
