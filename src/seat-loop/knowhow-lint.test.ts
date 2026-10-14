import { describe, expect, test } from 'bun:test';
import { KnowhowLintError, lintKnowhow } from './knowhow-lint.js';

const FILE = 'docs/roles/OP/KNOWHOW.md';

interface CardSpec {
  omit?: string[];
  fields?: Record<string, string>;
}

function cardBody({ omit = [], fields = {} }: CardSpec = {}): string {
  const defaults: Record<string, string> = {
    '상황': '릴리스 게이트가 빨간 칸을 못 본다',
    '신호(관측)': 'release checklist status 에서 칸이 노랑으로 남는다',
    '원인': '칸 갱신 CLI 를 부모가 치지 않았다',
    '처방': '칸 담당이 set 으로 갱신하고 원장에 근거를 남긴다',
    '재는 명령': 'bun bin/elanous.mjs --test release checklist status --json',
    '기대': '빨간 칸 0개',
    '유효 조건': '판이 열려 있는 동안에만 유효',
    '검증': '2026-10-12 실측 통과',
    '출처': 'OBS-T900',
    '상태': '유효',
  };
  const lines = Object.entries({ ...defaults, ...fields })
    .filter(([label]) => !omit.includes(label))
    .map(([label, value]) => `- ${label}: ${value}`);
  return `# OP 노하우\n\n## K-OP-7: 게이트 칸 갱신\n\n${lines.join('\n')}\n\n## 다음 절\n\n본문.\n`;
}

describe('lintKnowhow', () => {
  test('정상 카드는 통과한다', () => {
    expect(() => lintKnowhow(cardBody(), FILE)).not.toThrow();
  });

  test('필수 칸이 누락되면 명시 거부한다', () => {
    for (const field of ['처방', '재는 명령', '기대', '검증', '출처', '상황', '원인', '유효 조건']) {
      expect(() => lintKnowhow(cardBody({ omit: [field] }), FILE)).toThrow(KnowhowLintError);
      expect(() => lintKnowhow(cardBody({ omit: [field] }), FILE)).toThrow(`필수 칸 누락: ${field}`);
    }
    expect(() => lintKnowhow(cardBody({ omit: ['상태'] }), FILE)).toThrow('필수 칸 누락: 상태');
  });

  test('필수 칸의 빈 값과 출처에 합친 빈 상태 값을 거부한다', () => {
    for (const field of ['상황', '신호(관측)', '원인', '처방', '기대', '유효 조건', '검증', '출처', '상태']) {
      const label = field.replace(/\s*\([^)]*\)/u, '');
      expect(() => lintKnowhow(cardBody({ fields: { [field]: '  ' } }), FILE)).toThrow(`필수 칸 누락: ${label}`);
    }
    for (const source of ['OBS-T900 · 상태:', 'OBS-T900 · 상태:   ', 'OBS-T900 · 상태: · 검증: 완료']) {
      const body = cardBody({ omit: ['상태'], fields: { '출처': source } });
      expect(() => lintKnowhow(body, FILE)).toThrow('필수 칸 누락: 상태');
    }
    expect(() => lintKnowhow(cardBody({ omit: ['상태'], fields: { '출처': 'OBS-T900 · 상태: active' } }), FILE)).not.toThrow();
    expect(() => lintKnowhow(cardBody({ omit: ['상태'], fields: { '출처': '· 상태: active' } }), FILE)).toThrow('필수 칸 누락: 출처');
  });

  test('빈 필수 칸을 같은 이름의 다음 값으로 덮어도 거부한다', () => {
    const body = cardBody().replace('- 기대: 빨간 칸 0개', '- 기대:\n- 기대: 빨간 칸 0개');
    expect(() => lintKnowhow(body, FILE)).toThrow('필수 칸 누락: 기대');
    const duplicate = cardBody().replace('- 기대: 빨간 칸 0개', '- 기대: 하나\n- 기대: 둘');
    expect(() => lintKnowhow(duplicate, FILE)).toThrow('중복 칸: 기대');
  });

  test('쓰기 명령이면 명시 거부한다', () => {
    const writes = ['git show --textconv HEAD:file.bin', 'git show --ext-diff HEAD:file.bin', 'git log --exec=touch/out HEAD', 'git show --format=%H --textconv HEAD:file.bin', 'rm -rf .elanous-test', 'git push origin main', 'mv a.md b.md', 'npm install left-pad', 'config set llm.provider grok', 'provider:set gemini', 'schedule create --cron 5 8 * * *', 'echo hi > out.txt', 'echo hi>out.txt', 'echo hi>>out.txt', 'echo hi>/dev/nullx', 'echo hi 2>out.txt', 'echo hi &>out.txt', 'echo hi > >(tee out.txt)', 'cat <(touch out.txt)', 'install source dest', 'git -c alias.log=!touch log', 'python3 -c "open(\'out.txt\',\'w\')"', 'rg something src | install source dest', 'sort -oout.txt input.txt', 'constructor out.txt'];
    for (const command of writes) {
      expect(() => lintKnowhow(cardBody({ fields: { '재는 명령': command } }), FILE)).toThrow(/재는 명령이 읽기 전용이 아님/);
    }
  });

  test('logs 하위 명령의 상태 변경은 측정 명령으로 거부한다', () => {
    for (const command of ['eln logs level verbose', 'bun bin/elanous.mjs logs level verbose', 'eln logs timeline --out report.txt', 'eln logs --unknown-option']) {
      expect(() => lintKnowhow(cardBody({ fields: { '재는 명령': command } }), FILE)).toThrow('재는 명령이 읽기 전용이 아님');
    }
    for (const command of ['eln logs --category self-review --since 6h --limit 3', 'bun bin/elanous.mjs --test logs --json']) {
      expect(() => lintKnowhow(cardBody({ fields: { '재는 명령': command } }), FILE)).not.toThrow();
    }
  });

  test('읽기 전용 재는 명령은 통과한다', () => {
    for (const command of ['bun bin/elanous.mjs --test logs --category harness --limit 5', 'rg -n "seat-pack" src/', 'cat release/next.md', 'eln tasks close --help >/dev/null 2>&1 && echo HAS || echo NONE', 'git rev-parse --git-dir >/dev/null 2>&1 || echo NOT', 'git show --stat HEAD', 'git log --oneline -1']) {
      expect(() => lintKnowhow(cardBody({ fields: { '재는 명령': command } }), FILE)).not.toThrow();
    }
  });

  test('비밀 표식이 보이면 명시 거부한다', () => {
    const secrets: Array<[string, string, RegExp]> = [
      ['api key', 'token 이 새었다: sk-abcdefghijklmnopqrst', /비밀 표식 \(api key\)/],
      ['project api key', `token 이 새었다: sk-proj-${'a'.repeat(24)}`, /비밀 표식 \(api key\)/],
      ['github token', 'ghp_ABCDEFGHIJKLMNOPQRSTUV', /비밀 표식 \(github token\)/],
      // \u{1F451} 이스케이프로 조립 — 리터럴로 적으면 이 시험 파일 스스로 공개본 leak(ceo-mark)이 된다.
      ['royal marker', `왕표식 ${'\u{1F451}'} 이 파일에 남았다`, /비밀 표식 \(royal marker\)/],
      ['absolute user path', '/Users/alice/notes.md 경로가 보인다', /비밀 표식 \(absolute user path\)/],
    ];
    for (const [, poison, message] of secrets) {
      expect(() => lintKnowhow(cardBody({ fields: { '검증': poison } }), FILE)).toThrow(message);
    }
  });

  test('카드 밖 본문도 비밀 검사 대상이고 칸 검증은 카드에만 적용된다', () => {
    const body = cardBody().replace('본문.', '본문의 명령 예시 rm -rf 는 측정 명령이 아니다.');
    expect(() => lintKnowhow(body, FILE)).not.toThrow();
    const token = `ghp_${'A'.repeat(24)}`;
    for (const poisoned of [body.replace('# OP 노하우', `# OP 노하우 ${token}`), body.replace('본문의 명령', `${token} 본문의 명령`)]) {
      try {
        lintKnowhow(poisoned, FILE);
        throw new Error('secret was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(KnowhowLintError);
        expect((error as Error).message).toContain('비밀 표식 (github token)');
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  test('중복 재는 명령의 앞선 쓰기 명령도 거부한다', () => {
    const body = cardBody().replace(
      '- 재는 명령: bun bin/elanous.mjs --test release checklist status --json',
      '- 재는 명령: rm -rf /tmp/x\n- 재는 명령: git show --stat HEAD',
    );
    expect(() => lintKnowhow(body, FILE)).toThrow('재는 명령이 읽기 전용이 아님');
  });

  test('카드 밖 fine-grained GitHub PAT도 거부하고 원문은 숨긴다', () => {
    const token = `github_pat_${'A'.repeat(24)}_${'B'.repeat(24)}`;
    const body = cardBody().replace('본문.', `${token}\n본문.`);
    try {
      lintKnowhow(body, FILE);
      throw new Error('secret was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(KnowhowLintError);
      expect((error as Error).message).toContain('비밀 표식 (github token)');
      expect((error as Error).message).not.toContain(token);
    }
  });

  test('비밀이 섞인 쓰기 명령은 비밀 검사로 먼저 거부하고 원문을 출력하지 않는다', () => {
    const token = `ghp_${'B'.repeat(24)}`;
    for (const command of [`echo ${token}>out.txt`, 'echo private-data>out.txt']) {
      try {
        lintKnowhow(cardBody({ fields: { '재는 명령': command } }), FILE);
        throw new Error('write was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(KnowhowLintError);
        expect((error as Error).message).not.toContain(command);
        expect((error as Error).message).not.toContain(token);
        expect((error as Error).message).toContain(command.includes(token) ? '비밀 표식 (github token)' : '재는 명령이 읽기 전용이 아님');
      }
    }
  });

  test('카드 제목이 형식을 벗어나면 인식 실패를 명시 거부한다', () => {
    for (const id of ['K-OP-7a', 'K-OP', 'K-OP-7.5', 'K--7', 'k-OP-7', 'K-OP-7게이트']) {
      const body = cardBody().replace('## K-OP-7: 게이트 칸 갱신', `## ${id}: 게이트 칸 갱신`);
      expect(() => lintKnowhow(body, FILE)).toThrow(KnowhowLintError);
      expect(() => lintKnowhow(body, FILE)).toThrow('카드 제목 형식');
    }
  });

  test('들여 쓴 Markdown 제목도 카드로 인식해 필수 칸을 검사한다', () => {
    const valid = cardBody().replace('## K-OP-7:', '  ## K-OP-7:');
    expect(() => lintKnowhow(valid, FILE)).not.toThrow();
    const missing = `${cardBody()}\n  ## K-OP-8: 빈 카드\n- 상황: 새 카드\n`;
    expect(() => lintKnowhow(missing, FILE)).toThrow('K-OP-8 — 필수 칸 누락: 신호');
  });

  test('코드 펜스 안의 칸과 카드 제목은 실제 카드로 세지 않는다', () => {
    const missing = cardBody({ omit: ['검증'] }).replace(
      '- 출처: OBS-T900',
      '```md\n- 검증: 통과\n## K-OP-8: 코드 예시\n```\n- 출처: OBS-T900',
    );
    expect(() => lintKnowhow(missing, FILE)).toThrow('K-OP-7 — 필수 칸 누락: 검증');
    const valid = cardBody().replace('본문.', '```md\n## K-OP-8: 코드 예시\n```\n본문.');
    expect(() => lintKnowhow(valid, FILE)).not.toThrow();
    const nestedInfo = cardBody({ omit: ['검증'] }).replace(
      '- 출처: OBS-T900',
      '```md\n```md\n- 검증: 통과\n```\n- 출처: OBS-T900',
    );
    expect(() => lintKnowhow(nestedInfo, FILE)).toThrow('필수 칸 누락: 검증');
  });

  test('카드가 0개면 명시 거부한다', () => {
    for (const body of ['# OP 노하우\n\n카드 없는 본문.\n', '본문만 있다.\n', '']) {
      expect(() => lintKnowhow(body, FILE)).toThrow(KnowhowLintError);
      expect(() => lintKnowhow(body, FILE)).toThrow('카드가 0개');
    }
  });

  test('재는 명령의 들여 쓴 이어 줄도 검사한다', () => {
    for (const extra of ['rm -rf .elanous-test', 'git push origin main', 'echo hi > out.txt', '이어서 관측']) {
      const body = cardBody().replace(
        '- 재는 명령: bun bin/elanous.mjs --test release checklist status --json',
        `- 재는 명령: git status\n  ${extra}`,
      );
      expect(() => lintKnowhow(body, FILE)).toThrow('재는 명령이 읽기 전용이 아님');
    }
  });

  test('재는 명령의 여러 줄이 모두 읽기 전용이면 통과한다', () => {
    const body = cardBody().replace(
      '- 재는 명령: bun bin/elanous.mjs --test release checklist status --json',
      '- 재는 명령: git status\n  git rev-parse --git-dir >/dev/null 2>&1 || echo NOT',
    );
    expect(() => lintKnowhow(body, FILE)).not.toThrow();
  });
});
