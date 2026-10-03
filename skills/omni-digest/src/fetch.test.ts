import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchGitHubRepo } from './fetch.js';

test('public repository stays readable when gh is not authenticated', () => {
  const path = mkdtempSync(join(tmpdir(), 'public-github-'));
  const originalPath = process.env.PATH;
  try {
    const gh = join(path, 'gh');
    writeFileSync(gh, '#!/bin/sh\nexit 1\n');
    chmodSync(gh, 0o700);
    const calls = join(path, 'calls');
    const curl = join(path, 'curl');
    writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in
  *'/readme') printf '%s\\n' '{"download_url":"https://raw.githubusercontent.com/acme/demo/main/README.md"}' ;;
  *'raw.githubusercontent.com/'*) printf '%s\\n' '# Public README' ;;
  *'/commits?per_page=10') printf '%s\\n' '[{"commit":{"message":"First commit\\nbody","author":{"date":"2026-01-01T00:00:00Z"}}}]' ;;
  *'api.github.com/repos/acme/demo') printf '%s\\n' '{"name":"demo","description":"Open source","language":"TypeScript","stargazers_count":4,"forks_count":2}' ;;
  *) exit 1 ;;
esac
`);
    chmodSync(curl, 0o700);
    process.env.PATH = `${path}:/usr/bin:/bin`;
    const result = fetchGitHubRepo('acme', 'demo');
    expect(result.title).toBe('acme/demo');
    expect(result.content).toContain('Open source');
    expect(result.content).toContain('Stars: 4 | Forks: 2');
    expect(result.content).toContain('First commit (2026-01-01)');
    expect(result.content).toContain('# Public README');
    const requested = readFileSync(calls, 'utf8');
    expect(requested).toContain('https://api.github.com/repos/acme/demo');
    expect(requested).toContain('https://raw.githubusercontent.com/acme/demo/main/README.md');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(path, { recursive: true, force: true });
  }
});
