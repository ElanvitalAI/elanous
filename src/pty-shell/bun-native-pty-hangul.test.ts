// ELS-IME-HANGUL-COMPOSE — PTY 출력 stream 디코드의 물리는 경비 (출처: seat-state/OP/PLAN-OP-TYPING-1122.md 행 9 · «조합 바이트 조각 보존»).
// 뮤테이션 실측(2026-11-22): bunSpawnPty 의 스트리밍 TextDecoder 를 청크별 디코드로 바꿔도
// 기존 그 어떤 시험도 빨강이 되지 않았다(herdr-agent-report 38/38 green — 그 시험은 herdr 러너 stdout 겹).
// 이 시험이 그 갭을 잡는다: 음절 중간에서 갈린 PTY 출력 청크는 조합되어 나와야 한다(U+FFFD 금지).
//
// 결정성(terra 재리뷰 r2 mustFix · 2026-11-22): r1 의 sleep 0.1 은 5b87ed3214 에서 동기 신호('A' 관측 후
// stdin 'go')로 이미 대체됐다. r2 지적은 그 관측의 잔여 구멍이다 — 디코드된 문자열 'A' 는 리드 바이트
// 0xED 가 같은 읽기에 있었는지 숨긴다(0xED 가 뒤 이벤트의 지속 바이트와 한 덩어리로 오면 이 시험은
// 뮤테이션 하에서도 공석 초록이 된다). 수리: 전역 TextDecoder 를 기록 서브클래스로 잠시 바꿔
// bunSpawnPty 내부 decode() 의 원시 바이트 입력을 관측하고, 「0xED 로 끝나는 입력 → 0x95 로 시작하는
// 다음 입력」의 음절 중간 분리를 바이트 수준으로 검증한다. 분리가 관측되지 않으면 조용히 통과하지 않고
// 명시적으로 실패한다(공석 경비 금지 — terra r2 mustFix «리드 바이트가 별도 읽기임을 보장하거나 검증»).
// 생산 코드는 무변경 — 관측은 bunSpawnPty 가 실제로 타는 배선(전역 TextDecoder + decode(stream))을 그대로 탄다.
//  - 뮤테이션(청크별 디코드)은 분리된 청크에서 반드시 U+FFFD 를 만들므로 빨강.
//  - Bun native PTY 가 아닌 환경(node-pty 폴백 — 이 모듈 밖 경로)은 test.skipIf 로 명시적 skip 집계.
import { expect, test } from 'bun:test';
import { bunNativePtyAvailable, bunSpawnPty } from './bun-native-pty.js';

/** decode() 의 원시 바이트 입력을 남기는 TextDecoder 서브클래스 — bunSpawnPty 가 전역 TextDecoder 로
 * 디코드하는 실제 배선 위에서 관측한다(생산 코드 무변경 · 이 시험 창에서만 전역을 잠시 바꾼다). */
class RecordingTextDecoder extends TextDecoder {
  static readonly inputs: Uint8Array[] = [];
  override decode(input?: BufferSource, options?: TextDecodeOptions): string {
    if (input) {
      const view = input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
      RecordingTextDecoder.inputs.push(new Uint8Array(view)); // 복사 — 런타임 버퍼 재사용 오염 차단
    }
    return super.decode(input, options);
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

test.skipIf(!bunNativePtyAvailable())('PTY output split mid-syllable across chunks decodes composed 한, never U+FFFD', async () => {
  const realTextDecoder = globalThis.TextDecoder;
  globalThis.TextDecoder = RecordingTextDecoder as unknown as typeof TextDecoder;
  let splitVerified = false;
  let lastInputs: Uint8Array[] = [];
  try {
    for (let attempt = 1; attempt <= 3 && !splitVerified; attempt++) {
      RecordingTextDecoder.inputs.length = 0;
      // sh printf 8진 이스케이프: \355\225\234 = ED 95 9C = '한'. 첫 쓰기는 'A'+리드 바이트 0xED(단일 write) —
      // 나머지 바이트는 stdin 'go' 신호 뒤에만 나간다(관측 후 순서 강제 · sleep 비결정성 없음).
      const pty = bunSpawnPty('/bin/sh', ['-c', "stty -echo; printf 'A\\355'; IFS= read -r _; printf '\\225\\234\\355\\225\\234'; exit 0"], {
        cols: 40, rows: 10, name: 'xterm-256color',
      });
      let sawLeadMarker = false;
      let out = '';
      const data = pty.onData((chunk) => {
        out += chunk;
        if (!sawLeadMarker && chunk.includes('A')) {
          sawLeadMarker = true;
          pty.write('go\n'); // 관측 후 순서 강제 — 첫 절반 소진 확인 뒤에만 둘째 절반 방아쇠
        }
      });
      const exited = await new Promise<{ exitCode: number | null }>((resolve) => pty.onExit((e) => resolve(e)));
      // JUD-C HOLD mustFix ①(판정 judb-39555-42b3973d6400.json): 리스너 해제는 출력 완결 관찰 뒤에만.
      // onExit 직후에 data.dispose() 하면 이 100ms 배수 창이 열려도 리스너가 이미 풀려 있어 잔여 PTY 버퍼가
      // 늦게 도착하는 스케줄에서 수신 자체가 불가능해 거짓 실패가 난다 — 대기한 뒤 해제한다.
      if (!out.includes('한한')) {
        // 종료 직후 잔여 PTY 버퍼 배수(관측 완결 보조 · 리스너 부착 상태로 대기 — 정확성은 아래 검증이 담당)
        await new Promise((r) => setTimeout(r, 100));
      }
      data.dispose();
      expect(exited.exitCode).toBe(0);
      expect(out).toContain('한한');
      expect(out).not.toContain(String.fromCharCode(0xFFFD)); // 실제 문자 U+FFFD 검사 (출처: OP #129776 ① · JUD-C #129771) — 이스케이프 해석 여지 원천 차단
      // 바이트 수준 분리 검증(terra r2 mustFix): 관측된 decode 입력 중 리드 바이트 0xED 가 지속 바이트(0x95)
      // 와 다른 입력에 담긴 음절 중간 경계가 실제로 있어야 한다 — 있어야 뮤테이션이 잡힌다.
      const inputs = RecordingTextDecoder.inputs.slice();
      lastInputs = inputs;
      expect(inputs.length).toBeGreaterThan(0); // 출처: #39555 terra r2 재리뷰 검증 요건 — 관측 배열 하한 0개 = decode 배선 미관측(전역 TextDecoder 미사용)
      splitVerified = inputs.some((b, i) =>
        b.length > 0 && b[b.length - 1] === 0xed
        && i + 1 < inputs.length && inputs[i + 1].length > 0 && inputs[i + 1][0] === 0x95);
    }
    if (!splitVerified) {
      // 3회 모두 분리 미관측 — 이 스케줄링에서는 경비가 공석이므로 조용한 초록 대신 명시적 실패.
      throw new Error('mid-syllable split not observed: no 0xED|0x95 boundary in decode inputs — guard would be vacuous. inputs=' + lastInputs.map(hex).join(' | '));
    }
  } finally {
    globalThis.TextDecoder = realTextDecoder;
  }
}, 10_000);

// 음성 회귀(출처: OP #129776 ② · JUD-C #129771): 일부러 잘린 UTF-8 — «한»(ED 95 9C)의 앞 2바이트 뒤에
// 비지속 바이트 'B' — 를 넣으면 실제 U+FFFD 가 디코드 출력에 생겨야 한다. 위 not.toContain(U+FFFD) 금지가
// 깨진 문자를 실제로 잡는다는 검출 방향 증명(공석 금지). 붕괴 경로를 고정하므로 완성 음절 «한» 이 나오면 안 된다.
test.skipIf(!bunNativePtyAvailable())('deliberately truncated UTF-8 emits real U+FFFD (negative control for the U+FFFD ban)', async () => {
  const pty = bunSpawnPty('/bin/sh', ['-c', "stty -echo; printf 'A\\355\\225B'; exit 0"], {
    cols: 40, rows: 10, name: 'xterm-256color',
  });
  let out = '';
  const data = pty.onData((chunk) => { out += chunk; });
  const exited = await new Promise<{ exitCode: number | null }>((resolve) => pty.onExit((e) => resolve(e)));
  if (!out.includes('B')) {
    // 종료 직후 잔여 PTY 버퍼 배수 — 리스너 부착 상태로 대기(위 본시험과 같은 관측 완결 규칙 · sleep 0.1 비결정성 없음).
    await new Promise((r) => setTimeout(r, 100));
  }
  data.dispose();
  expect(exited.exitCode).toBe(0);
  expect(out).toContain('B');
  expect(out).toContain(String.fromCharCode(0xFFFD)); // 잘린 «한» 앞 2바이트(ED 95)가 'B' 에 의해 붕괴 → 실제 U+FFFD 관측
  expect(out).not.toContain('한'); // 붕괴 경로 고정 — 완성 음절이 나오면 이 음성 회귀의 전제가 깨진다
}, 10_000);
