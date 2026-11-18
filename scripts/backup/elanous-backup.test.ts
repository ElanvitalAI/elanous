import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const backup = resolve(import.meta.dir, 'elanous-backup.sh');

async function runBackup(crontab: string, directories: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'elanous-backup-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await Promise.all(directories.map((directory) => mkdir(join(home, '.elanous', directory), { recursive: true })));
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'crontab'), crontab.startsWith('#!') ? crontab : `#!/bin/sh\nprintf '%s' '${crontab.replace(/'/g, "'\\\"'\\\"'")}'\n`);
  await writeFile(join(bin, 'gcloud'), '#!/bin/sh\necho "gcloud must not run" >&2\nexit 99\n');
  await chmod(join(bin, 'crontab'), 0o755);
  await chmod(join(bin, 'gcloud'), 0o755);

  try {
    const result = spawnSync('bash', [backup, '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        // Isolate source-tree discovery and ensure no production state is read or written.
        ELANOUS_STATE_DIR: join(root, 'state'),
      },
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('elanous-backup crontab snapshot', () => {
  test('plans a local mirrors snapshot by its backup name', async () => {
    const { status, output } = await runBackup('#!/bin/sh\nexit 0\n', ['mirrors']);

    expect(status).toBe(0);
    expect(output).toContain('elanous-mirrors');
  });

  test('captures a non-empty local crontab and reconciles planned with staged', async () => {
    const { status, output } = await runBackup('# morning automation\n20 4 * * * /opt/elanous/run\n');

    expect(status).toBe(0);
    expect(output).toContain('machine-crontab');
    expect(output).toContain('crontab -l (');
    // 🔑⛔ 가짜 HOME 에는 다른 담을 것이 «없다» ⇒ 이 회차의 계획은 ***오직 crontab «하나»***다.
    //    ⛔ 「계획 == 담김」만 보면 ***빈 것을 계획·스테이징하는 잘못된 구현도 통과한다***(자기 리뷰 must-fix).
    expect(output).toContain('📋 계획 1 · 담김 1 · 실패 0');
    expect(output).toContain('[dry-run] 올리지 않았다');
  });

  test('counts an unreadable crontab as failure rather than an empty machine', async () => {
    const { status, output } = await runBackup('#!/bin/sh\necho denied >&2\nexit 1\n');

    expect(status).not.toBe(0);
    expect(output).toContain('crontab -l 실패: denied');
    expect(output).toMatch(/📋 계획 \d+ · 담김 \d+ · 실패 [1-9]\d*/);
    expect(output).toContain('⛔ 구멍이 있다');
  });

  /**
   * 🩸⛔⭐⭐ **「크론이 «없다»」는 rc=1 로 온다 — 「실패」와 «같은 종료 코드»다** (2026-09-02 · 43차 자기 검토)
   *
   * 📏 실측(둘 다 rc=1):  macOS `crontab: no crontab for root` · VM(Linux) `no crontab for root`
   * ⛔ 이 갈림이 없으면 ***크론이 없는 기계에서 백업이 영영 「구멍이 있다」***로 끝난다 —
   *    결손이 «아닌» 사실을 결손 칸에 넣는 것이고, 이 파일 머리말이 금지하는 바로 그 꼴이다.
   * ⭐ 그리고 «짝»으로 문다 — 바로 위 시험이 「진짜 실패(denied)」는 여전히 FAILED 로 센다.
   */
  test('treats \u300cno crontab for\u300d (rc=1) as a fact, not a hole', async () => {
    const { status, output } = await runBackup('#!/bin/sh\necho "crontab: no crontab for tester" >&2\nexit 1\n');

    expect(status).toBe(0);
    expect(output).toContain('이 기계엔 크론이 없다 — 건너뛴다');
    expect(output).toContain('no crontab for tester');
    // 🔑 ⛔ 「실패 0」 ⊕ 「계획 0」이 «둘 다» 이 시험의 값이다 —
    //    사실을 결손으로 세도 죽고, «없는 것»을 계획에 넣어도 죽는다
    expect(output).toContain('📋 계획 0 · 담김 0 · 실패 0');
    expect(output).not.toContain('⛔ 구멍이 있다');
  });

  /**
   * 🔒⛔⭐⭐ **자격이 실린 crontab 은 «안 담긴다»** (2026-09-02 · 43차 자기 리뷰 must-fix ①)
   *
   * 🔑 이 걸음은 crontab 전문을 «원격»으로 보내는 ***새 데이터 흐름***이다. 올라가면 되돌릴 수 없다.
   * ⛔ 그래서 「경고만 하고 담기」도 「가리고 담기」도 아니고 ***「안 담고 이름을 대기」***다.
   * ⭐ ***짝으로 문다*** — 자격처럼 «보이지 않는» 경로 값(`API_KEY_FILE=/path/...`)은 «통과해야» 한다.
   *    그러지 않으면 이 관문이 정상 크론을 영영 막는다.
   */
  test('refuses to stage a crontab that carries a credential — and never prints the value', async () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const { status, output } = await runBackup(`20 4 * * * AWS_ACCESS_KEY_ID=${secret} /opt/elanous/run\n`);

    expect(status).not.toBe(0);
    expect(output).toContain('자격처럼 보이는 값이 있어 «안 담았다»');
    expect(output).toContain('⛔ 구멍이 있다');
    // 🔑⛔ ***값이 산출에 «없어야» 한다*** — 이유를 보여 주려다 비밀을 흘리는 문을 막는다
    expect(output).not.toContain(secret);
  });

  /**
   * 🩸⛔⭐⭐⭐ **GOODHART — 내 첫 경로 시험이 «우연히» 통과했다** (2026-09-02 · 43차 자기 리뷰 2차)
   *
   * 🚨 첫 판은 `~/.config/keys.json` 을 썼다. 그 값은 ***둘째 `/` 가 16자 전에 나와***
   *    거짓 양성을 «가렸다». ⇒ 정규식이 틀렸는데 시험이 초록이었다.
   * ✅ 그래서 ***가장 얇은 값***으로 문다 — `/` 하나 뒤에 16자가 «이어지는» 절대 경로.
   *    ⛔ 이것이 걸리면 이 관문은 ***정상 크론을 영영 막는다***.
   */
  /**
   * 🩸⛔⭐⭐ **소문자 자격도 자격이다** (2026-09-02 · 43차 자기 리뷰 3차 must-fix)
   * 🚨 셸 환경 변수는 소문자로도 쓴다. 대소문자를 구별하는 자는 ***자기가 무엇을 놓치는지 말하지 않는다***.
   */
  test('a lowercase credential name is caught too — and never printed', async () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    const { status, output } = await runBackup(`20 4 * * * aws_secret_access_key=${secret} /opt/elanous/run\n`);

    expect(status).not.toBe(0);
    expect(output).toContain('자격처럼 보이는 값이 있어 «안 담았다»');
    expect(output).not.toContain(secret);
  });

  test('an absolute path with a long first segment is NOT a credential (⛔ 첫 판이 여기서 «가려졌다»)', async () => {
    const { status, output } = await runBackup('20 4 * * * API_KEY_FILE=/abcdefghijklmnop /opt/elanous/run\n');

    expect(status).toBe(0);
    expect(output).not.toContain('자격처럼 보이는 값');
    expect(output).toContain('📋 계획 1 · 담김 1 · 실패 0');
  });

  test('a ~ / $ shaped value is NOT a credential either', async () => {
    const { status, output } = await runBackup('20 4 * * * SECRET_FILE=~/.config/elanous/abcdefghijklmnop TOKEN_REF=$ELANOUS_TOKEN_ABCDEFGH /opt/elanous/run\n');

    expect(status).toBe(0);
    expect(output).not.toContain('자격처럼 보이는 값');
    expect(output).toContain('📋 계획 1 · 담김 1 · 실패 0');
  });

  /**
   * 🩸⛔⭐⭐ **거짓 «음성»의 짝** — 진짜 AWS 비밀은 `/`·`+` 를 담는다.
   * 첫 판은 값 문자에서 `/` 를 빼는 방식이라 ***이것을 놓치고 GCS 로 올렸을*** 것이다.
   */
  test('a credential whose value contains / and + is caught — and never printed', async () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    const { status, output } = await runBackup(`20 4 * * * AWS_SECRET_ACCESS_KEY=${secret} /opt/elanous/run\n`);

    expect(status).not.toBe(0);
    expect(output).toContain('자격처럼 보이는 값이 있어 «안 담았다»');
    expect(output).not.toContain(secret);
  });

  test('skips a zero-byte crontab without recording failure or a plan', async () => {
    const { status, output } = await runBackup('#!/bin/sh\nexit 0\n');

    expect(status).toBe(0);
    expect(output).toContain('machine-crontab');
    expect(output).toContain('이 기계엔 크론이 없다 — 건너뛴다');
    // ⛔ 「계획 == 담김」이 아니라 ***「계획이 0」***을 단언한다 — 빈 것을 계획에 넣으면 여기서 죽는다
    expect(output).toContain('📋 계획 0 · 담김 0 · 실패 0');
    expect(output).toContain('[dry-run] 올리지 않았다');
  });
});

/**
 * 🔐 자격 묶음 — tar | age → secrets.tar.age 하나만 올린다 (2026-09-26 · 대표 «자격까지 담아라»)
 *
 * ⛔ 실물을 돌린다: 격리 HOME 에 가짜 자격 ⊕ 시험용 age 열쇠를 두고, gcloud·aws·crontab 을 PATH 앞 스텁으로 막는다.
 *    업로드는 스텁이 «로컬 폴더로 복사»만 한다 — 네트워크·운영 버킷·심박은 닿지 않는다.
 */
const restore = resolve(import.meta.dir, 'elanous-restore.sh');
// ⛔ 스크립트와 «같은» 곳을 본다 — PATH 도 본다(리뷰 must-fix: PATH 에만 있으면 시험이 조용히 건너뛰어졌다).
const AGE = ['/opt/homebrew/bin/age', '/usr/local/bin/age', (spawnSync('sh', ['-c', 'command -v age'], { encoding: 'utf8' }).stdout ?? '').trim()]
  .find((p) => p && spawnSync('test', ['-x', p]).status === 0);
const MARK = 'CANARY-SECRET-7f3a9c';

async function secretsFixture(opts: { recipient: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'elanous-secrets-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const up = join(root, 'uploaded');
  await mkdir(join(home, '.elanous'), { recursive: true });
  await mkdir(join(home, '.grok'), { recursive: true });
  await mkdir(join(home, '.elanous', 'checkpoints'), { recursive: true });
  await writeFile(join(home, '.elanous', 'checkpoints', 'c.json'), '{}');
  await mkdir(bin, { recursive: true });
  await mkdir(up, { recursive: true });
  await writeFile(join(home, '.elanous', 'auth.json'), `{"providers":{"x":{"tokens":{"accessToken":"${MARK}"}}}}`);
  await writeFile(join(home, '.grok', 'auth.json'), `grok-${MARK}`);
  const keyFile = join(root, 'test-identity.txt');
  if (AGE) {
    const kg = spawnSync(AGE.replace(/age$/, 'age-keygen'), ['-o', keyFile], { encoding: 'utf8' });
    const pub = (kg.stderr ?? '').match(/age1[0-9a-z]+/)?.[0] ?? '';
    if (opts.recipient) {
      await mkdir(join(home, '.elanous', 'backup-key'), { recursive: true });
      await writeFile(join(home, '.elanous', 'backup-key', 'recipient.txt'), `${pub}\n`);
    }
  }
  await writeFile(join(bin, 'crontab'), '#!/bin/sh\nexit 0\n');
  // gcloud: cp 는 이름만 적고, ls 는 적힌 이름 수만큼 줄을 낸다(원격 개수 대조가 맞게).
  await writeFile(join(bin, 'gcloud'), `#!/bin/bash
if [ "$1 $2" = "storage cp" ]; then shift 3; n=$#; i=0; for a in "$@"; do i=$((i+1)); [ $i -lt $n ] && basename "$a" >> "${up}/gcs.txt"; done; exit 0; fi
if [ "$1 $2" = "storage ls" ]; then while read -r f; do echo "10 2026-01-01T00:00:00Z gs://x/$f"; done < "${up}/gcs.txt"; exit 0; fi
exit 0
`);
  // aws: s3 cp <로컬> <s3url> 은 로컬 폴더로 복사 ⊕ 호출 기록, s3 ls 는 복사본 크기를 낸다.
  await writeFile(join(bin, 'aws'), `#!/bin/bash
echo "$*" >> "${up}/aws.log"
if [ "$1 $2" = "s3 cp" ]; then cp "$3" "${up}/$(basename "$4")"; exit 0; fi
if [ "$1 $2" = "s3 ls" ]; then f="${up}/$(basename "$3")"; [ -f "$f" ] && echo "2026-01-01 00:00:00 $(wc -c < "$f" | tr -d ' ') $(basename "$3")"; exit 0; fi
exit 0
`);
  for (const f of ['crontab', 'gcloud', 'aws']) await chmod(join(bin, f), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ELANOUS_STATE_DIR: join(root, 'state'),
    ELANOUS_BACKUP_NO_HEARTBEAT: '1',
    ELANOUS_KEY_CACHE_DIR: join(home, '.cache'),
  };
  return { root, home, up, keyFile, env };
}

describe('elanous-backup secrets bundle', () => {
  test.skipIf(!AGE)('uploads exactly one secrets.tar.age that decrypts to the original credentials', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      const r = spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(out).toContain('🔐 자격 묶음 업로드 ✅');
      expect(r.status).toBe(0);
      const log = await Bun.file(join(fx.up, 'aws.log')).text();
      const uploads = log.split('\n').filter((l) => l.startsWith('s3 cp'));
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatch(/ s3:\/\/\S+\/secrets\.tar\.age(\s|$)/);
      const listed = spawnSync('bash', ['-c', `"${AGE}" -d -i "${fx.keyFile}" "${fx.up}/secrets.tar.age" | tar -xOf - .elanous/auth.json`], { encoding: 'utf8' });
      expect(listed.stdout).toContain(MARK);
      // ③ 출력 어디에도 자격 «내용»이 없다
      expect(out).not.toContain(MARK);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test('fails the secrets step by name and never uploads when the recipient key is missing', async () => {
    const fx = await secretsFixture({ recipient: false });
    try {
      const r = spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).not.toBe(0);
      // ⛔ 받는 사유를 «하나»로 좁힌다 — 둘 다 받으면 열쇠 누락 경로를 안 타도 통과한다(리뷰 must-fix · GOODHART).
      expect(out).toContain(AGE ? '🔐 자격 묶음 ⛔ 실패 — 공개 열쇠 파일이 없다' : '🔐 자격 묶음 ⛔ 실패 — age 를 못 찾았다');
      const log = (await Bun.file(join(fx.up, 'aws.log')).exists()) ? await Bun.file(join(fx.up, 'aws.log')).text() : '';
      expect(log.split('\n').filter((l) => l.startsWith('s3 cp'))).toHaveLength(0);
      // 데이터 백업은 계속 돌았다(GCS 스텁이 업로드를 받았다)
      expect(await Bun.file(join(fx.up, 'gcs.txt')).exists()).toBe(true);
      expect(out).not.toContain(MARK);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!AGE)('elanous-restore --to reproduces the credential bytes without printing them', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      const b = spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env });
      expect(b.status).toBe(0);
      const dest = join(fx.root, 'restored');
      const r = spawnSync('bash', [restore, '--from', join(fx.up, 'secrets.tar.age'), '--to', dest], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...fx.env, ELANOUS_BACKUP_IDENTITY_PLAIN: fx.keyFile },
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).toBe(0);
      expect(out).toContain('.elanous/auth.json');
      expect(out).not.toContain(MARK);
      const original = await Bun.file(join(fx.home, '.elanous', 'auth.json')).arrayBuffer();
      const restored = await Bun.file(join(dest, '.elanous', 'auth.json')).arrayBuffer();
      expect(Buffer.from(restored).equals(Buffer.from(original))).toBe(true);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!AGE)('elanous-restore refuses --to $HOME and never overwrites home credentials', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      expect(spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env }).status).toBe(0);
      const before = await Bun.file(join(fx.home, '.elanous', 'auth.json')).text();
      await writeFile(join(fx.home, '.elanous', 'auth.json'), 'CHANGED-AFTER-BACKUP');
      const r = spawnSync('bash', [restore, '--from', join(fx.up, 'secrets.tar.age'), '--to', fx.home], {
        encoding: 'utf8', timeout: 60_000, env: { ...fx.env, ELANOUS_BACKUP_IDENTITY_PLAIN: fx.keyFile },
      });
      expect(r.status).toBe(2);
      expect(`${r.stdout}${r.stderr}`).toContain('--to 가 홈이거나 홈을 품는다');
      expect(await Bun.file(join(fx.home, '.elanous', 'auth.json')).text()).toBe('CHANGED-AFTER-BACKUP');
      expect(before).toContain(MARK);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!AGE)('elanous-restore --in-place keeps a pre-restore copy before overwriting', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      expect(spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env }).status).toBe(0);
      await writeFile(join(fx.home, '.elanous', 'auth.json'), 'CHANGED-AFTER-BACKUP');
      const r = spawnSync('bash', [restore, '--from', join(fx.up, 'secrets.tar.age'), '--in-place'], {
        encoding: 'utf8', timeout: 60_000, env: { ...fx.env, ELANOUS_BACKUP_IDENTITY_PLAIN: fx.keyFile },
      });
      expect(r.status).toBe(0);
      expect(await Bun.file(join(fx.home, '.elanous', 'auth.json')).text()).toContain(MARK);
      const kept = spawnSync('bash', ['-c', `cat "${join(fx.home, '.elanous')}"/auth.json.pre-restore-*`], { encoding: 'utf8' });
      expect(kept.stdout).toBe('CHANGED-AFTER-BACKUP');
      expect(`${r.stdout}${r.stderr}`).not.toContain(MARK);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test('fails by name when API key cache lives outside HOME instead of silently dropping it', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      const outside = join(fx.root, 'outside-cache');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'openai_api_key'), `k-${MARK}`);
      const r = spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: { ...fx.env, ELANOUS_KEY_CACHE_DIR: outside } });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      expect(r.status).not.toBe(0);
      expect(out).toContain('홈 밖');
      expect(out).not.toContain(MARK);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test.skipIf(!AGE)('elanous-restore --in-place refuses to write through a symlink target', async () => {
    const fx = await secretsFixture({ recipient: true });
    try {
      expect(spawnSync('bash', [backup, '--source', 'manual'], { encoding: 'utf8', timeout: 60_000, env: fx.env }).status).toBe(0);
      const victim = join(fx.root, 'victim.txt');
      await writeFile(victim, 'VICTIM');
      await rm(join(fx.home, '.grok', 'auth.json'));
      spawnSync('ln', ['-s', victim, join(fx.home, '.grok', 'auth.json')]);
      const r = spawnSync('bash', [restore, '--from', join(fx.up, 'secrets.tar.age'), '--in-place'], {
        encoding: 'utf8', timeout: 60_000, env: { ...fx.env, ELANOUS_BACKUP_IDENTITY_PLAIN: fx.keyFile },
      });
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toContain('심볼릭 링크라 건너뛴다');
      expect(await Bun.file(victim).text()).toBe('VICTIM');
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  test('reports «no credentials» as skipped, not failed, on a machine without any', async () => {
    const { status, output } = await runBackup('#!/bin/sh\nexit 0\n');
    expect(status).toBe(0);
    expect(output).toContain('🔐 자격 묶음 — 담을 자격이 없어 건너뛰었다');
  });
});

/** 🔒 BACKUP-DATA-ONLY (0.3.28 · RES79564/OP79578): host moves that may not copy credentials. */
async function runWithCredentials(args: string[], crontab = '#!/bin/sh\nexit 0\n') {
  const root = await mkdtemp(join(tmpdir(), 'elanous-backup-data-only-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(join(home, '.elanous', 'mirrors'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.aws'), { recursive: true });
  await mkdir(join(home, '.elanous', 'backup-key'), { recursive: true });
  // Synthetic sentinels only — never real credentials.
  await writeFile(join(home, '.elanous', 'auth.json'), '{"sentinel":"elanous-auth"}');
  await writeFile(join(home, '.codex', 'auth.json'), '{"sentinel":"codex-auth"}');
  await writeFile(join(home, '.aws', 'credentials'), '[sentinel]\n');
  await writeFile(join(home, '.elanous', 'backup-key', 'recipient.txt'), 'age1fixturerecipient\n');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'crontab'), crontab);
  await writeFile(join(bin, 'gcloud'), '#!/bin/sh\necho "gcloud must not run" >&2\nexit 99\n');
  for (const name of ['crontab', 'gcloud']) await chmod(join(bin, name), 0o755);
  try {
    const result = spawnSync('bash', [backup, ...args], {
      encoding: 'utf8',
      // 출처: R-TST17 — same child ceiling as runBackup above; a timeout is «unmeasured», never a pass.
      timeout: 30_000,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, ELANOUS_STATE_DIR: join(root, 'state') },
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('elanous-backup --data-only', () => {
  test('lists exclusions first, never discovers or encrypts credentials, and reports them omitted (not success)', async () => {
    const { status, output } = await runWithCredentials(['--data-only', '--dry-run']);
    expect(status).toBe(0);
    expect(output).toContain('데이터만(--data-only)');
    expect(output.split('═══ 담을 것을')[0]).toContain('데이터만(--data-only)');
    expect(output).toContain('elanous-mirrors');
    expect(output).not.toContain('secret:');
    expect(output).not.toContain('sentinel');
    expect(output).toContain('🔐 자격 묶음 — 🔒 제외(omitted)');
    expect(output).not.toContain('자격 묶음 ✅');
    expect(output).not.toContain('═══ 🔐 자격 묶음 (암호화');
  });

  test('a credential-bearing crontab is still a hole and its raw text goes nowhere', async () => {
    const secret = 'AKIA' + 'QRSTUVWXYZABCDEF';
    const { status, output } = await runWithCredentials(
      ['--data-only', '--dry-run'],
      `#!/bin/sh\nprintf '20 4 * * * AWS_ACCESS_KEY_ID=${secret} /opt/run\\n'\n`,
    );
    expect(status).not.toBe(0);
    expect(output).toContain('자격처럼 보이는 값이 있어 «안 담았다»');
    expect(output).toContain('⛔ 구멍이 있다');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('secret:machine-crontab.raw');
    expect(output).not.toContain('═══ 🔐 자격 묶음 (암호화');
  });

  test('an unknown flag stops before staging anything instead of silently running a full backup', async () => {
    const { status, output } = await runWithCredentials(['--skip-credentials', '--dry-run']);
    expect(status).toBe(2);
    expect(output).toContain('모르는 인자: --skip-credentials');
    expect(output).not.toContain('═══ 담을 것을');
  });

  test('a flag in the value slot of --bucket/--source is refused in both orders, never swallowing --data-only', async () => {
    for (const args of [
      ['--bucket', '--data-only', '--dry-run'],
      ['--data-only', '--bucket', '--dry-run'],
      ['--source', '--data-only', '--dry-run'],
      ['--dry-run', '--data-only', '--source'],
    ]) {
      const { status, output } = await runWithCredentials(args);
      // Orders where the flag is consumed as a value must stop (rc=2); a trailing option without a value
      // must never reach the credential bundle either.
      if (args.join(' ').match(/--(bucket|source) --data-only/)) {
        expect(status).toBe(2);
        expect(output).toContain('값 자리에 플래그 모양');
      }
      expect(output).not.toContain('secret:.elanous/auth.json');
      expect(output).not.toContain('═══ 🔐 자격 묶음 (암호화');
    }
  });

  test('a trailing --bucket or --source with no value stops before staging anything', async () => {
    for (const args of [['--data-only', '--dry-run', '--bucket'], ['--dry-run', '--data-only', '--source']]) {
      const { status, output } = await runWithCredentials(args);
      expect(status).toBe(2);
      expect(output).toContain(`${args.at(-1)} 뒤에 값이 없다`);
      expect(output).not.toContain('═══ 담을 것을');
      expect(output).not.toContain('═══ 🔐 자격 묶음 (암호화');
    }
  });

  test('without --data-only the full encrypted-credential path is unchanged', async () => {
    const { output } = await runWithCredentials(['--dry-run']);
    expect(output).toContain('secret:.elanous/auth.json');
    expect(output).toContain('secret:.codex/auth.json');
    expect(output).not.toContain('sentinel');
    expect(output).toContain('═══ 🔐 자격 묶음 (암호화');
  });
});
