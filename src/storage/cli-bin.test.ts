import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcloudSearchPaths } from '../cli/role-cli.js';
import { _setCliBinSearchForTesting, cliBinCandidates, resolveCliBin } from './cli-bin.js';

afterEach(() => {
  _setCliBinSearchForTesting(null);
});

describe('resolveCliBin', () => {
  test('gcloud 는 gcloudSearchPaths 순서를 따른다', () => {
    const order = cliBinCandidates('gcloud');
    expect([...order]).toEqual(gcloudSearchPaths());
  });

  test('gcloud 가 ~/google-cloud-sdk/bin 에만 있으면 그 경로를 돌려준다', () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-bin-home-'));
    const bin = join(home, 'google-cloud-sdk', 'bin', 'gcloud');
    mkdirSync(join(home, 'google-cloud-sdk', 'bin'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\n');
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(gcloudSearchPaths()).toContain(bin);
      expect(resolveCliBin('gcloud', { exists: (path) => path === bin })).toBe(bin);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  test('훅으로 가짜 경로만 보면 그 경로를 고르고 진짜 설치는 안 본다', () => {
    const fake = '/tmp/elanous-fake-bins/aws';
    _setCliBinSearchForTesting((name) => (name === 'aws' ? [fake, '/opt/homebrew/bin/aws'] : []));
    const found = resolveCliBin('aws', { exists: (path) => path === fake });
    expect(found).toBe(fake);
  });

  test('없으면 null', () => {
    _setCliBinSearchForTesting(() => ['/no/such/az']);
    expect(resolveCliBin('az', { exists: () => false })).toBeNull();
  });

  test('aws·az·wrangler 는 알려진 설치 경로가 PATH 보다 앞이다', () => {
    const paths = cliBinCandidates('aws', { pathEnv: '/custom/bin', home: '/home/ada' });
    expect(paths[0]).toBe('/opt/homebrew/bin/aws');
    expect(paths[1]).toBe('/usr/local/bin/aws');
    expect(paths[2]).toBe('/usr/bin/aws');
    expect(paths[3]).toBe('/home/ada/.local/bin/aws');
    expect(paths).toContain('/custom/bin/aws');
  });
});
