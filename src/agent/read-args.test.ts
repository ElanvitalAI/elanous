// turn 조립기 통일 Phase 4a — Read 파일-경로 인자 단일 출처 + 두 서피스 수렴 검증.
//
// file_path↔path 드리프트 해소: 리졸버가 file_path canonical + path 레거시 별칭을 모두 수용하고,
// daemon Read(종전 path 전용·file_path 거부)와 native Read(종전 file_path 전용)가 이제 양쪽 이름을
// 다 받는지 실제 dispatch 로 확인. 스키마 파괴 없이 backward-compatible.

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReadPathArg, READ_PATH_SCHEMA_PROPS } from './read-args.js';
import { buildReadTool as buildDaemonReadTool, dispatchRead as dispatchDaemonRead } from '../boot/daemon-tools/read.js';
import { dispatchRead as dispatchNativeRead } from '../skills/tools/read.js';

describe('resolveReadPathArg — file_path canonical + path 레거시 별칭', () => {
  test('file_path 우선(둘 다 있으면 file_path)', () => {
    expect(resolveReadPathArg({ file_path: '/a', path: '/b' })).toBe('/a');
  });
  test('file_path 없으면 path 폴백', () => {
    expect(resolveReadPathArg({ path: '/b' })).toBe('/b');
  });
  test('trim + 빈/무효는 ""', () => {
    expect(resolveReadPathArg({ file_path: '  /a  ' })).toBe('/a');
    expect(resolveReadPathArg({})).toBe('');
    expect(resolveReadPathArg({ file_path: 123 as unknown as string })).toBe('');
    expect(resolveReadPathArg({ file_path: '   ', path: '/b' })).toBe('/b');
  });
});

describe('daemon Read 스키마 — file_path canonical(+path 별칭)·Edit/Write 정합', () => {
  test('buildReadTool 이 file_path + path 둘 다 광고, required=file_path', () => {
    const spec = buildDaemonReadTool();
    const props = (spec.parameters as { properties: Record<string, unknown>; required: string[] });
    expect(Object.keys(props.properties)).toEqual(expect.arrayContaining(['file_path', 'path']));
    expect(props.required).toEqual(['file_path']);
  });
  test('READ_PATH_SCHEMA_PROPS 는 file_path/path 두 프로퍼티', () => {
    expect(Object.keys(READ_PATH_SCHEMA_PROPS)).toEqual(['file_path', 'path']);
  });
});

describe('두 Read 서피스 — file_path/path 모두 수용(실 dispatch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-args-'));
  const file = join(dir, 'hello.txt');
  writeFileSync(file, 'line1\nline2\n');
  const ctx = { cwd: dir, signal: new AbortController().signal } as unknown as Parameters<typeof dispatchDaemonRead>[1];

  test('daemon Read: file_path 로 성공(종전엔 path arg 거부 → 회귀 수정)', async () => {
    const r = await dispatchDaemonRead({ file_path: file }, ctx);
    expect(r.content).toContain('line1');
  });
  test('daemon Read: path 레거시 별칭도 계속 성공(backward-compat)', async () => {
    const r = await dispatchDaemonRead({ path: file }, ctx);
    expect(r.content).toContain('line2');
  });
  test('daemon Read: 둘 다 없으면 명확한 에러', async () => {
    await expect(dispatchDaemonRead({} as never, ctx)).rejects.toThrow(/file_path/);
  });

  test('native Read: file_path(canonical) 성공', async () => {
    const r = await dispatchNativeRead({ file_path: file });
    expect(r.output).toContain('line1');
  });
  test('native Read: path 레거시 별칭도 관용(단일 출처 리졸버)', async () => {
    const r = await dispatchNativeRead({ path: file });
    expect(r.output).toContain('line1');
  });

  // 정리
  test('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
