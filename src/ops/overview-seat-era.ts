/**
 * ⚠️ 자리 시대 원천(제품 «밖») — OPS-OVERVIEW-CLI 첫 조각의 «임시» 읽기 전용 리더.
 *
 * RFC §A3 는 overview 의 원천을 제품 원장·API 로만 둔다. 그런데 디스패처의 박동·Pod 사용 수·넘김 목록은
 * 아직 `~/elanous-hq/seat-state/OP/feeder/` 의 PID 파일·stdout 로그에만 있다(OVW-DISPATCH-LEDGER 가 원장으로 옮긴다).
 * 그때까지 이 파일 «하나»에 가둬 두고, 출력에는 항상 «자리 시대 원천» 표지를 붙인다. 옮겨지면 이 파일을 지운다.
 * ⛔ 쓰지 않는다 · ⛔ ssh 하지 않는다 · 파일이 없으면 «못 잼»(0 아님).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SEAT_ERA_SOURCE = '자리 시대 원천(feeder)';

export function seatEraFeederDir(home: string = homedir()): string {
  return join(home, 'elanous-hq', 'seat-state', 'OP', 'feeder');
}

export interface DispatcherBeat { seat: string; pid: number | null; alive: boolean | null; lastAt: string; ageSeconds: number }

/** `dispatcher-<자리>.pid` 마다 하나 — 박동 시각은 `.out` 이 있으면 그 mtime, 없으면 PID 파일 mtime. */
export function readDispatcherBeats(dir: string, now: number, isAlive: (pid: number) => boolean = pidAlive): DispatcherBeat[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: DispatcherBeat[] = [];
  for (const name of names) {
    const m = /^dispatcher-([A-Za-z]+)\.pid$/.exec(name);
    if (!m) continue;
    const seat = m[1]!;
    let pid: number | null = null;
    try { const n = Number(readFileSync(join(dir, name), 'utf8').trim()); pid = Number.isInteger(n) && n > 0 ? n : null; } catch { /* 못 읽음 */ }
    let mtime: number;
    try { mtime = statSync(join(dir, `dispatcher-${seat}.out`)).mtimeMs; } catch {
      try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    }
    out.push({ seat, pid, alive: pid === null ? null : isAlive(pid), lastAt: new Date(mtime).toISOString(), ageSeconds: Math.max(0, Math.round((now - mtime) / 1000)) });
  }
  return out.sort((a, b) => a.seat.localeCompare(b.seat));
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface DispatcherCapacityLine { at: string; podUsed: number; podTarget: number; localUsed: number; localMax: number }

/** 디스패처 로그의 마지막 «Pod a/b · 로컬 c/d» 줄. 줄 머리 `HH:MM:SS` 는 로그 파일 mtime 의 날짜(KST)로 읽는다. */
export function parseDispatcherCapacity(text: string): Omit<DispatcherCapacityLine, 'at'> & { hhmmss: string } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{2}:\d{2}:\d{2}) .*Pod (\d+)(?:\/(\d+))? · 로컬 (\d+)(?:\/(\d+))?/.exec(lines[i]!);
    if (!m || m[3] === undefined) continue;
    return { hhmmss: m[1]!, podUsed: Number(m[2]), podTarget: Number(m[3]), localUsed: Number(m[4]), localMax: m[5] === undefined ? 0 : Number(m[5]) };
  }
  return null;
}

export function readDispatcherCapacity(dir: string, now: number = Date.now()): (DispatcherCapacityLine & { ageSeconds: number }) | { error: string } {
  const path = join(dir, 'dispatcher-OP.out');
  let text: string; let mtime: number;
  try { text = readFileSync(path, 'utf8'); mtime = statSync(path).mtimeMs; } catch (error) { return { error: `디스패처 로그 없음(${(error as NodeJS.ErrnoException).code ?? 'read'})` }; }
  const parsed = parseDispatcherCapacity(text);
  if (!parsed) return { error: '디스패처 로그에 «Pod a/b» 줄 없음' };
  const at = lineTime(parsed.hhmmss, mtime);
  return { at: new Date(at).toISOString(), ageSeconds: Math.max(0, Math.round((now - at) / 1000)),
    podUsed: parsed.podUsed, podTarget: parsed.podTarget, localUsed: parsed.localUsed, localMax: parsed.localMax };
}

/**
 * 줄 머리 `HH:MM:SS`(KST)의 절대 시각 — 날짜는 로그 mtime 의 KST 날짜이고, 그 시각이 mtime 보다 뒤면 전날이다.
 * ⛔ mtime 을 관측 시각으로 쓰지 않는다 — 용량 줄 뒤에 다른 줄이 붙으면 낡은 값이 새것처럼 보인다.
 */
export function lineTime(hhmmss: string, mtimeMs: number): number {
  const [h, m, s] = hhmmss.split(':').map(Number) as [number, number, number];
  const KST = 9 * 3600_000;
  const dayStartKst = Math.floor((mtimeMs + KST) / 86400_000) * 86400_000 - KST;
  let t = dayStartKst + ((h * 60 + m) * 60 + s) * 1000;
  if (t > mtimeMs + 1000) t -= 86400_000;
  return t;
}

/** 디스패처가 손으로 쌓는 넘김 목록(`handed.txt`) — «없음»(ENOENT)만 빈 집합, 그 밖의 읽기 실패는 던진다(넘김 여부를 모르면 발사 가능을 셀 수 없다). */
export function readSeatEraHanded(dir: string): Set<string> {
  let text: string;
  try { text = readFileSync(join(dir, 'handed.txt'), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error(`handed.txt 못 읽음(${(error as NodeJS.ErrnoException).code ?? 'read'})`);
  }
  return new Set(text.split(/\s+/).filter(Boolean));
}
