#!/usr/bin/env bun
// reel node — 데몬이 업로드 뒤 이미 렌더했으면(.reel-status.json done ⊕ 파일 있음) 그대로 쓰고, 아니면 같은 엔진(reel.sh)으로 한 번.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ENGINE, readContext, result } from './lib.js';

try {
  const { folder } = readContext();
  const file = join(folder, 'reel', 'reel-9x16.mp4');
  let state = '';
  try { state = (JSON.parse(readFileSync(join(folder, '.reel-status.json'), 'utf8')) as { state?: string }).state ?? ''; } catch { /* 없음 */ }
  if (state === 'rendering') throw new Error('데몬이 아직 렌더 중이다 — 끝난 뒤 다시');
  if (state === 'done' && existsSync(file) && existsSync(join(folder, 'reel', 'timeline.json'))) {
    result({ reel: file, reused: true });
  } else {
    const started = Date.now();
    const r = spawnSync('zsh', [join(ENGINE, 'reel.sh'), folder], { encoding: 'utf8', timeout: 540000 });
    if (r.status !== 0 || !existsSync(file)) throw new Error(`reel.sh 실패: ${(r.stderr || r.stdout || '').slice(-300)}`);
    result({ reel: file, reused: false, ms: Date.now() - started });
  }
} catch (error) {
  console.log(JSON.stringify({ outcome: 'fail', reason: error instanceof Error ? error.message : String(error) }));
}
