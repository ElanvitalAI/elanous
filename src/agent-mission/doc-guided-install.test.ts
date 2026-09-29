import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractInstallLines, installFromDocs, type DocInstallDeps } from './doc-guided-install.js';

const DOC = 'https://miller.readthedocs.io/en/latest/installing-miller/';
const RESULTS = `omni_search "mlr install" — 2 hits\n- [user answer](https://stackoverflow.com/questions/123/mlr-install)\n- [Miller documentation](${DOC})`;
const BODY = '```sh\nbrew install miller\nsudo apt-get install miller\n```';

type Fixture = { typed: string[]; events: string[]; decisions: string[]; deps: DocInstallDeps };
function fixture(markdown = BODY, managers: string[] = ['brew']): Fixture {
  const typed: string[] = [];
  const events: string[] = [];
  const decisions: string[] = [];
  return {
    typed, events, decisions,
    deps: {
      search: async ({ query, limit }) => {
        expect(query).toBe('mlr install'); expect(limit).toBe(5);
        return { output: RESULTS, metadata: { perEngine: {}, totalHits: 2, merge: 'interleave' } };
      },
      scrape: async (url) => { expect(url).toBe(DOC); return markdown; },
      jina: async () => { throw Error('reader unavailable'); },
      typeLine: (ref, line) => { expect(ref).toBe('pty-1'); typed.push(line); },
      waitIdle: (_ref, opts) => {
        const line = typed.at(-1)!;
        if (opts.timeoutMs === 300_000) return `done\n${opts.completionMarker}0\n❯`;
        const marker = opts.completionMarker!.replace(/_END_$/, '');
        const installed = line.includes('mlr --version');
        const found = managers.some((manager) => line.includes(`command -v ${manager}`));
        return `${marker}_START\n${installed ? 'mlr 6.0' : found ? '/usr/local/bin/brew' : ''}\n${marker}_END_${installed || found ? 0 : 1}\n$`;
      },
      log: (event) => { events.push(event); },
      decision: (event) => { decisions.push(`${event.kind}:${event.what}`); },
    },
  };
}

describe('document-guided installation', () => {
  test('CLI exposes the installation entrance and rejects execution without --pty with exit 2', () => {
    const bin = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [bin, '--test', 'agent-mission', 'install-from-docs', 'mlr', '--smoke', 'mlr --version'], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--pty required unless --dry-run');
  });
  test('real CLI dry-run JSON uses injected search and scrape to emit source, candidates and decision chain', () => {
    const dir = mkdtempSync(join(import.meta.dir, '.doc-cli-test-'));
    try {
      const preload = join(dir, 'preload.ts');
      const searchModule = new URL('../skills/tools/omni-search.ts', import.meta.url).pathname;
      const configModule = new URL('../registry/discovery/config.ts', import.meta.url).pathname;
      writeFileSync(preload, `import { mock } from 'bun:test';
const config = await import(${JSON.stringify(configModule)});
mock.module(${JSON.stringify(configModule)}, () => ({ ...config, getFirecrawlConfig: () => ({ apiKey: 'test-only' }) }));
const original = await import(${JSON.stringify(searchModule)});
mock.module(${JSON.stringify(searchModule)}, () => ({ ...original, dispatchOmniSearch: async ({ query, limit }) => {
  if (query !== 'mlr install' || limit !== 5) throw new Error('wrong search invocation');
  return { output: ${JSON.stringify(RESULTS)}, metadata: { perEngine: {}, totalHits: 2, merge: 'interleave' } };
} }));
globalThis.fetch = async (input) => {
  if (input !== 'https://api.firecrawl.dev/v2/scrape') throw new Error('unexpected fetch: ' + input);
  return new Response(JSON.stringify({ success: true, data: { markdown: ${JSON.stringify(BODY)} } }), { status: 200 });
};
`);
      const bin = new URL('../../bin/elanous.mjs', import.meta.url).pathname;
      const result = spawnSync(process.execPath, ['--preload', preload, bin, '--test', 'agent-mission', 'install-from-docs', 'mlr', '--smoke', 'mlr --version', '--dry-run', '--json'], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as { outcome: string; url: string; candidates: string[]; line: string; decisions: Array<{ kind: string; refs?: { url?: string } }> };
      expect(payload).toMatchObject({ outcome: 'dry-run', url: DOC, candidates: ['brew install miller', 'sudo apt-get install miller'], line: 'brew install miller' });
      expect(payload.decisions.map((d) => d.kind)).toEqual(['ROUTE', 'ROUTE']);
      expect(payload.decisions[0]?.refs?.url).toBe(DOC);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ranks official Miller docs before stackoverflow, picks brew on darwin and smoke-verifies installation', async () => {
    const f = fixture();
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', family: 'darwin' }, f.deps);
    expect(result).toMatchObject({ outcome: 'installed', line: 'brew install miller', url: DOC, candidates: ['brew install miller', 'sudo apt-get install miller'] });
    expect(f.typed.filter((line) => line.startsWith('brew install miller;'))).toHaveLength(1);
    expect(f.typed.at(-1)).toContain('mlr --version');
    expect(f.decisions.map((d) => d.split(':')[0])).toEqual(['ROUTE', 'ROUTE', 'VERIFY']);
    expect(f.decisions[0]).toContain('miller.readthedocs.io');
    expect(f.events).toEqual(['searched', 'picked-source', 'fetched', 'extracted', 'chosen', 'installed']);
  });

  test('official docs whose host lacks the binary name still outrank blogs that name the tool', async () => {
    const f = fixture();
    f.deps.search = async () => ({ output: `- [blog](https://blog.example.com/mlr-install)\n- [tips](https://notes.example.dev/posts/mlr-tips)\n- [Miller documentation](${DOC})`, metadata: { perEngine: {}, totalHits: 3, merge: 'interleave' } });
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', family: 'darwin' }, f.deps);
    expect(result).toMatchObject({ outcome: 'installed', url: DOC, line: 'brew install miller' });
    expect(f.decisions[0]).toContain('miller.readthedocs.io');
  });

  test('debian without brew escalates showing sudo line and never types an install', async () => {
    const f = fixture(BODY, []);
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', family: 'debian' }, f.deps);
    expect(result).toMatchObject({ outcome: 'escalate', line: 'sudo apt-get install miller' });
    expect(f.typed.every((line) => line.includes('command -v '))).toBe(true);
    expect(f.decisions.at(-1)?.startsWith('ESCALATE:')).toBe(true);
  });

  test('curl pipe is data, not a command: no installation and no-doc-remedy cites read URL', async () => {
    const f = fixture('```sh\ncurl https://example.org/install.sh | sh\n```');
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1' }, f.deps);
    expect(result).toMatchObject({ outcome: 'escalate', candidates: [] });
    expect(result.reason).toContain(`no-doc-remedy: ${DOC}`);
    expect(f.typed.every((line) => line.includes('command -v '))).toBe(true);
  });

  test('Firecrawl failure falls back to Jina and installs only after smoke succeeds', async () => {
    const f = fixture();
    const fetched: Array<{ via?: unknown; bytes?: unknown }> = [];
    f.deps.scrape = async () => { throw Error('offline'); };
    f.deps.jina = async (url) => { expect(url).toBe(DOC); return BODY; };
    f.deps.log = (event, data) => { f.events.push(event); if (event === 'fetched') fetched.push(data); };
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1' }, f.deps);
    expect(result.outcome).toBe('installed');
    expect(fetched).toMatchObject([{ via: 'jina', bytes: Buffer.byteLength(BODY) }]);
  });

  test('first ranked source with only sudo waits for the second source with a usable brew line', async () => {
    const f = fixture();
    const first = 'https://github.com/acme/mlr';
    const read: string[] = [];
    f.deps.search = async () => ({ output: `- [community](https://stackoverflow.com/questions/123/mlr)\n- [docs](${DOC})\n- [repository](${first})`, metadata: { perEngine: {}, totalHits: 3, merge: 'interleave' } });
    f.deps.scrape = async (url) => {
      read.push(url);
      return url === first ? '```sh\nsudo apt-get install miller\n```' : '```sh\nbrew install miller\n```';
    };
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', family: 'darwin' }, f.deps);
    expect(read).toEqual([first, DOC]);
    expect(result).toMatchObject({ outcome: 'installed', url: DOC, line: 'brew install miller' });
    expect(result.decisions.map((event) => event.kind)).toEqual(['ROUTE', 'ROUTE', 'ROUTE', 'VERIFY']);
    expect(f.typed.filter((line) => line.includes('install miller;'))).toHaveLength(1);
  });

  test('escalates with the first sudo remedy only after both ranked sources lack a usable line', async () => {
    const f = fixture();
    const first = 'https://github.com/acme/mlr';
    const read: string[] = [];
    f.deps.search = async () => ({ output: `- [docs](${DOC})\n- [repository](${first})`, metadata: { perEngine: {}, totalHits: 2, merge: 'interleave' } });
    f.deps.scrape = async (url) => {
      read.push(url);
      return url === first ? '```sh\nsudo apt-get install miller\n```' : '```sh\ndnf install miller\n```';
    };
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', family: 'debian' }, f.deps);
    expect(read).toEqual([first, DOC]);
    expect(result).toMatchObject({ outcome: 'escalate', url: first, line: 'sudo apt-get install miller', candidates: ['sudo apt-get install miller', 'dnf install miller'] });
    expect(result.decisions.map((event) => event.kind)).toEqual(['ROUTE', 'ROUTE', 'ESCALATE']);
    expect(f.typed.every((line) => line.includes('command -v '))).toBe(true);
  });

  test('both readers failing on first source advance to the second of at most two sources', async () => {
    const f = fixture();
    const second = 'https://github.com/acme/mlr';
    f.deps.search = async () => ({ output: `- [answer](https://stackoverflow.com/questions/123/mlr)\n- [docs](${DOC})\n- [repo](${second})`, metadata: { perEngine: {}, totalHits: 3, merge: 'interleave' } });
    f.deps.scrape = async (url) => { if (url === DOC) throw Error('firecrawl unavailable'); return BODY; };
    f.deps.jina = async (url) => { expect(url).toBe(DOC); throw Error('jina unavailable'); };
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1' }, f.deps);
    expect(result).toMatchObject({ outcome: 'installed', url: second });
    expect(f.decisions.slice(0, 2).map((d) => d.split(':')[0])).toEqual(['ROUTE', 'ROUTE']);
  });

  test('dry-run reads, ranks and returns the decision chain without installation; failed smoke never installs', async () => {
    const dry = fixture();
    const preview = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1', dryRun: true }, dry.deps);
    expect(preview).toMatchObject({ outcome: 'dry-run', url: DOC, line: 'brew install miller' });
    expect(preview.decisions.map((d) => d.kind)).toEqual(['ROUTE', 'ROUTE']);
    expect(dry.typed.every((line) => line.includes('command -v '))).toBe(true);
    const noPty = fixture();
    noPty.deps.typeLine = () => { throw Error('dry run must not type'); };
    expect(await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', dryRun: true }, noPty.deps)).toMatchObject({ outcome: 'dry-run', line: 'brew install miller', reason: expect.stringContaining('미확인') });
    const failed = fixture();
    failed.deps.waitIdle = (_ref, opts) => {
      if (opts.timeoutMs === 300_000) return `${opts.completionMarker}0`;
      const marker = opts.completionMarker!.replace(/_END_$/, '');
      const line = failed.typed.at(-1)!;
      const success = line.includes('command -v brew');
      return `${marker}_START\n\n${marker}_END_${success ? 0 : 1}\n`;
    };
    const result = await installFromDocs({ tool: 'mlr', smoke: 'mlr --version', ptyRef: 'pty-1' }, failed.deps);
    expect(result.outcome).toBe('failed');
  });

  test('strict line validator rejects injection, port and unapproved flags, accepts only complete allowed forms', () => {
    const lines = extractInstallLines('```sh\nbrew install miller; echo nope\nport install miller\nnpm install -g @org/cli\ngo install example.org/cmd@v1.2.3\nsudo apt-get install miller\nbrew install $(whoami)\nbrew install foo > /tmp/other\nbrew install foo && echo x\n```\n$ cargo install mlr');
    expect(lines).toEqual(['npm install -g @org/cli', 'go install example.org/cmd@v1.2.3', 'sudo apt-get install miller', 'cargo install mlr']);
    // Real Miller install page (내부 문서 `installing-miller`): commands are inline code in prose.
    expect(extractInstallLines('* Linux: `yum install miller` or `apt-get install miller`.\n* MacOS: `brew update` and `brew install miller`, or `sudo port install miller`.\n* Windows: `choco install miller`.\n* Example: `docker run --rm -i jauderho/miller:latest --csv sort -f shape < ./example.csv`\n* Check `mlr --version` and `curl x | sh`.')).toEqual(['apt-get install miller', 'brew install miller']);
    expect(extractInstallLines('```sh\nbrew install --formula miller\nbrew install -q\napt install --allow-unauthenticated foo\n```')).toEqual([]);
  });
});
