import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { run as runPublicExport } from '../../scripts/public-export.js';
import {
  issueSecretCanary,
  runSecretCanaryContract,
  scanSecretCanaries,
  secretCanaryContractMatrix,
} from './secret-canary.js';

describe('secret-canary simulator', () => {
  test('provider-specific canaries are recognizable fakes and unique per mint', () => {
    const first = issueSecretCanary('openai', 'fixture-0001');
    const second = issueSecretCanary('openai', 'fixture-0002');
    const anthropic = issueSecretCanary('anthropic', 'fixture-0001');
    const mintedOne = issueSecretCanary('grok');
    const mintedTwo = issueSecretCanary('grok');

    expect(first.value).toContain('sk-proj-ELANOUS_CANARY_V1:openai/');
    expect(anthropic.value).toContain('sk-ant-ELANOUS_CANARY_V1:anthropic/');
    expect(new Set([first.value, second.value, anthropic.value]).size).toBe(3);
    expect(mintedOne.value).toContain('xai-ELANOUS_CANARY_V1:grok/');
    expect(mintedOne.value).not.toBe(mintedTwo.value);
  });

  test('the shared matrix finds raw, base64, and URL variants and accounts for scan coverage', () => {
    const observations = runSecretCanaryContract();

    const failed = observations.filter((observation) => !observation.passed);
    expect(failed, failed.map((observation) => `${observation.name}: ${JSON.stringify(observation)}`).join('\n')).toHaveLength(0);
    expect(observations.find((observation) => observation.name.startsWith('clean artifact'))).toMatchObject({
      verdict: 'clean', searchedLocations: 1, excludedLocations: 0,
    });
    expect(observations.find((observation) => observation.name.startsWith('empty scan'))).toMatchObject({
      verdict: 'indeterminate', searchedLocations: 0, searchedBytes: 0,
    });
    expect(observations.find((observation) => observation.name.startsWith('public artifact without'))).toMatchObject({
      verdict: 'indeterminate', searchedLocations: 1, searchedBytes: Buffer.byteLength('clean export', 'utf8'),
    });
  });

  test('the shared contract rejects wrong provider attribution and incorrect UTF-8 coverage', () => {
    const dishonestScanner = (canaries: Parameters<typeof scanSecretCanaries>[0], locations: Parameters<typeof scanSecretCanaries>[1]) => {
      const observed = scanSecretCanaries(canaries, locations);
      return {
        ...observed,
        searchedBytes: 0,
        matches: observed.matches.map((match) => ({ ...match, provider: 'anthropic' })),
      };
    };

    const leakObservations = runSecretCanaryContract(dishonestScanner)
      .filter((observation) => observation.expectedMatches > 0);
    expect(leakObservations.every((observation) => !observation.passed)).toBe(true);
  });

  test('secret backend storage is not searched, while all public artifact bytes are counted once', () => {
    const canary = issueSecretCanary('grok', 'fixture-0003');
    const publicText = 'a public artifact';
    const result = scanSecretCanaries([canary], [
      { path: 'logs/a.log', content: publicText, kind: 'log' },
      { path: 'vault/secret', content: canary.value, kind: 'secret-backend-storage' },
    ]);

    expect(result).toMatchObject({
      matches: [], verdict: 'clean', searchedLocations: 1,
      searchedBytes: Buffer.byteLength(publicText), excludedLocations: 1,
    });
  });

  test('every leak case has the expected single match encoding', () => {
    const leakCases = secretCanaryContractMatrix.filter((contract) => contract.expected.verdict === 'leaked');
    for (const contract of leakCases) {
      const result = scanSecretCanaries(contract.canaries, contract.locations);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject(contract.expected.matches[0]);
    }
  });

  test('production scanner detects Base64 canaries across short tokens and line boundaries', () => {
    const canary = issueSecretCanary('openai', 'fixture-b64-01');
    const encoded = Buffer.from(canary.value).toString('base64');
    const cases = [
      { name: 'short token', content: encoded },
      { name: 'LF-wrapped', content: `${encoded.slice(0, 1)}\n${encoded.slice(1)}` },
      { name: 'consecutive single-character row', content: `${encoded.slice(0, 4)}\n${encoded.slice(4, 5)}\n${encoded.slice(5)}` },
      { name: 'CRLF-wrapped', content: `${encoded.slice(0, 5)}\r\n${encoded.slice(5)}` },
      { name: 'multiple split chunks', content: `${encoded.slice(0, 4)}\n${encoded.slice(4, 12)}\n${encoded.slice(12)}` },
      { name: 'diff addition lines', content: `+${encoded.slice(0, 4)}\n+${encoded.slice(4, 8)}\n+${encoded.slice(8)}` },
      { name: 'independent canary after padded Base64 token', content: `QQ==\n${encoded}` },
    ] as const;

    for (const entry of cases) {
      const path = `evidence/${entry.name}.txt`;
      const observed = scanSecretCanaries([canary], [{ path, content: entry.content, kind: 'evidence' }]);
      expect(observed.matches, entry.name).toEqual([{ provider: canary.provider, path, encoding: 'base64' }]);
      expect(observed.verdict, entry.name).toBe('leaked');
    }
  });

  test('ordinary Base64 and fragments separated by a non-Base64 boundary stay clean', () => {
    const canary = issueSecretCanary('openai', 'fixture-b64-02');
    const encoded = Buffer.from(canary.value).toString('base64');
    const result = scanSecretCanaries([canary], [
      { path: 'evidence/plain.txt', content: Buffer.from('ordinary export').toString('base64'), kind: 'evidence' },
      { path: 'evidence/separated.txt', content: `${encoded.slice(0, 8)}\nnot-base64\n${encoded.slice(8)}`, kind: 'evidence' },
    ]);

    expect(result.matches).toEqual([]);
    expect(result.verdict).toBe('clean');
  });

  test('public export production path blocks a padded-prefix Base64 canary before writing output', () => {
    const canary = issueSecretCanary('openai', 'fixture-prod-01');
    const encoded = Buffer.from(canary.value).toString('base64');
    const root = mkdtempSync(join(tmpdir(), 'secret-canary-export-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(join(root, 'release/public-export.yaml'), 'include:\n  - src/**\nexclude: []\nreplace: {}\n');
    const secretFilename = `src/${canary.value}.txt`;
    mkdirSync(dirname(join(root, secretFilename)), { recursive: true });
    writeFileSync(join(root, secretFilename), `QQ==\n${encoded}\n010-222-3333`);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });
    const output = `${root}-output`;
    const errors: string[] = [];
    const reports: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); };
    console.log = (...values: unknown[]) => { reports.push(values.map(String).join(' ')); };
    const originalCanaries = process.env.ELANOUS_SECRET_CANARIES;
    process.env.ELANOUS_SECRET_CANARIES = JSON.stringify([canary]);
    let result: number;
    try {
      result = runPublicExport(['--config', 'release/public-export.yaml', '--out', output, '--no-private-list'], root);
      expect(result).toBe(1);
      expect(existsSync(output)).toBe(false);
      expect(errors.join('\\n')).toContain('secret canary detected in src/[redacted].txt (base64)');
      expect(errors.join('\\n')).not.toContain(canary.value);

      errors.length = 0;
      result = runPublicExport(['--config', 'release/public-export.yaml', '--leak-check', '--no-private-list'], root);
      expect(result).toBe(1);
      expect(reports.join('\\n')).toContain('secret-canary');
      expect(reports.join('\\n')).toContain('kr-mobile-phone');
      expect(reports.join('\\n')).not.toContain(canary.value);

      spawnSync('git', ['rm', '--cached', '--', secretFilename], { cwd: root });
      rmSync(join(root, secretFilename));
      writeFileSync(join(root, 'src/public.txt'), 'ordinary public export');
      spawnSync('git', ['add', '--', 'src/public.txt'], { cwd: root });
      errors.length = 0;
      result = runPublicExport(['--config', 'release/public-export.yaml', '--leak-check', '--no-private-list'], root);
      expect(result).toBe(0);
      expect(errors.join('\\n')).not.toContain('secret canary detected');

      const cleanOutput = join(root, 'clean-export');
      result = runPublicExport(['--config', 'release/public-export.yaml', '--out', cleanOutput, '--no-private-list'], root);
      expect(result).toBe(0);
      expect(existsSync(join(cleanOutput, 'src/public.txt'))).toBe(true);

      process.env.ELANOUS_SECRET_CANARIES = '{invalid';
      errors.length = 0;
      result = runPublicExport(['--config', 'release/public-export.yaml', '--leak-check', '--no-private-list'], root);
      expect(result).toBe(2);
      expect(errors.join('\\n')).toContain('ELANOUS_SECRET_CANARIES must be a JSON array');
    } finally {
      console.error = originalError;
      console.log = originalLog;
      if (originalCanaries === undefined) delete process.env.ELANOUS_SECRET_CANARIES;
      else process.env.ELANOUS_SECRET_CANARIES = originalCanaries;
      rmSync(root, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  test('large Base64-only runs without a canary stay clean', () => {
    const canary = issueSecretCanary('openai', 'fixture-b64-03');
    const content = 'A\n'.repeat(100_000);
    const result = scanSecretCanaries([canary], [{ path: 'evidence/long-wrapped.txt', content, kind: 'evidence' }]);

    expect(result.matches).toEqual([]);
    expect(result.verdict).toBe('clean');
  });
});
