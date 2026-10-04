import { describe, expect, test } from 'bun:test';
import { parsePersonaYaml } from './loader.js';

describe('parsePersonaYaml seat', () => {
  const base = 'personaId: sage\ndisplayName: Sage\n';

  test('carries a declared seat and leaves existing personas without one unchanged', () => {
    const result = parsePersonaYaml(`${base}seat: MK\n`, 'sage.yaml');
    expect(result).toEqual({ ok: true, profile: { personaId: 'sage', displayName: 'Sage', seat: 'MK' } });
    if (result.ok) expect(Object.isFrozen(result.profile)).toBe(true);
    expect(parsePersonaYaml(base, 'sage.yaml')).toEqual({
      ok: true, profile: { personaId: 'sage', displayName: 'Sage' },
    });
  });

  test.each(['seat: ""\n', 'seat: "  "\n', 'seat:\n', 'seat: 123\n', 'seat: [MK]\n'])('rejects empty or non-string seat: %s', (declaration) => {
    expect(parsePersonaYaml(`${base}${declaration}`, 'sage.yaml')).toEqual({
      ok: false, error: { code: 'invalid-shape', path: 'sage.yaml', message: 'seat must be a non-empty string' },
    });
  });
});

describe('parsePersonaYaml todo', () => {
  const base = 'personaId: sage\ndisplayName: Sage\n';
  test('loads a per-persona todo filename and preserves older profiles without it', () => {
    expect(parsePersonaYaml(`${base}todo: sage.todo.jsonl\n`, 'sage.yaml')).toEqual({
      ok: true, profile: { personaId: 'sage', displayName: 'Sage', todo: 'sage.todo.jsonl' },
    });
    expect(parsePersonaYaml(base, 'sage.yaml')).toEqual({ ok: true, profile: { personaId: 'sage', displayName: 'Sage' } });
  });
  test.each(['todo: ../other.todo.jsonl\n', 'todo: []\n', 'todo:\n'])('rejects an invalid todo filename', (declaration) => {
    expect(parsePersonaYaml(`${base}${declaration}`, 'sage.yaml').ok).toBe(false);
  });
});

describe('parsePersonaYaml browserPort', () => {
  test('preserves a declared persona browserPort on the frozen profile', () => {
    const result = parsePersonaYaml(
      'personaId: remote\ndisplayName: Remote\nbrowserPort: 9333\n',
      'remote.yaml',
    );

    expect(result).toEqual({
      ok: true,
      profile: expect.objectContaining({
        personaId: 'remote',
        displayName: 'Remote',
        browserPort: 9333,
      }),
    });
    if (result.ok) expect(Object.isFrozen(result.profile)).toBe(true);
  });

  test('retains compatibility for personas without a browserPort', () => {
    const result = parsePersonaYaml('personaId: local\ndisplayName: Local\n', 'local.yaml');

    expect(result).toEqual({
      ok: true,
      profile: { personaId: 'local', displayName: 'Local' },
    });
  });

  test('rejects a non-port browserPort declaration', () => {
    const result = parsePersonaYaml(
      'personaId: invalid\ndisplayName: Invalid\nbrowserPort: 65536\n',
      'invalid.yaml',
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid-shape',
        path: 'invalid.yaml',
        message: 'browserPort must be an integer from 1 to 65535 if present',
      },
    });
  });
});

describe('parsePersonaYaml actionHosts (2026-08-28)', () => {
  // ⛔⛔ 📏 실물에서 난 것: 타입에만 필드를 더했더니 YAML 의 그 줄이 «영영» 안 읽혔고,
  //    경계를 선언했는데 조작이 «그대로 통과»했다(막힌 줄 알았다).
  const base = 'personaId: p\ndisplayName: P\n';

  test('선언한 호스트를 «실제로» 옮긴다', () => {
    const r = parsePersonaYaml(`${base}actionHosts:\n  - example.com\n  - .other.test\n`, 'p.yaml');
    expect(r.ok && r.profile.actionHosts).toEqual(['example.com', '.other.test']);
  });

  test('안 적으면 «없다» — 빈 배열로 지어내지 않는다', () => {
    const r = parsePersonaYaml(base, 'p.yaml');
    expect(r.ok && r.profile.actionHosts).toBeUndefined();
  });

  test('⛔ 선언했는데 «비었으면» 거부한다 — 아무것도 안 무는 경계를 만들지 않는다', () => {
    const r = parsePersonaYaml(`${base}actionHosts:\n  - "  "\n`, 'p.yaml');
    expect(r.ok).toBe(false);
  });

  test('⛔ 목록이 아니면 거부한다', () => {
    expect(parsePersonaYaml(`${base}actionHosts: example.com\n`, 'p.yaml').ok).toBe(false);
  });

  test('앞뒤 공백은 떼고 담는다', () => {
    const r = parsePersonaYaml(`${base}actionHosts:\n  - "  example.com  "\n`, 'p.yaml');
    expect(r.ok && r.profile.actionHosts).toEqual(['example.com']);
  });
});

describe('parsePersonaYaml residence · capabilities (RFC §25d·§25e · 2026-08-28)', () => {
  // ⛔ 이 축이 없으면 「맥이 죽으면 무엇이 남나」를 ***아무도 말할 수 없다***.
  //    그리고 바로 위 actionHosts 묶음이 못 박은 이유로 — 타입에만 더하면 그 줄은 영영 안 읽힌다.
  const base = 'personaId: p\ndisplayName: P\n';

  test('거처와 두 층을 «실제로» 옮긴다', () => {
    const r = parsePersonaYaml(
      `${base}residence: vm\ncapabilities:\n  core:\n    - omni-crawl\n  extended:\n    - google-workspace\n  evidence: declared\n`,
      'p.yaml');
    expect(r.ok && r.profile.residence).toBe('vm');
    expect(r.ok && r.profile.capabilities?.core).toEqual(['omni-crawl']);
    expect(r.ok && r.profile.capabilities?.extended).toEqual(['google-workspace']);
    expect(r.ok && r.profile.capabilities?.evidence).toBe('declared');
  });

  test('안 적으면 «없다» — 「local」이나 빈 목록으로 지어내지 않는다', () => {
    const r = parsePersonaYaml(base, 'p.yaml');
    expect(r.ok && r.profile.residence).toBeUndefined();
    expect(r.ok && r.profile.capabilities).toBeUndefined();
  });

  test('⛔ 모르는 거처를 거부한다', () => {
    expect(parsePersonaYaml(`${base}residence: cloud\n`, 'p.yaml').ok).toBe(false);
  });

  test('⛔ core 키를 «안 적었으면» 거부한다 — 선언했으면 「혼자 되는 것」을 말해야 한다', () => {
    expect(parsePersonaYaml(`${base}capabilities:\n  extended:\n    - x\n`, 'p.yaml').ok).toBe(false);
  });

  test('⛔ core 와 extended 가 «둘 다» 비면 거부한다 — 그것은 「안 적었다」다', () => {
    expect(parsePersonaYaml(`${base}capabilities:\n  core: []\n`, 'p.yaml').ok).toBe(false);
    expect(parsePersonaYaml(`${base}capabilities:\n  core:\n    - "  "\n  extended: []\n`, 'p.yaml').ok).toBe(false);
  });

  test('⭐ core: [] 는 «허용한다» — 실물에 그런 봇이 있다(assistant 는 VM 에 gws 가 없어 단독으로 아무것도 못 한다)', () => {
    // 🚨 첫 판은 이것을 거부했다. 그러면 그 봇은 ***영영 선언되지 못한다*** — 결손이 아니라 사실인데도.
    const r = parsePersonaYaml(
      `${base}residence: vm\ncapabilities:\n  core: []\n  extended:\n    - google-workspace\n`, 'p.yaml');
    expect(r.ok).toBe(true);
    expect(r.ok && r.profile.capabilities?.core).toEqual([]);
    expect(r.ok && r.profile.capabilities?.extended).toEqual(['google-workspace']);
  });

  test('⛔ 같은 능력이 «양쪽»에 있으면 이름을 대고 거부한다 — 답이 둘이 되면 안 된다', () => {
    const r = parsePersonaYaml(
      `${base}capabilities:\n  core:\n    - kr-flow\n    - omni-market\n  extended:\n    - omni-market\n`,
      'p.yaml');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain('omni-market');
  });

  test('⛔ 모르는 evidence 를 거부한다 — 「무엇으로 알았나」를 짐작으로 채우지 않는다', () => {
    expect(parsePersonaYaml(`${base}capabilities:\n  core:\n    - a\n  evidence: guessed\n`, 'p.yaml').ok).toBe(false);
  });

  test('evidence 를 안 적으면 «없다» — 「measured」로 승격되지 않는다', () => {
    const r = parsePersonaYaml(`${base}capabilities:\n  core:\n    - a\n`, 'p.yaml');
    expect(r.ok && r.profile.capabilities?.evidence).toBeUndefined();
  });
});

/** 🆕 ⛔ 「타입에 있다」와 「파서가 읽는다」는 «다른 값»이다 — 이 파일이 스스로 못 박은 규율(2026-08-29). */
describe('offsiteNavigation — 파서가 «읽나»', () => {
  const base = 'personaId: newsbot\ndisplayName: AI 뉴스\n';

  test('allowed 를 읽는다', () => {
    const r = parsePersonaYaml(`${base}offsiteNavigation: allowed\n`, 'p.yaml');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.offsiteNavigation).toBe('allowed');
  });

  test('blocked 를 읽는다', () => {
    const r = parsePersonaYaml(`${base}offsiteNavigation: blocked\n`, 'p.yaml');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.offsiteNavigation).toBe('blocked');
  });

  test('⛔ 모르는 값은 «조용히 넘기지 않고» 거부한다', () => {
    const r = parsePersonaYaml(`${base}offsiteNavigation: anywhere\n`, 'p.yaml');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('offsiteNavigation');
  });

  test('안 적으면 «없다» — 기본을 조용히 채우지 않는다', () => {
    const r = parsePersonaYaml(base, 'p.yaml');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.offsiteNavigation).toBeUndefined();
  });
});
