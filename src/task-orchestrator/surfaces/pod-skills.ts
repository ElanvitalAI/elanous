/**
 * ☸️ Pod 필수 스킬 세트 — 이미지에 «스킬 코드»를, 런마다 Secret 으로 «스킬 키(.env)»를 (대표 2026-09-25).
 *
 * 목록 = `ELANOUS_POD_SKILLS`(쉼표) 또는 설정 디렉토리의 `pod-skills.txt`(한 줄에 하나 · `#` 주석).
 *   ⛔ 코드에 스킬 이름을 박지 않는다 — 누구의 개인 스킬인지는 «설정»이다(공개 준비 원칙).
 * 원본 = 이 기계의 `~/.claude/skills/<이름>` (LOCAL_SKILLS_DIR).
 *
 * ⛔⭐ 비밀은 이미지에 «절대» 안 들어간다:
 *   이미지로 가는 복사(stage)는 `.env*` · 키·인증서 · `auth*.json` · `node_modules` · 캐시를 뺀다.
 *   키는 `readSkillEnvFiles` 로 읽어 «그 런의 Secret» 에만 싣는다(`--pod-skill-env` 명시 opt-in · 유료 크레딧을 쓰므로).
 *   Pod 안에서는 각 스킬 폴더의 `.env` 로 0600 복사되고, 런이 끝나면 Secret 이 지워진다.
 *
 * CLI(build.sh 가 부른다):  bun src/task-orchestrator/surfaces/pod-skills.ts stage <dir>
 *   → 목록의 스킬을 <dir>/<이름> 으로 복사하고 `digest=<hex> skills=<a,b>` 한 줄을 낸다.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { LOCAL_SKILLS_DIR } from '../../config.js';
import { getElanousConfigDir } from '../../elanous-config-dir.js';
import { prodInstanceRoot } from '../../instance/resolve.js';

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 이미지로 가면 안 되는 것 — 비밀 ⊕ 재생성물 ⊕ «개인 데이터·상태». 이름(경로 조각) 기준.
 *  🔐 2026-09-27(🅞 짚음): 스킬 폴더의 `data/`(yt-vault 413MB · 구독·흡수 이력 DB) · `.elanous/`(스킬이 쓴 관측·상태) · DB 파일이
 *  이미지(→ node-b 레지스트리)에 구워질 뻔했다 — 코드만 이미지로, 데이터는 런이 산출 폴더로 받는다. */
const EXCLUDED_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|auth[^/]*\.json|credentials[^/]*\.json|token[^/]*\.json|node_modules|\.venv|venv|__pycache__|\.cache|\.git|\.DS_Store|.*\.log|data|\.elanous|\.monad|.*\.(db|sqlite|sqlite3|db-wal|db-shm|sqlite-wal|sqlite-shm))$/iu;

export function podSkillsListPath(configDir: string = getElanousConfigDir()): string {
  const here = join(configDir, 'pod-skills.txt');
  if (configDir !== getElanousConfigDir() || existsSync(here)) return here;
  // 스킬 목록은 «이 기계 사용자»의 설정이다(스킬도 ~/.claude/skills 에 있다) — 워크트리의 시험 우주에서 빌드해도
  //   운영 목록을 읽는다(2026-09-26 실측: 워크트리 빌드가 목록을 못 찾아 스킬 0개로 이미지를 구웠다).
  const prod = join(prodInstanceRoot(), 'pod-skills.txt');
  return existsSync(prod) ? prod : here;
}

/** 목록 해석: `ELANOUS_POD_SKILLS` → 설정 파일 → 빈 목록. 이름 규칙 밖은 버리지 않고 오류로 낸다. */
export function resolvePodSkills(env: NodeJS.ProcessEnv = process.env, listPath: string = podSkillsListPath()): { skills: string[]; source: 'env' | 'file' | 'none'; invalid: string[] } {
  const raw = env.ELANOUS_POD_SKILLS?.trim()
    ? { text: env.ELANOUS_POD_SKILLS.replace(/,/gu, '\n'), source: 'env' as const }
    : existsSync(listPath) ? { text: readFileSync(listPath, 'utf8'), source: 'file' as const } : null;
  if (!raw) return { skills: [], source: 'none', invalid: [] };
  const names = raw.text.split('\n').map((l) => l.replace(/#.*$/u, '').trim()).filter(Boolean);
  const invalid = names.filter((n) => !SKILL_NAME.test(n));
  return { skills: [...new Set(names.filter((n) => SKILL_NAME.test(n)))], source: raw.source, invalid };
}

/** 한 스킬 폴더에서 이미지로 갈 파일들(상대 경로 · 정렬). 심볼릭 링크는 따라가지 않고 뺀다. */
export function podSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (EXCLUDED_NAME.test(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** 세트 전체의 내용 해시 — 이미지 라벨 `elanous.pod-skills` 와 대조한다(스킬이 바뀌면 이미지가 «낡음»). */
export function podSkillsDigest(skills: readonly string[], root: string = LOCAL_SKILLS_DIR): { digest: string; missing: string[] } {
  const h = createHash('sha256');
  const missing: string[] = [];
  for (const s of [...skills].sort()) {
    const dir = join(root, s);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) { missing.push(s); continue; }
    h.update(`skill\0${s}\0`);
    for (const f of podSkillFiles(dir)) { h.update(`${f}\0`); h.update(readFileSync(join(dir, f))); h.update('\0'); }
  }
  return { digest: skills.length === 0 ? 'none' : h.digest('hex').slice(0, 16), missing };
}

/** 이미지 빌드 문맥으로 복사한다(비밀·재생성물 제외). */
export function stagePodSkills(skills: readonly string[], dest: string, root: string = LOCAL_SKILLS_DIR, home: string = homedir()): { digest: string; staged: string[]; missing: string[] } {
  mkdirSync(dest, { recursive: true });
  const staged: string[] = [];
  for (const s of skills) {
    const dir = join(root, s);
    if (!existsSync(dir)) continue;
    for (const f of podSkillFiles(dir)) {
      mkdirSync(join(dest, s, f, '..'), { recursive: true });
      copyFileSync(join(dir, f), join(dest, s, f));
      if (/\.(md|txt|sh|json|ya?ml|toml)$/iu.test(f) && home) {
        // 스킬 문서가 «이 기계의 홈»을 절대 경로로 박은 곳(예: `cd /Users/<나>/.claude/skills/…`)을 `~` 로 — Pod 의 홈은 다르다.
        const text = readFileSync(join(dest, s, f), 'utf8');
        if (text.includes(`${home}/`)) writeFileSync(join(dest, s, f), text.split(`${home}/`).join('~/'));
      }
    }
    staged.push(s);
  }
  const { digest, missing } = podSkillsDigest(skills, root);
  return { digest, staged, missing };
}

/** 런의 Secret 에 실을 스킬 키 파일 — `{ <스킬>: <.env 내용> }`. `.env` 가 없는 스킬은 뺀다.
 *  ⛔ 값을 로그·출력에 내지 않는다 — 호출자는 «이름»만 관측한다. */
export function readSkillEnvFiles(skills: readonly string[], root: string = LOCAL_SKILLS_DIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of skills) {
    const p = join(root, s, '.env');
    if (existsSync(p) && statSync(p).isFile()) out[s] = readFileSync(p, 'utf8');
  }
  return out;
}

if (import.meta.main) {
  const [cmd, dest] = process.argv.slice(2);
  if (cmd !== 'stage' || !dest) { console.error('usage: pod-skills.ts stage <dir>'); process.exit(2); }
  const list = resolvePodSkills();
  if (list.invalid.length) { console.error(`⛔ pod 스킬 이름 규칙 밖: ${list.invalid.join(', ')}`); process.exit(2); }
  const r = stagePodSkills(list.skills, dest);
  if (r.missing.length) console.error(`⚠️ pod 스킬 원본 없음(뺐다): ${r.missing.join(', ')}`);
  console.log(`digest=${r.digest} skills=${r.staged.join(',') || '-'} source=${list.source}`);
}
