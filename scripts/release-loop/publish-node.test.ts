import { expect, test } from 'bun:test';
import { waitForAssets } from './publish-node.js';

const runner = (answers: Record<string, string[]>) => {
  const calls: string[] = [];
  const run = (_command: string, args: readonly string[]) => {
    const url = args.at(-1)!;
    const name = url.split('/').at(-1)!;
    calls.push(name);
    const queue = answers[name]!;
    return { status: 0, stdout: queue.length > 1 ? queue.shift()! : queue[0]!, stderr: '' };
  };
  return { run, calls };
};

test('REL3: waits while an asset is not served yet, then reports none pending', () => {
  const { run } = runner({ 'install.sh': ['404', '404', '200'], 'elanous.tgz': ['200'] });
  const sleeps: number[] = [];
  expect(waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['install.sh', 'elanous.tgz'], 600, (ms) => sleeps.push(ms))).toEqual([]);
  expect(sleeps).toEqual([15_000, 15_000]);
});

test('REL3: an asset that never appears within the wait is returned as pending (publish must not say ok)', () => {
  const { run } = runner({ 'install.sh': ['404'], 'elanous.tgz': ['200'] });
  expect(waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['install.sh', 'elanous.tgz'], 30, () => {})).toEqual(['install.sh']);
});

test('REL3: probes the public download URL for the tag', () => {
  const urls: string[] = [];
  const run = (_c: string, args: readonly string[]) => { urls.push(args.at(-1)!); return { status: 0, stdout: '200', stderr: '' }; };
  waitForAssets(run as never, 'ElanvitalAI/elanous', 'v0.2.8', ['SHA256SUMS'], 0, () => {});
  expect(urls).toEqual(['https://github.com/ElanvitalAI/elanous/releases/download/v0.2.8/SHA256SUMS']);
});
