import { describe, expect, test } from 'bun:test';
import { elanousInvocation } from './spawn-elanous.js';
import { measureUniverse, universeMismatch } from './resolve.js';
import { observeEmptyUniverse, observeUniverseMismatch } from './child-scope.js';

describe('spawnElanous 우주 도장', () => {
  test('stateDir 를 명시하면 도장 뿌리·출처가 자식 env 에 실린다', () => {
    const inv = elanousInvocation(['where'], { stateDir: '/tmp/u-a', env: { PATH: '/bin' } });
    expect(inv.env.ELANOUS_STATE_DIR).toBe('/tmp/u-a');
    expect(inv.env.ELANOUS_STATE_DIR_SOURCE).toBeTruthy();
    expect(inv.env.PATH).toBe('/bin');
    expect(inv.args.slice(1)).toEqual(['where']);
  });

  test('installed executable keeps its command while receiving both universe identity fields', () => {
    const inv = elanousInvocation(['mission', 'status'], { executable: 'eln', stateDir: '/tmp/u-installed', env: { PATH: '/usr/bin' } });
    expect(inv.command).toBe('eln');
    expect(inv.args).toEqual(['mission', 'status']);
    expect(inv.env).toMatchObject({ PATH: '/usr/bin', ELANOUS_STATE_DIR: '/tmp/u-installed',
      ELANOUS_STATE_DIR_SOURCE: expect.any(String) });
  });

  test('생략하면 부모 effectiveInstanceRoot 가 도장이 된다', () => {
    const inv = elanousInvocation(['where'], { env: {} });
    expect(inv.env.ELANOUS_STATE_DIR).toBeTruthy();
  });
});

describe('universe-mismatch · 빈 우주', () => {
  test('universeMismatch 는 다르면 잡고 같거나 도장이 없으면 null', () => {
    expect(universeMismatch('/a', '/b')).toEqual({ parentRoot: '/a', childRoot: '/b' });
    expect(universeMismatch('/a/', '/a')).toBeNull();
    expect(universeMismatch(undefined, '/a')).toBeNull();
  });

  test('observeUniverseMismatch 는 경고 한 줄을 남긴다', () => {
    const logs: Array<[string, boolean | undefined]> = [];
    const got = observeUniverseMismatch({ stamp: '/p', effectiveRoot: () => '/c', log: (e, _d, w) => logs.push([e, w]) });
    expect(got).not.toBeNull();
    expect(logs).toEqual([['universe-mismatch', true]]);
    expect(observeUniverseMismatch({ stamp: '/p', effectiveRoot: () => '/p', log: () => { throw new Error('x'); } })).toBeNull();
  });

  test('빈 우주는 «측정 불가» 로 말한다', () => {
    expect(measureUniverse('/x', () => [])).toEqual({ measurable: false, reason: '빈 우주' });
    expect(measureUniverse('/x', () => ['config.json'])).toEqual({ measurable: true });
  });

  test('observeEmptyUniverse 는 빈 우주만 universe-unmeasurable 정보 한 줄로 적는다', () => {
    const logs: Array<[string, boolean | undefined]> = [];
    const log = (e: string, _d: Record<string, unknown>, w?: boolean) => logs.push([e, w]);
    expect(observeEmptyUniverse('/x', { entries: () => [], log })).toEqual({ measurable: false, reason: '빈 우주' });
    expect(logs).toEqual([['universe-unmeasurable', undefined]]);
    expect(observeEmptyUniverse('/x', { entries: () => ['config.json'], log })).toEqual({ measurable: true });
    expect(logs).toHaveLength(1);
  });
});
