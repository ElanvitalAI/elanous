import { cp, lstat, mkdir, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type StaticGenerationStage = 'prepared' | 'before-swap' | 'after-swap';

export interface PublishStaticGenerationOptions {
  copyDirectory?: (source: string, destination: string) => Promise<void>;
  validateGeneration?: (generation: string) => Promise<void>;
  renamePointer?: (temporaryLink: string, out: string) => Promise<void>;
  onStage?: (stage: StaticGenerationStage) => void;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: true });
}

export async function validateStaticGeneration(generation: string): Promise<void> {
  const index = await lstat(path.join(generation, 'index.html'));
  if (!index.isFile()) throw new Error(`Static generation is missing a regular index.html: ${generation}`);

  const assets = await lstat(path.join(generation, '_next'));
  if (!assets.isDirectory() || (await readdir(path.join(generation, '_next'))).length === 0) {
    throw new Error(`Static generation is missing Next.js assets in _next: ${generation}`);
  }
}

async function assertOutCanBeReplaced(out: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!entry.isSymbolicLink()) {
    throw new Error(`Cannot replace ${out}: existing out is not a symlink; stop the service and migrate it explicitly`);
  }
  try {
    await stat(out);
  } catch {
    throw new Error(`Cannot replace ${out}: existing out is a broken symlink`);
  }
}

export async function publishStaticGeneration(
  sourceDirectory: string,
  publishRoot: string,
  options: PublishStaticGenerationOptions = {},
): Promise<string> {
  const source = path.resolve(sourceDirectory);
  const root = path.resolve(publishRoot);
  const generations = path.join(root, '.pwa-generations');
  const out = path.join(root, 'out');
  await assertOutCanBeReplaced(out);
  await mkdir(generations, { recursive: true });

  const generation = path.join(generations, `${Date.now()}-${randomUUID()}`);
  const temporaryLink = path.join(root, `.out-${randomUUID()}.tmp`);
  let committed = false;
  let linkCreated = false;

  try {
    await (options.copyDirectory ?? copyDirectory)(source, generation);
    await (options.validateGeneration ?? validateStaticGeneration)(generation);
    options.onStage?.('prepared');
    await symlink(path.relative(root, generation), temporaryLink, 'dir');
    linkCreated = true;
    options.onStage?.('before-swap');
    await (options.renamePointer ?? rename)(temporaryLink, out);
    linkCreated = false;
    committed = true;
    options.onStage?.('after-swap');
    return generation;
  } finally {
    if (linkCreated) await rm(temporaryLink, { force: true });
    if (!committed) await rm(generation, { recursive: true, force: true });
  }
}
