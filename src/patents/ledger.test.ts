import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PatentsInputError, PatentLedger } from './ledger.js';
import type { PatentStatus, PatentTrack } from './ledger.js';

const root = () => realpathSync(mkdtempSync(join(tmpdir(), 'patents-ledger-')));

test('조사·명세·출원 상태 후보는 공개 목록에 나오지 않고 공개 허용 상태만 읽힌다', () => {
  const stateDir = root();
  const now = new Date('2026-10-13T00:00:00Z');
  const store = new PatentLedger({ stateDir, now: () => now });
  try {
    expect(store.path).toBe(join(stateDir, 'patents', 'patents.sqlite'));
    const investigation = store.add({ id: 'PRIVATE-A', title: '비공개 후보 A', track: '비공개', deadline: '2030-01-28' });
    expect(investigation).toMatchObject({ id: 'PRIVATE-A', title: '비공개 후보 A', track: '비공개', status: '조사', deadline: '2030-01-28', created_at: now.toISOString(), updated_at: now.toISOString() });
    store.add({ id: 'PRIVATE-B', title: '비공개 후보 B', track: '비공개', status: '명세', deadline: '2030-01-20' });
    store.add({ id: 'FILED-C', title: '출원 후보 C', track: '출원', status: '출원', deadline: '2030-02-28' });
    store.add({ id: 'PUBLIC-D', title: '공개 허용 후보 D', track: '출원', status: '공개 허용', deadline: '2030-02-28' });
    // 판정선: 비공개/조사(·명세·출원) 상태 후보는 공개 목록으로 나오지 않는다
    expect(store.listPublicCandidates().map(row => row.id)).toEqual(['PUBLIC-D']);
    expect(store.setStatus('PRIVATE-B', '공개 허용')).toMatchObject({ id: 'PRIVATE-B', status: '공개 허용' });
    expect(store.listPublicCandidates().map(row => row.id)).toEqual(['PRIVATE-B', 'PUBLIC-D']);
    store.setStatus('PRIVATE-B', '조사');
    expect(store.listPublicCandidates().map(row => row.id)).toEqual(['PUBLIC-D']);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('후보 추가는 식별자·제목·갈래·상태·마감일을 검증하고 중복·없는 후보를 거부한다', () => {
  const stateDir = root();
  const store = new PatentLedger({ stateDir, now: () => new Date('2026-10-13T00:00:00Z') });
  try {
    expect(() => store.add({ id: ' ', title: '그 밖 신규', track: '신규' })).toThrow(PatentsInputError);
    expect(() => store.add({ id: 'BAD ID', title: '그 밖 신규', track: '신규' })).toThrow('invalid patent candidate id');
    expect(() => store.add({ id: 'NEW1', title: ' ', track: '신규' })).toThrow('title is required');
    expect(() => store.add({ id: 'NEW1', title: '그 밖 신규', track: '없는 갈래' as PatentTrack })).toThrow('invalid track: 없는 갈래');
    expect(() => store.add({ id: 'NEW1', title: '그 밖 신규', track: '신규', status: '없는 상태' as PatentStatus })).toThrow('invalid status: 없는 상태');
    expect(() => store.add({ id: 'NEW1', title: '그 밖 신규', track: '신규', deadline: '2026-10-32' })).toThrow('invalid deadline: 2026-10-32');
    expect(() => store.add({ id: 'NEW1', title: '그 밖 신규', track: '신규', deadline: '2026-02-31' })).toThrow('invalid deadline: 2026-02-31');
    const fresh = store.add({ id: 'NEW1', title: '그 밖 신규', track: '신규' });
    expect(fresh).toMatchObject({ id: 'NEW1', title: '그 밖 신규', track: '신규', status: '조사', deadline: null });
    expect(() => store.add({ id: 'NEW1', title: '겹침', track: '신규' })).toThrow('patent candidate already exists: NEW1');
    expect(() => store.setStatus('MISSING', '공개 허용')).toThrow('patent candidate not found: MISSING');
    expect(() => store.setStatus('NEW1', '없는 상태' as PatentStatus)).toThrow('invalid status: 없는 상태');
    expect(store.setStatus('NEW1', '명세').status).toBe('명세');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
