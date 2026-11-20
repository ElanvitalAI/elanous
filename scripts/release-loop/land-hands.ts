/**
 * LAND-TWO-HANDS-TRAIN — 착지 손 2 ⊕ 가벼운 PR 묶음 열차의 한 틱 계획.
 *
 * - 전역 착지 슬롯 상한은 2 그대로다(`LAND_HANDS`). 비어 있는 슬롯 수만큼, 파일이 겹치지 않는 손을
 *   «같은 틱에» 함께 낸다. 둘째 손을 첫 손 시작 직후 짧은 창에만 허용하던 운영 규칙(pair window)은 두지 않는다.
 * - 시험 전용·문서 전용 PR 은 3~4개를 한 열차로 묶고 기준선(base 측정)은 열차마다 한 번만 잰다.
 *   코드 PR 은 가벼운 열차에 절대 섞지 않는다(코드 손은 단건).
 * - 판단 근거가 없으면(파일 목록 미측정) 내지 않고 기다린다 · 남의 슬롯은 지우지 않는다(죽은 보유자는 보고만).
 * 옵션 없음 — 아래 상수가 기본값이자 유일한 값이다.
 */
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LAND_HANDS = 2;
export const LIGHT_TRAIN_MIN = 3;
export const LIGHT_TRAIN_MAX = 4;
/** 대표 10-19 «일반 묶음도 최대 대기 30분» — 짝이 모자라도 가장 오래 기다린 가벼운 PR 이 30분이면 출발한다. */
export const LIGHT_TRAIN_MAX_WAIT_MS = 30 * 60_000;

export type PrKind = 'test-only' | 'docs-only' | 'code';
export interface QueuedPr { pr: string; head: string; queuedAt: number; files: string[] | null }
export interface HeldSlot { name: string; prs: string[]; files: string[] | null; pid: number | null }
export interface Hand { kind: 'code' | 'light-train'; prs: string[]; files: string[]; baselines: 1 }
export interface TickPlan {
  hands: Hand[];
  waiting: { pr: string; reason: 'slots-full' | 'files-unmeasured' | 'file-overlap' | 'train-filling' | 'next-train' }[];
  staleSlots: string[];
}

const TEST_FILE = /(^|\/)(test|tests|fixtures|__fixtures__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[\w-]+\.py$|\.test\.py$/;
const DOCS_FILE = /^(docs\/.+\.md|release\/public\/docs\/.+\.md|website\/pages\.json)$/;

export function classifyPr(files: string[]): PrKind {
  if (files.length > 0 && files.every((f) => TEST_FILE.test(f))) return 'test-only';
  if (files.length > 0 && files.every((f) => DOCS_FILE.test(f))) return 'docs-only';
  return 'code';
}

/** 한 틱: 빈 슬롯마다 손 하나. 손끼리·보유 슬롯과 파일이 겹치면 다음 틱으로. */
export function planLandingTick(queue: QueuedPr[], held: HeldSlot[], now: number,
  isAlive: (pid: number) => boolean): TickPlan {
  const plan: TickPlan = { hands: [], waiting: [], staleSlots: [] };
  for (const slot of held) if (slot.pid !== null && !isAlive(slot.pid)) plan.staleSlots.push(slot.name);
  // 죽은 보유자의 슬롯도 상한에는 센다(fail-closed) — 거두기는 OP 몫.
  let free = Math.max(0, LAND_HANDS - held.length);
  const busyPrs = new Set(held.flatMap((s) => s.prs));
  const taken = new Set<string>();
  let heldFilesKnown = true;
  for (const slot of held) {
    if (slot.files === null) heldFilesKnown = false;
    else for (const f of slot.files) taken.add(f);
  }
  const overlaps = (files: string[]) => !heldFilesKnown || files.some((f) => taken.has(f));
  const take = (hand: Hand) => { plan.hands.push(hand); for (const f of hand.files) taken.add(f); free -= 1; };

  const light: QueuedPr[] = [];
  const code: QueuedPr[] = [];
  for (const row of queue) {
    if (busyPrs.has(row.pr)) continue;
    if (row.files === null || row.files.length === 0) { plan.waiting.push({ pr: row.pr, reason: 'files-unmeasured' }); continue; }
    (classifyPr(row.files) === 'code' ? code : light).push(row);
  }
  // 가벼운 열차: 서로·보유 슬롯과 겹치지 않는 앞쪽 3~4개.
  const train: QueuedPr[] = [];
  const trainFiles = new Set<string>();
  for (const row of light) {
    if (train.length >= LIGHT_TRAIN_MAX || overlaps(row.files!) || row.files!.some((f) => trainFiles.has(f))) continue;
    train.push(row);
    for (const f of row.files!) trainFiles.add(f);
  }
  const oldest = Math.min(...train.map((r) => r.queuedAt));
  const trainReady = train.length >= LIGHT_TRAIN_MIN || (train.length > 0 && now - oldest >= LIGHT_TRAIN_MAX_WAIT_MS);
  // 큐 순서를 지킨다: 가장 앞 줄이 코드면 코드 손 먼저, 가벼운 줄이면 열차 먼저.
  const lightFirst = trainReady && (code.length === 0 || queue.indexOf(train[0]) < queue.indexOf(code[0]));
  const placeTrain = () => {
    if (!trainReady || free <= 0 || [...trainFiles].some((f) => taken.has(f))) return;
    take({ kind: 'light-train', prs: train.map((r) => r.pr), files: [...trainFiles].sort(), baselines: 1 });
  };
  if (lightFirst) placeTrain();
  for (const row of code) {
    if (free <= 0) { plan.waiting.push({ pr: row.pr, reason: 'slots-full' }); continue; }
    if (overlaps(row.files!)) { plan.waiting.push({ pr: row.pr, reason: 'file-overlap' }); continue; }
    take({ kind: 'code', prs: [row.pr], files: [...row.files!].sort(), baselines: 1 });
  }
  if (!lightFirst) placeTrain();
  const boarded = new Set(plan.hands.flatMap((h) => h.prs));
  for (const row of light) {
    if (boarded.has(row.pr)) continue;
    if (!train.includes(row)) plan.waiting.push({ pr: row.pr, reason: overlaps(row.files!) ? 'file-overlap' : 'next-train' });
    else plan.waiting.push({ pr: row.pr, reason: !trainReady ? 'train-filling' : free <= 0 ? 'slots-full' : 'file-overlap' });
  }
  return plan;
}

/** 슬롯 디렉터리(`<slots>/<이름>/owner.json`) 를 읽는다. 읽지 못한 메타는 «파일 모름»(겹침으로 친다). */
export function readHeldSlots(slotsDir: string): HeldSlot[] {
  return readdirSync(slotsDir).filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(slotsDir, name)).isDirectory())
    .map((name) => {
      try {
        const meta = JSON.parse(readFileSync(join(slotsDir, name, 'owner.json'), 'utf8')) as Partial<HeldSlot>;
        return { name, prs: Array.isArray(meta.prs) ? meta.prs.map(String) : [],
          files: Array.isArray(meta.files) ? meta.files.map(String) : null,
          pid: typeof meta.pid === 'number' ? meta.pid : null };
      } catch {
        return { name, prs: [], files: null, pid: null };
      }
    });
}

export interface TickDeps {
  slotsDir: string;
  now: () => number;
  pid: number;
  isAlive: (pid: number) => boolean;
  /** 열차·손마다 한 번 — base 기준선 측정(시험 파일 합집합). */
  measureBaseline: (hand: Hand) => void;
  /** 착지 시작(비동기 가능). 끝나면 호출자가 `releaseHand` 한다. */
  land: (hand: Hand, slotName: string) => void;
}

const slotName = (hand: Hand) => `HAND-${hand.prs.join('+')}`;

/**
 * 한 틱 실행: `.reserve-lock`(mkdir) 안에서 슬롯을 다시 세고 계획한 뒤 손마다 슬롯을 만든다.
 * 잠금을 못 잡으면 아무 것도 하지 않는다(다음 틱).
 */
export function runLandingTick(queue: QueuedPr[], deps: TickDeps): TickPlan | 'lock-busy' {
  const lock = join(deps.slotsDir, '.reserve-lock');
  try { mkdirSync(lock); } catch { return 'lock-busy'; }
  let plan: TickPlan;
  try {
    plan = planLandingTick(queue, readHeldSlots(deps.slotsDir), deps.now(), deps.isAlive);
    for (const hand of plan.hands) {
      const dir = join(deps.slotsDir, slotName(hand));
      mkdirSync(dir);
      writeFileSync(join(dir, 'owner.json'), `${JSON.stringify({ prs: hand.prs, files: hand.files, pid: deps.pid })}\n`);
    }
  } finally {
    rmdirSync(lock);
  }
  for (const hand of plan.hands) {
    deps.measureBaseline(hand);
    deps.land(hand, slotName(hand));
  }
  return plan;
}

/** 내가 만든 슬롯만 푼다 — owner.json 의 pid 가 내 것이 아니면 건드리지 않는다. */
export function releaseHand(slotsDir: string, name: string, pid: number): boolean {
  const meta = join(slotsDir, name, 'owner.json');
  try {
    if ((JSON.parse(readFileSync(meta, 'utf8')) as { pid?: unknown }).pid !== pid) return false;
    unlinkSync(meta);
    rmdirSync(join(slotsDir, name));
    return true;
  } catch {
    return false;
  }
}
