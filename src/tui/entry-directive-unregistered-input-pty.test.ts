import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

// TUI-REGRESS R5 보강 회귀 (JUD-C #39530 mustFix ① · head ebaf9bb3423b3d32674402871d108c7f3f9653b4).
// 정적 검사(scripts/lib/tui-regress-checks.ts judgePalette)는 zz-regress-unregistered 스냅샷이
// 빈 문자열이어도 «없음=false» 기대와 일치해 통과했다 — 빈 화면 정적 반례(JUD-C 증거: :46-50 paletteHas,
// :73-79 judgePalette, :114-119 단계가 /zz- 를 친다). 이 PTY 회귀는 미등록 접두어를 친 «그 순간의 실제
// 화면»에서 (1) 세션이 준비돼 있고(❯ 입력칸), (2) 입력행에 /zz- 가 실제로 렌더됐고, (3) 팔레트에는
// /zz- 항목이 보이지 않으며, (4) 이어서 친 등록 접두어 /hel 에는 /help 가 팔레트에 보이는지를 함께
// 단언한다. 프레임이 비어 있거나(필요 마커 부재) 입력행에 /zz- 가 없으면 아래 단언들이 실패한다 —
// «별도 help 화면이 정상»이라는 사정만으로는 통과할 수 없다.
// 기대값은 제품 상수·렌더 함수가 아니라 이 파일의 독립 리터럴/정규식이다(저장소 규칙).
// ⛔ 로컬 bun test 실행 금지(이 맥) — 검증은 원격 절차로 소유자가 수행한다.
test('unregistered /zz- prefix renders in the input row while the session stays ready and the palette stays clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zz-unregistered-input-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 40, cols: 100,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1' },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        // R5 PALETTE_STEPS 와 같은 입력(`/${name.slice(0, 3)}` = '/zz-') — Enter 없이 사람처럼 친다.
        { label: 'zz-typed', text: '/zz-', enter: false, until: (screen) => screen.includes('/zz-') },
        { label: 'zz-erased', keys: '\x7f\x7f\x7f\x7f', until: (screen) => !screen.includes('/zz-') },
        // 양성 대조 — 등록 접두어 /hel 은 같은 자리에서 /help 를 팔레트에 보인다(R4).
        { label: 'hel-palette', text: '/hel', enter: false, until: (screen) => screen.includes('/help') },
      ],
    });
    const frame = (label: string) => run.frames.find((entry) => entry.label === label)?.screen ?? '';
    // 화면 판독 보조 — tui-regress-checks.ts contentLines/inputRow 규약을 리터럴로 옮겨온 것(제품 의존 없음).
    const contentLines = (screen: string) =>
      screen.split('\n').map((line) => line.replace(/[\u2500-\u259F]/g, ' ')).filter((line) => line.trim().length > 0);
    const inputRow = (screen: string) => contentLines(screen).filter((line) => line.trimStart().startsWith('❯')).at(-1);

    expect(run.exitCode).toBe(0);
    // (1) 준비 — 부팅 프레임에 입력칸이 있었다(ready 캡처는 미충족·조기 종료 시 throw 한다).
    expect(inputRow(frame('boot'))).toBeDefined();
    // (2) 미등록 입력 화면 — 빈 화면·입력 누락이면 실패: 프레임이 비어 있으면 inputRow undefined,
    //     그리고 필요 마커 '/zz-' 가 입력행에 없으면 toContain 이 실패한다.
    const zz = frame('zz-typed');
    expect(zz.trim().length).toBeGreaterThan(0); // 출처: #39530 — zz 프레임 잔류 하한(0): 캡처 화면이 비면 inputRow 판별 전에 실패해야 한다(빈 화면 백스톱)
    expect(inputRow(zz)).toBeDefined();
    expect(inputRow(zz) ?? '').toContain('/zz-');
    // (3) 팔레트 청결 — /zz- 는 입력행 밖 어느 줄에도 없다(미등록 이름은 그 어떤 경우에도 보이지 않는다).
    const row = inputRow(zz);
    expect(contentLines(zz).some((line) => line !== row && line.includes('/zz-'))).toBe(false);
    // (4) 양성 대조 — /hel 화면에서 /help 는 입력행이 아닌 팔레트 줄에 보인다.
    const hel = frame('hel-palette');
    const helRow = inputRow(hel);
    expect(contentLines(hel).some((line) => line !== helRow && line.includes('/help'))).toBe(true);
    // 지운 뒤에는 /zz- 잔류가 없다.
    expect(frame('zz-erased')).not.toContain('/zz-');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
