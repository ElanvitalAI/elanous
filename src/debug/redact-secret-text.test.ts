// ── 텍스트 축 비밀 마스킹 (gitleaks 규칙 이식) 회귀 가드 ────────────────────────────────
//
// ⚠️ 이 모듈은 **전 서피스가 쓰는 공용 로거**의 일부다 — 오탐이 나면 모든 로그가 훼손되고,
// 미탐이 나면 비밀이 영속된다. 양쪽을 함께 잠근다.
//
// 패턴 출처 = gitleaks 기본 config(MIT) rule 정규식. 상류가 바뀌면 이 테스트가 대조 기준이다.
import { describe, expect, test } from 'bun:test';
import { redactSecretText, redactSecrets } from './log.js';

describe('redactSecretText — gitleaks 규칙 이식(탐지)', () => {
  const cases: readonly [string, string, string][] = [
    ['anthropic-api-key', `키 sk-ant-api03-${'a'.repeat(93)}AA 유출`, 'sk-ant-'],
    ['openai-api-key', `sk-proj-${'B'.repeat(74)}T3BlbkFJ${'C'.repeat(74)} 노출`, 'sk-proj-'],
    ['github-pat', `ghp_${'A'.repeat(36)} 커밋됨`, 'ghp_'],
    ['github-fine-grained', `github_pat_${'x'.repeat(82)}`, 'github_pat_'],
    ['aws-access-token', 'AKIAIOSFODNN7EXAMPLE 사용', 'AKIA'],
    ['slack-token', 'xoxb-1234567890-1234567890-abcdefghij', 'xoxb-'],
    ['gcp-api-key', `AIza${'B'.repeat(35)}`, 'AIza'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij', 'ey'],
    ['openrouter-api-key', `sk-or-v1-${'d'.repeat(64)} 설정됨`, 'sk-or-v1-'],
    ['xai-api-key', `xai-${'E'.repeat(80)} 설정됨`, 'xai-'],
  ];

  for (const [id, input, keepPrefix] of cases) {
    test(`⭐ ${id} 을 가리되 식별 접두는 남긴다`, () => {
      const out = redactSecretText(input);
      expect(out).toContain('***');
      expect(out).toContain(keepPrefix);
      // 원문 본문이 남지 않는다(복원 불가).
      const body = input.replace(/[^A-Za-z0-9_-]/g, '').slice(-20);
      expect(out).not.toContain(body);
    });
  }

  test('private key 블록 전체를 가린다', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'M'.repeat(200)}\n-----END RSA PRIVATE KEY-----`;
    const out = redactSecretText(`유출: ${pem}`);
    expect(out).not.toContain('MMMM');
  });

  test('key=value 형태의 비밀 키워드', () => {
    expect(redactSecretText('api_key = "supersecret"')).toContain('api_key = ***');
    expect(redactSecretText('password: hunter2xyz')).toContain('password: ***');
    expect(redactSecretText('token=abcd1234efgh')).toContain('token=***');
  });

  test('환경변수 형태 — 접두 없는 값도 이름으로 가린다', () => {
    expect(redactSecretText('OPENROUTER_API_KEY=abcdef0123456789zz')).toBe('OPENROUTER_API_KEY=***');
    expect(redactSecretText('export GROK_CODE_XAI_API_KEY="q1w2e3r4t5y6"')).toBe('export GROK_CODE_XAI_API_KEY=***"');
    expect(redactSecretText('GH_TOKEN: abcd1234efgh5678')).toBe('GH_TOKEN: ***');
  });

  test('Authorization 헤더', () => {
    const out = redactSecretText('Authorization: Bearer abcdefghijklmnop');
    expect(out).not.toContain('abcdefghijklmnop');
  });
});

describe('redactSecretText — 오탐 가드(로그가 못 쓰게 되면 안 된다)', () => {
  const normals = [
    'src/self-implement/gate-scope.ts 의 판정이 틀렸다',
    'unverified 가 개수만 실려 Goodhart 테스트가 됐다',
    '변경 파일 9개 타입 검사 통과',
    'https://github.com/ElanvitalAI/elanous/pull/5502',
    'bun test test/self-implement-seams.test.ts',
    'runId=run-8f7ba351-cb40-4745-a5c3-34c18ca978f8',
    'MAX_TOKEN=4096',
    'OPENROUTER_API_KEY 가 없다',
  ];
  for (const n of normals) {
    test(`훼손하지 않는다: ${n.slice(0, 40)}`, () => {
      expect(redactSecretText(n)).toBe(n);
    });
  }

  test('빈 값·null 안전', () => {
    expect(redactSecretText('')).toBe('');
    expect(redactSecretText(undefined as unknown as string)).toBe('');
  });
});

describe('redactSecrets — 키 축 ⊕ 텍스트 축 (공용 소비자 무회귀)', () => {
  test('종전 키 축 동작이 그대로다 — authorization 은 앞뒤 4자만', () => {
    const o = redactSecrets({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }) as Record<string, string>;
    expect(o.authorization).toContain('…');
    expect(o.authorization).not.toContain('ijklmnop');
  });

  test('짧은 비밀 키는 <redacted>', () => {
    expect((redactSecrets({ apikey: 'short' }) as Record<string, string>).apikey).toBe('<redacted>');
  });

  test('⭐ 신규 — **값 안의** 토큰도 가린다(키 축만으론 통과했다)', () => {
    const o = redactSecrets({ note: `실패 원인: ghp_${'A'.repeat(36)} 이 만료됨` }) as Record<string, string>;
    expect(o.note).toContain('ghp_***');
    expect(o.note).toContain('실패 원인');           // 문장은 보존
  });

  test('중첩 객체·배열도 텍스트 축이 적용된다', () => {
    const o = redactSecrets({ a: { b: ['AKIAIOSFODNN7EXAMPLE'] } }) as { a: { b: string[] } };
    expect(o.a.b[0]).toContain('AKIA***');
  });

  test('비-문자열 값은 변형하지 않는다(무회귀)', () => {
    const o = redactSecrets({ n: 42, b: true, z: null }) as Record<string, unknown>;
    expect(o).toEqual({ n: 42, b: true, z: null });
  });
});
