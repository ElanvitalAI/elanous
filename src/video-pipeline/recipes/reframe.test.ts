/**
 * ⛔⭐ 이 시험이 답하는 것 «하나»: ***Affinity 가 못 쓰일 때 파이프라인이 «멈추지 않나».***
 *
 * 🩸 계기: 리프레임을 붙이면서 ①(Affinity)만 실물로 확인했다. 그런데 이 기계에서 앱이
 *   ***떠 있었다.*** ⇒ 「②·③이 도는가」는 ***한 번도 안 눌렀다***. 그 상태로 「됐다」고 하면
 *   고객 기계(앱 없음)에서 처음 터진다.
 * 🔑 ***내가 가진 환경이 「통과」한 것을 「검증」으로 읽지 않는다.***
 */
import { describe, expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ffmpeg from './ffmpeg.js';
const { run } = ffmpeg;
import { affinityReachable, reframeOne, resetAffinityReachCache, sayReframe } from './reframe.js';

const HOME = process.env.HOME ?? '/tmp';
const mkSrc = (dir: string, w: number, h: number): string => {
  const p = join(dir, `src-${w}x${h}.png`);
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=0x2b3a42:s=${w}x${h}`, '-frames:v', '1', p]);
  if (!r.ok) throw new Error(`픽스처를 못 만들었다: ${r.err}`);
  return p;
};
const sizeOf = (p: string): string =>
  run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]).out.trim();

describe('reframe — Affinity 가 없어도 «끝까지» 간다', () => {
  // ⛔ 실물 ffmpeg 를 여러 번 부른다 — 기본 5초로는 «내 느림»이 실패로 보인다.
  const T = 30_000;

  test('⛔ 도달성 probe 가 «한 런에 한 번»만 든다 (SSE 가 안 닫혀서 매번 최대 시간을 쓴다)', () => {
    resetAffinityReachCache();
    const probe = spyOn(ffmpeg, 'run').mockImplementation(() => ({ ok: false, code: 7, signal: null, out: '000', err: '' }));
    try {
      expect(affinityReachable()).toBe(false);
      for (let i = 0; i < 5; i++) expect(affinityReachable()).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      resetAffinityReachCache();
      probe.mockImplementation(() => ({ ok: false, code: 28, signal: null, out: '000', err: 'timeout' }));
      expect(affinityReachable()).toBeNull();
      expect(affinityReachable()).toBeNull();
      expect(probe).toHaveBeenCalledTimes(3); // 측정 불가는 캐시하지 않는다.
    } finally { probe.mockRestore(); resetAffinityReachCache(); }
  }, T);
  test('⛔ 산출이 «홈 밖»이면 Affinity 를 건너뛰고 ffmpeg 로 간다 ⊕ «이유»를 들고 간다', () => {
    const d = mkdtempSync(join(tmpdir(), 'rf-'));
    try {
      const src = mkSrc(d, 1024, 1024);
      const out = join(d, 'out.png');                      // ⛔ /tmp — Affinity 가 «못 내보내는» 자리
      const r = reframeOne({ src, out, width: 1280, height: 720, scriptDir: 'scripts' });
      expect(r.ok).toBe(true);
      expect(r.method).not.toBe('affinity');               // ⛔ 여기로 오면 안 된다
      expect(existsSync(out)).toBe(true);
      expect(sizeOf(out)).toBe('1280,720');                // ***실제로 목표 비율이 됐나***
      // ⛔ 「건너뛰었다」를 «조용히» 하지 않는다 — 이유가 산출에 있어야 한다.
      expect(r.skipped.some((s) => s.method === 'affinity')).toBe(true);
      expect(sayReframe(r)).toContain('못 쓴 것');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⛔ 러너가 «없어도» 멈추지 않는다 (앱이 없는 고객 기계의 모습)', () => {
    const d = mkdtempSync(join(HOME, '.rf-'));             // 홈 아래 — 경로 때문이 아님을 분리한다
    const src = mkSrc(d, 800, 600);
    const out = join(d, 'out.png');
    resetAffinityReachCache();
    const probe = spyOn(ffmpeg, 'run').mockImplementation((cmd, args, timeout) =>
      cmd === 'curl' ? { ok: true, out: '200', err: '', code: 0, signal: null } : run(cmd, args, timeout));
    try {
      const r = reframeOne({ src, out, width: 1080, height: 1920, scriptDir: '/없는/스크립트/뿌리' });
      expect(r.ok).toBe(true);
      expect(r.method).toBe('ffmpeg-blur');
      expect(sizeOf(out)).toBe('1080,1920');
      expect(r.skipped[0]?.why).toContain('러너가 없다');
    } finally { probe.mockRestore(); resetAffinityReachCache(); rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⛔ 원본이 «없으면» 실패를 «실패로» 말한다 (조용히 통과하지 않는다)', () => {
    const d = mkdtempSync(join(HOME, '.rf-'));
    try {
      const r = reframeOne({ src: join(d, '없다.png'), out: join(d, 'o.png'),
        width: 1080, height: 1920, scriptDir: 'scripts' });
      expect(r.ok).toBe(false);
      expect(r.why ?? '').not.toBe('');
      expect(sayReframe(r)).toContain('전부 실패');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);

  test('⭐ 비율이 «이미 맞아도» 목표 크기로 내놓는다', () => {
    const d = mkdtempSync(join(HOME, '.rf-'));
    try {
      const src = mkSrc(d, 1280, 720);
      const out = join(d, 'out.png');
      const r = reframeOne({ src, out, width: 640, height: 360, scriptDir: '/없는/뿌리' });
      expect(r.ok).toBe(true);
      expect(sizeOf(out)).toBe('640,360');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }, T);
});
