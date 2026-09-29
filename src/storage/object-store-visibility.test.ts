import { describe, expect, test } from 'bun:test';
import { probeVisibility, type VisibilityDeps } from './object-store-visibility.js';
import type { RunFn } from './object-store.js';

const BLOCKED = JSON.stringify({
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
  },
});
const PUBLIC_POLICY = JSON.stringify({
  Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }],
});

function scripted(handler: (bin: string, args: string[]) => { stdout: string } | never): VisibilityDeps {
  const run: RunFn = (bin, args) => {
    const out = handler(bin, args);
    return { stdout: out.stdout, stderr: '' };
  };
  return { run, which: (n) => n };
}

describe('probeVisibility', () => {
  test('local 은 항상 private · run 을 부르지 않는다', () => {
    let n = 0;
    const deps: VisibilityDeps = { run: () => { n += 1; return { stdout: '', stderr: '' }; } };
    expect(probeVisibility('local', 'whatever', deps)).toEqual({ visibility: 'private', reason: '로컬 파일은 공개 URL 이 없다' });
    expect(n).toBe(0);
  });

  test('s3 blocked → private · public-policy → public · no-block-config → partially-public · missing', () => {
    const priv = probeVisibility('s3', 'b', scripted((_b, args) => {
      if (args.includes('get-bucket-policy')) throw new Error('NoSuchBucketPolicy');
      return { stdout: BLOCKED };
    }));
    expect(priv.visibility).toBe('private');

    const pub = probeVisibility('s3', 'b', scripted((_b, args) => {
      if (args.includes('get-bucket-policy')) return { stdout: PUBLIC_POLICY };
      return { stdout: BLOCKED };
    }));
    expect(pub.visibility).toBe('public');

    const partial = probeVisibility('s3', 'b', scripted(() => {
      throw new Error('An error occurred (NoSuchPublicAccessBlockConfiguration) when calling the GetPublicAccessBlock operation');
    }));
    expect(partial.visibility).toBe('partially-public');

    const missing = probeVisibility('s3', 'nope', scripted(() => {
      throw new Error('An error occurred (NoSuchBucket) when calling the GetPublicAccessBlock operation');
    }));
    expect(missing.visibility).toBe('missing');
  });

  test('r2 는 endpoint-url 을 붙이고 blocked 를 private 로 매핑한다', () => {
    const seen: string[][] = [];
    const v = probeVisibility('r2', 'b', scripted((_b, args) => {
      seen.push(args);
      if (args.includes('get-bucket-policy')) throw new Error('NoSuchBucketPolicy');
      return { stdout: BLOCKED };
    }), { accountId: 'acc', profile: 'r2p' });
    expect(v.visibility).toBe('private');
    expect(seen[0]!.join(' ')).toContain('https://acc.r2.cloudflarestorage.com');
    expect(seen[0]).toContain('--profile');
    expect(seen[0]).toContain('r2p');
  });

  test('gcs 명령 실패 → unreadable 이고 private 이 아니다', () => {
    const v = probeVisibility('gcs', 'b', scripted(() => { throw new Error('gcloud exited 1'); }));
    expect(v.visibility).toBe('unreadable');
    expect(v.visibility).not.toBe('private');
  });

  test('gcs enforced + allUsers 없음 → private · allUsers → public · 모르는 pap → unreadable', () => {
    const priv = probeVisibility('gcs', 'b', scripted((_b, args) => {
      if (args.includes('describe')) return { stdout: JSON.stringify({ public_access_prevention: 'enforced' }) };
      return { stdout: JSON.stringify({ bindings: [{ members: ['user:a@b.c'] }] }) };
    }));
    expect(priv.visibility).toBe('private');

    const pub = probeVisibility('gcs', 'b', scripted((_b, args) => {
      if (args.includes('describe')) return { stdout: JSON.stringify({ public_access_prevention: 'enforced' }) };
      return { stdout: JSON.stringify({ bindings: [{ members: ['allUsers'] }] }) };
    }));
    expect(pub.visibility).toBe('public');

    const unknown = probeVisibility('gcs', 'b', scripted((_b, args) => {
      if (args.includes('describe')) return { stdout: JSON.stringify({ public_access_prevention: 'maybe' }) };
      return { stdout: JSON.stringify({ bindings: [] }) };
    }));
    expect(unknown.visibility).toBe('unreadable');
  });

  test('azure allowBlobPublicAccess false → private · publicAccess blob → public · 실패 → unreadable', () => {
    const priv = probeVisibility('azure', 'c', scripted((_b, args) => {
      if (args[1] === 'account') return { stdout: JSON.stringify({ allowBlobPublicAccess: false }) };
      return { stdout: '{}' };
    }), { account: 'acct' });
    expect(priv.visibility).toBe('private');

    const off = probeVisibility('azure', 'c', scripted((_b, args) => {
      if (args[1] === 'account') return { stdout: JSON.stringify({ allowBlobPublicAccess: true }) };
      return { stdout: JSON.stringify({ publicAccess: 'off' }) };
    }), { account: 'acct' });
    expect(off.visibility).toBe('private');

    const pub = probeVisibility('azure', 'c', scripted((_b, args) => {
      if (args[1] === 'account') return { stdout: JSON.stringify({ allowBlobPublicAccess: true }) };
      return { stdout: JSON.stringify({ publicAccess: 'blob' }) };
    }), { account: 'acct' });
    expect(pub.visibility).toBe('public');

    const bad = probeVisibility('azure', 'c', scripted(() => { throw new Error('az failed'); }), { account: 'acct' });
    expect(bad.visibility).toBe('unreadable');
    expect(bad.visibility).not.toBe('private');
  });

  test('모르는 문면은 private 이 아니다', () => {
    const v = probeVisibility('azure', 'c', scripted((_b, args) => {
      if (args[1] === 'account') return { stdout: JSON.stringify({ allowBlobPublicAccess: true }) };
      return { stdout: JSON.stringify({ publicAccess: 'surprise' }) };
    }), { account: 'acct' });
    expect(v.visibility).toBe('unreadable');
  });
});
