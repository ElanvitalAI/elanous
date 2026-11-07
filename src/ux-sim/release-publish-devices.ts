import type { NpmPublishDeps } from '../../scripts/release-loop/npm-publish-node.js';
import type { CommandRunner } from '../../scripts/release-loop/node-verdict.js';

export interface ReleasePublishDevices {
  publishRunner: CommandRunner;
  npm: NpmPublishDeps;
  publishCalls: string[];
  npmCalls: string[];
}

/** Boundary responses for the real publish and npm-publish release nodes in an isolated simulation. */
export function createReleasePublishDevices(version: string): ReleasePublishDevices {
  const publishCalls: string[] = [];
  const npmCalls: string[] = [];
  const publishRunner: CommandRunner = (program, args) => {
    publishCalls.push(`${program} ${args.join(' ')}`);
    if (program === 'git' && args[0] === 'show' && args[1]?.endsWith(`release/public/docs/releases/${version}.md`))
      return { status: 0, stdout: `# ${version}\n\nKnown Issues\n`, stderr: '' };
    if (program === 'git' && args[0] === 'show' && args[1]?.endsWith('website/pages.json'))
      return { status: 0, stdout: JSON.stringify({ pages: [] }), stderr: '' };
    if (program === 'bun' && args[0] === 'bin/elanous.mjs' && args[1] === 'release' && args[2] === 'publish')
      return { status: 0, stdout: JSON.stringify({ ok: true, published: true, tag: `v${version}`, publicRepo: 'elanous/elanous', assets: [] }), stderr: '' };
    return { status: 2, stdout: '', stderr: `unexpected simulated publish boundary ${program} ${args.join(' ')}` };
  };
  const registryReads = new Map<string, number>();
  const npm: NpmPublishDeps = {
    sleep: async () => {},
    exec: (program, args) => {
      npmCalls.push(`${program} ${args.join(' ')}`);
      if (program === 'tar') return { status: 0, stdout: JSON.stringify({ name: 'elanous', version }), stderr: '' };
      if (program === 'npm' && args[0] === 'publish') return { status: 0, stdout: 'published', stderr: '' };
      return { status: 2, stdout: '', stderr: `unexpected simulated npm boundary ${program} ${args.join(' ')}` };
    },
    registry: async (url) => {
      const count = (registryReads.get(url) ?? 0) + 1;
      registryReads.set(url, count);
      if (url.endsWith(`/${version}`)) return count === 1
        ? { status: 404, body: null } : { status: 200, body: { name: 'elanous', version } };
      return { status: 200, body: { 'dist-tags': { latest: count === 1 ? '0.2.45' : version } } };
    },
  };
  return { publishRunner, npm, publishCalls, npmCalls };
}
