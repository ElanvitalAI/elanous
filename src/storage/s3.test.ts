import { describe, expect, test } from 'bun:test';
import { S3_FEATURE_PREFIXES, s3ElanousKey, type S3FeatureKey } from './s3.js';

describe('S3 feature prefixes', () => {
  test('preserves existing feature prefixes and adds the retained ad-assets prefix', () => {
    expect(S3_FEATURE_PREFIXES).toEqual({
      notesMetrics: 'notes-metrics',
      ocrPrefs: 'ocr-prefs',
      sessions: 'sessions',
      reflectionHistory: 'reflection-history',
      discoveryCache: 'discovery-cache',
      discoveryHistory: 'discovery-history',
      debugBundle: 'debug-bundle',
      memoryArchive: 'memory-archive',
      spill: 'spill',
      morning: 'morning',
      adAssets: 'ad-assets',
    });
  });

  test('accepts adAssets as a feature key and builds its canonical retained asset key', () => {
    const feature: S3FeatureKey = 'adAssets';

    expect(s3ElanousKey(feature, 'creative.png')).toEndWith('/ad-assets/creative.png');
  });
});

import { bucketForKey, isPublicKey, s3Config, s3PublicBase, s3Uri } from './s3.js';
// 2026-09-26 사고: 기본 버킷이 공개 버킷(elanvital-public)이라 대화 원문·기억 보관본이 공개 읽기 경로에 올라갔다.
describe('S3 버킷 분리 — 기본 버킷 없음 · 공개 기능만 공개 버킷', () => {
  const saved = { b: process.env.AWS_S3_BUCKET, p: process.env.AWS_S3_PUBLIC_BUCKET, c: process.env.ELANOUS_CONFIG_DIR };
  const restore = () => {
    for (const [k, v] of [['AWS_S3_BUCKET', saved.b], ['AWS_S3_PUBLIC_BUCKET', saved.p], ['ELANOUS_CONFIG_DIR', saved.c]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  test('설정이 없으면 버킷이 «없다» — 공개 버킷으로 조용히 가지 않고 던진다', () => {
    try {
      delete process.env.AWS_S3_BUCKET; delete process.env.AWS_S3_PUBLIC_BUCKET;
      process.env.ELANOUS_CONFIG_DIR = '/nonexistent-elanous-config';
      expect(s3Config().bucket).toBe('');
      expect(s3Config().publicBucket).toBe('');
      expect(() => bucketForKey('monad/ID/sessions/a.jsonl')).toThrow('storage.s3.bucket');
      expect(() => s3PublicBase()).toThrow('storage.s3.publicBucket');
    } finally { restore(); }
  });

  test('세션·기억 보관은 비공개 버킷 · 게시·아침 보고·디버그 묶음만 공개 버킷', () => {
    try {
      process.env.AWS_S3_BUCKET = 'priv'; process.env.AWS_S3_PUBLIC_BUCKET = 'pub';
      expect(s3Uri('monad/ID/sessions/a.jsonl')).toBe('s3://priv/monad/ID/sessions/a.jsonl');
      expect(s3Uri('monad/ID/memory-archive/x.json')).toBe('s3://priv/monad/ID/memory-archive/x.json');
      expect(s3Uri('monad/ID/morning/2026-09-26.md')).toBe('s3://pub/monad/ID/morning/2026-09-26.md');
      expect(s3Uri('monad/publish/abc/index.html')).toBe('s3://pub/monad/publish/abc/index.html');
      expect(isPublicKey('monad/ID/debug-bundle/b.zip')).toBe(true);
      expect(isPublicKey('monad/ID/spill/s.txt')).toBe(false);
      // JUD-B #39393 mustFix ③ — 'public' 조각은 member 게시 네임스페이스(members/<handle>/public/<YYYYMMDD>/) 에만 공개.
      expect(isPublicKey('members/demo/public/20260121/a-b-0123456789ab.txt')).toBe(true);
      expect(isPublicKey('members/demo/backup/public/x.txt')).toBe(false);
      expect(isPublicKey('ops/demo/public/20260121/x.txt')).toBe(false);
      expect(isPublicKey('monad/ID/spill/public.txt')).toBe(false);
      expect(isPublicKey('members/demo/public/x.txt')).toBe(false);
      expect(s3PublicBase()).toBe('https://pub.s3.amazonaws.com');
    } finally { restore(); }
  });
});
