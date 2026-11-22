// terra r5 DELTA-FINDING ③④ — bunSpawnPty().write 진입점 회귀용 fixture:
// stdin 의 원시 바이트를 가공 없이 argv[2] 파일에 그대로 덤프한다(바이트 충실성 실측).
// ⛔ 저장소 내부 import 없음 — 대상은 진입점(pty.write)→PTY→자식(이 프로세스)의 바이트 경로다.
import process from 'node:process';
import { appendFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: stdin-dump.ts <out-file>');
const chunks: Buffer[] = [];
let flushing = false;
const flush = (): void => {
  if (flushing) return;
  flushing = true;
  if (chunks.length > 0) appendFileSync(out, Buffer.concat(chunks));
  chunks.length = 0;
  flushing = false;
};
process.stdin.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); flush(); });
process.stdin.on('end', () => { flush(); });
// 종료 없음 — 시험이 pane/프로세스를 종료한다.
