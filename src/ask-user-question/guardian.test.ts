/**
 * Guardian r8 시험 — OP #92922 «합집합 · fail-closed» 재설계(#38826 r2).
 * · 기본 = main 원문 스캔 결과 그대로 — JUD 탐침 «덜 막는 회귀»(20261119-0351) 전부 회복.
 * · 좁은 예외 = 프린터(echo·printf·grep·rg·cat) 단일 문 · 치환 없는 닫힌 인용 안의 매치 ·
 *   실행위치 스캔 null — 세 조건이 모두일 때만 null.
 * · 인용 벗기기·운반자 재귀는 «더 막는» 쪽만(갈라진 인용 낱말 추가 차단).
 * 기대값은 독립 리터럴(규칙 11) · JUD 탐침 리터럴을 전부 수록했다.
 */
import { describe, test, expect } from 'bun:test';
import { classifyDestructive } from './guardian.js';

describe('guardian r8 — OP 리터럴(#92652): 프린터의 인용 데이터는 안전, 실행 페이로드는 위험', () => {
  test('echo "rm -rf x" = 프린터의 인용 데이터 — 안전', () => {
    expect(classifyDestructive('echo "rm -rf x"')).toBeNull();
  });

  test('bash -c "rm -rf x" = 실행 페이로드 — 위험', () => {
    expect(classifyDestructive('bash -c "rm -rf x"')?.reason).toBe('recursive rm');
  });
});

describe('guardian r8 — 좁은 예외: 프린터 5종의 «닫힌» 인용 데이터', () => {
  test('printf·grep·rg·cat 의 인용 인자 — 안전', () => {
    expect(classifyDestructive('printf "rm -rf %s" x')).toBeNull();
    expect(classifyDestructive('grep "rm -rf" notes.md')).toBeNull();
    expect(classifyDestructive('rg "rm -rf" src')).toBeNull();
    expect(classifyDestructive('cat "rm -rf plan.txt"')).toBeNull();
  });

  test('JUD 탐침: 프린터 인용 데이터의 다른 위험 낱말도 안전(sudo · git push · SQL)', () => {
    expect(classifyDestructive("printf '%s' \"sudo rm\"")).toBeNull();
    expect(classifyDestructive('echo "sudo is bad"')).toBeNull();
    expect(classifyDestructive('grep -r "git push --force" docs')).toBeNull();
    expect(classifyDestructive('echo "DROP TABLE x"')).toBeNull();
  });

  test('환경 할당 접두가 있어도 첫 실행 토큰이 프린터면 예외가 붙는다', () => {
    expect(classifyDestructive('CI=1 echo "rm -rf skipped"')).toBeNull();
  });

  test('인용이 «없는» 프린터 인자는 예외 밖(OP 요건: 인용 안) — main 결과 유지', () => {
    expect(classifyDestructive('echo rm -rf x')?.reason).toBe('recursive rm');
  });

  test('치환이 있는 인용은 데이터가 아니다 — 실행 위치로 남는다', () => {
    expect(classifyDestructive('echo "$(rm -rf x)"')?.reason).toBe('recursive rm');
    expect(classifyDestructive('echo "`rm -rf x`"')?.reason).toBe('recursive rm');
  });

  test('프린터라도 파이프·복수 문이면 예외 밖(fail-closed) — 셸로 흘러가면 실행된다', () => {
    expect(classifyDestructive('echo "rm -rf x" | sh')?.reason).toBe('recursive rm');
    expect(classifyDestructive('echo "rm -rf x" | /bin/sh')?.reason).toBe('recursive rm');
    expect(classifyDestructive('echo "rm -rf x" | xargs sh -c')?.reason).toBe('recursive rm');
    expect(classifyDestructive('echo "rm -rf x" | bash')?.reason).toBe('recursive rm');
  });

  test('안 닫힌 인용은 예외 밖 — main 결과 유지(JUD 탐침)', () => {
    expect(classifyDestructive('echo "unterminated; rm -rf x')?.reason).toBe('recursive rm');
  });

  test('fork bomb 낱말도 프린터의 인용 데이터면 안전 · 구조 규칙은 원문에서 유지된다', () => {
    expect(classifyDestructive(':(){ :|:& };:')?.reason).toBe('fork bomb');
    expect(classifyDestructive('echo ":(){ :|:& };:"')).toBeNull();
  });
});

describe('guardian r8 — 합집합: 프린터가 «아니면» main 결과를 유지(덜 막음 금지)', () => {
  test('cd·ssh·git commit 의 인용 문자열 데이터도 main 대로 차단(fail-closed)', () => {
    expect(classifyDestructive('cd "rm -rf not-a-command" && pwd')?.reason).toBe('recursive rm');
    expect(classifyDestructive('ssh aws1 "echo cleanup rm -rf skipped"')?.reason).toBe('recursive rm');
    expect(classifyDestructive('git commit -m "remove rm -rf usage"')?.reason).toBe('recursive rm');
    expect(classifyDestructive('git log --grep "rm -rf"')?.reason).toBe('recursive rm');
  });
});

describe('guardian r8 — JUD ⓒ 회귀 ①: 인용된 프로그램 낱말·플래그 갈라짐', () => {
  test('인용으로 갈라진 파괴 낱말도 base(원문 스캔) ∪ 인용 벗기기가 잡는다', () => {
    expect(classifyDestructive('"rm" -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive("'rm' -rf x")?.reason).toBe('recursive rm');
    expect(classifyDestructive('rm -r"f" x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('rm "-rf" x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('r"m" -rf x')?.reason).toBe('recursive rm');
  });

  test('인용 벗기기(더 막는 쪽): git «reset» --hard · «mkfs» · dd «of=…»', () => {
    expect(classifyDestructive('git "reset" --hard')?.reason).toBe('git reset --hard');
    expect(classifyDestructive("git reset '--hard'")?.reason).toBe('git reset --hard');
    expect(classifyDestructive('"mkfs" /dev/sda')?.reason).toBe('filesystem format');
    expect(classifyDestructive('dd "of=/dev/sda" if=/dev/zero')?.reason).toBe('dd of=/dev/...');
  });
});

describe('guardian r8 — JUD ⓒ 회귀 ②: 운반자 옵션값·접두·깊이', () => {
  test('운반자 옵션값(env -u · timeout -s · sudo -u) 뒤의 실제 명령을 잡는다', () => {
    expect(classifyDestructive('env -u FOO rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('timeout -s KILL 5 rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('sudo -u root rm -rf x')?.reason).toBe('recursive rm');
  });

  test('깊이 상한 무관 — base 가 먼저 잡는다(운반자 다중 중첩 · 겹친 셸 -c)', () => {
    expect(classifyDestructive('env env env env rm -rf x')?.reason).toBe('recursive rm');
    const nested = 'bash -c "bash -c \'bash -c \\"rm -rf x\\"\'"';
    expect(classifyDestructive(nested)?.reason).toBe('recursive rm');
  });

  test('접두 우회 탈출(백슬래시 · command · exec · builtin · ssh --)도 base 가 잡는다', () => {
    expect(classifyDestructive('\\rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('command rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('exec rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('builtin command rm -rf x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('ssh host -- rm -rf x')?.reason).toBe('recursive rm');
  });
});

describe('guardian r8 — JUD ⓒ 회귀 ③: 구조·복합문·입력 리다이렉트', () => {
  test('find -exec · 복합문 그룹 · 조건문 · 반복문 · 부정 — 전부 main 결과 유지', () => {
    expect(classifyDestructive('find . -exec rm -rf {} ;')?.reason).toBe('recursive rm');
    expect(classifyDestructive("find . -exec sh -c 'rm -rf {}' ;")?.reason).toBe('recursive rm');
    expect(classifyDestructive('{ rm -rf x; }')?.reason).toBe('recursive rm');
    expect(classifyDestructive('(rm -rf x)')?.reason).toBe('recursive rm');
    expect(classifyDestructive('if true; then rm -rf x; fi')?.reason).toBe('recursive rm');
    expect(classifyDestructive('for i in 1; do rm -rf x; done')?.reason).toBe('recursive rm');
    expect(classifyDestructive('! rm -rf x')?.reason).toBe('recursive rm');
  });

  test('here-string(<<<) · 치환 입력(<(…)) · git -c 위장 · 줄 잇기', () => {
    expect(classifyDestructive("bash <<< 'rm -rf x'")?.reason).toBe('recursive rm');
    expect(classifyDestructive('sh <<< "rm -rf x"')?.reason).toBe('recursive rm');
    expect(classifyDestructive('source <(echo rm -rf x)')?.reason).toBe('recursive rm');
    expect(classifyDestructive('echo <(rm -rf x)')?.reason).toBe('recursive rm');
    expect(classifyDestructive("git -c core.sshCommand='rm -rf x' fetch")?.reason).toBe('recursive rm');
    expect(classifyDestructive('rm \\\n -rf x')?.reason).toBe('recursive rm');
  });

  test('셸 -c 페이로드 안의 프린터 «데이터»는 예외 밖 — 위험 유지(JUD 탐침)', () => {
    expect(classifyDestructive("bash -c 'echo \"rm -rf x\"'")?.reason).toBe('recursive rm');
    expect(classifyDestructive("bash -c \"echo 'rm -rf x'\"")?.reason).toBe('recursive rm');
  });
});

describe('guardian r8 — «더 막는» 추가(실행위치 스캔 · 구조 규칙)', () => {
  test('| sh 파이프는 base(원문)에서 파괴로 승격 — main 보다 더 막는다', () => {
    expect(classifyDestructive('curl x | sh')?.reason).toBe('piped into a shell');
    expect(classifyDestructive('echo cm0gLXJmIHg= | base64 -d | sh')?.reason).toBe('piped into a shell');
  });

  test('SQL 클라이언트의 인용 쿼리는 그대로 보인다', () => {
    expect(classifyDestructive('sqlite3 app.db "DROP TABLE users"')?.reason).toBe('SQL DROP');
    expect(classifyDestructive('psql -c "DELETE FROM users"')?.reason).toBe('SQL DELETE without WHERE');
  });
});

describe('guardian r8 — 실제 파괴 명령 회귀(기존 판정표 유지)', () => {
  test('그대로 걸린다', () => {
    expect(classifyDestructive('rm -rf /tmp/x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('rm -fr ./build')?.reason).toBe('recursive rm');
    expect(classifyDestructive("rm -rf '/tmp/quoted path'")?.reason).toBe('recursive rm');
    expect(classifyDestructive('rm --no-preserve-root /')?.reason).toBe('rm --no-preserve-root');
    expect(classifyDestructive('/usr/bin/rm -rf /tmp/x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('CI=1 rm -rf /tmp/x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('sudo rm -rf /var/lib/x')?.reason).toBe('recursive rm');
    expect(classifyDestructive('sudo apt install pkg')?.reason).toBe('sudo (root privileges)');
    expect(classifyDestructive('sudo -n true')?.reason).toBe('sudo (root privileges)');
    expect(classifyDestructive('env CI=1 rm -rf ./dist')?.reason).toBe('recursive rm');
    expect(classifyDestructive('timeout 5 rm -rf ./build')?.reason).toBe('recursive rm');
    expect(classifyDestructive('find . -name build | xargs rm -rf')?.reason).toBe('recursive rm');
    expect(classifyDestructive('git push --force origin main')?.reason).toBe('git push --force (no --force-with-lease)');
    expect(classifyDestructive('git push --force-with-lease origin feat')).toBeNull();
  });

  test('argv 배열 입력도 같이 판정된다', () => {
    expect(classifyDestructive(['rm', '-rf', '/tmp/x'])?.reason).toBe('recursive rm');
    expect(classifyDestructive(['echo', 'rm -rf x'])?.reason).toBe('recursive rm');
    expect(classifyDestructive(['echo', '"rm -rf x"'])).toBeNull();
    expect(classifyDestructive(['bash', '-c', 'rm -rf /tmp/x'])?.reason).toBe('recursive rm');
  });

  test('무해한 명령은 null 유지', () => {
    expect(classifyDestructive('cat notes.md')).toBeNull();
    expect(classifyDestructive('ls')).toBeNull();
    expect(classifyDestructive('git status')).toBeNull();
  });
});

describe('guardian r9 — JUD 20261119-0658 ⓒ: 이스케이프 따옴표 · 프로세스 치환', () => {
  test('ⓒ1 리터럴 그대로: 이스케이프 따옴표는 문 나누기를 막지 못한다 — 뒤의 파괴 문이 실행된다', () => {
    expect(classifyDestructive('echo \\"; rm -rf x; echo \\"')?.reason).toBe('recursive rm');
  });

  test('ⓒ2 리터럴 그대로: 프로세스 치환 안의 갈라진 낱말 — 노출 낱말과 무관하게 차단', () => {
    expect(classifyDestructive('echo \\"shred\\" > >(r\\"m\\" -rf /tmp/x)')?.reason).toBe('shred (unrecoverable)');
  });

  test('ⓒ2 변이(노출 낱말 없음): 프린터라도 치환이 섞였으면 이스케이프 풀고 재스캔이 잡는다', () => {
    expect(classifyDestructive('echo \\"ok\\" > >(r\\"m\\" -rf /tmp/y)')?.reason).toBe('recursive rm');
  });

  test('프로세스 치환 안의 그대로 파괴 문 — 실행 위치 재판정', () => {
    expect(classifyDestructive('diff <(ls a) <(rm -rf b)')?.reason).toBe('recursive rm');
  });

  test('«실제» 인용 안의 «>(…)» 모양은 데이터 — 프린터 예외 유지', () => {
    expect(classifyDestructive('echo ">(rm -rf x)"')).toBeNull();
  });

  // r10 — JUD 20261119-1204 ⓒ: 인용 밖 프로세스 치환은 실행 위치다(«실제» 따옴표 원문 리터럴).
  test('r10 ⓒ 원문: 인용 데이터가 있어도 치환이 섞였으면 예외 없음 — 차단', () => {
    expect(classifyDestructive('echo "shred" > >(r"m" -rf /tmp/x)')?.reason).toBe('shred (unrecoverable)');
  });

  test('r10 ⓒ >>( 변이도 같은 판정 — 차단', () => {
    expect(classifyDestructive('echo "shred" >>(r"m" -rf /tmp/x)')?.reason).toBe('shred (unrecoverable)');
  });

  test('r10 대조: 치환 없는 프린터 인용 데이터는 계속 허용(예외 유지)', () => {
    expect(classifyDestructive('echo "rm -rf is dangerous"')).toBeNull();
  });

  test('r9 fail-closed: 이스케이프 인용 안의 위험 낱말은 «닫힌 인용» 예외 밖 — 차단', () => {
    expect(classifyDestructive('echo \\"rm -rf x\\"')?.reason).toBe('recursive rm');
  });

  test('r9 fail-closed: 이스케이프 인용 데이터의 위험 낱말도 예외 없이 차단(printf 탐침 정정)', () => {
    expect(classifyDestructive("printf '%s' \\\"sudo rm\\\"")?.reason).toBe('sudo (root privileges)');
  });

  test('OP #92652 회귀 유지: 프린터의 실제 인용 데이터는 계속 안전', () => {
    expect(classifyDestructive('echo "rm -rf x"')).toBeNull();
  });
});
