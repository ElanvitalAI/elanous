/** Pod Job 원천 단계 — default clone · 커밋 · PR · 호스트 번들.
 *  sha·PR·커밋은 형식 검사 전에 스크립트에 넣지 않는다(셸 주입 차단). */

import { execFileSync } from 'node:child_process';
import { siTaskPodStageShell } from './pod-lifecycle-stages.js';

export type PodSource =
  | { kind: 'default'; base?: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'pr'; number: number }
  | { kind: 'bundle'; bundlePath: string; sha256: string; sizeBytes: number; headCommit: string };

const SHA40 = /^[0-9a-f]{40}$/;

function assertSha(value: string, label: string): string {
  if (!SHA40.test(value)) throw new Error(`${label} must be 40 hex characters`);
  return value;
}

function assertPositiveInt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('pr number must be a positive integer');
  return value;
}

function assertSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('sha256 must be 64 hex characters');
  return value;
}

function assertSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('sizeBytes must be a non-negative integer');
  return value;
}

/** Check the requested branch on origin before creating a Pod Job, not in the launched job. */
function assertRemoteBase(repoUrl: string, base: string): void {
  if (base.startsWith('-') || base === 'HEAD') throw new Error(`invalid Pod base ref: ${base}`);
  try {
    execFileSync('git', ['check-ref-format', '--branch', base], { stdio: 'pipe' });
  } catch {
    throw new Error(`invalid Pod base ref: ${base}`);
  }
  try {
    const advertised = execFileSync('git', ['ls-remote', '--exit-code', '--heads', repoUrl, `refs/heads/${base}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const [sha, ref] = advertised.split('\t');
    if (!/^[0-9a-f]{40,64}$/.test(sha ?? '') || ref !== `refs/heads/${base}`) {
      throw new Error('origin did not advertise the requested branch');
    }
  } catch {
    throw new Error(`Pod base ref not found on origin: ${base}`);
  }
}

/** Job 스크립트의 원천 단계. 성공 갈래는 `ELANOUS_POD_SOURCE <kind> <HEAD>` 로 끝난다.
 *  `stageMarkers` — si-task Job 만: 호스트 미러 `clone --shared` 시도의 시작·성공을 `ELANOUS_POD_STAGE mirror start|end` 로 찍는다
 *  (건너뛰거나 실패하면 끝 표지가 없다 → 호스트가 missing 으로 읽는다). 기본은 꺼짐 — gate·pod-command Job 의 바이트는 그대로다. */
export function podSourceScript(source: PodSource, repoUrl: string, mirrorPath = '/host-mirror', options: { stageMarkers?: boolean; imageSourceDir?: string; imageCommitFile?: string; imageGitDir?: string } = {}): string {
  const mark = (edge: 'start' | 'end'): string[] => options.stageMarkers ? [siTaskPodStageShell('mirror', edge)] : [];
  const quotedUrl = `'${repoUrl.replace(/'/g, `'\\''`)}'`;
  const quotedMirror = `'${mirrorPath.replace(/'/g, `'\\''`)}'`;
  const quotedImageDir = `'${(options.imageSourceDir ?? '/opt/elanous-source').replace(/'/g, `'\\''`)}'`;
  const quotedCommitFile = `'${(options.imageCommitFile ?? '/opt/elanous-source-commit').replace(/'/g, `'\\''`)}'`;
  const quotedImageGitDir = `'${(options.imageGitDir ?? '/opt/elanous-pin.git').replace(/'/g, `'\\''`)}'`;
  const clone = `git clone -q --depth 50 ${quotedUrl} repo`;
  const start = [
    'if [ -e repo ]; then exit 5; fi',
    // POD-MIRROR-IO: the image's pinned tree is a shared read-only lower layer.
    // Git metadata is tiny and private to this Pod; alternates point first at
    // the image's shallow pin objects, then optionally at the host mirror.
    'source_via=',
    `if [ -f ${quotedCommitFile} ] && [ -d ${quotedImageDir} ] && [ -d ${quotedImageGitDir} ]; then`,
    // Older pinned images can contain macOS AppleDouble pack sidecars. Git may
    // interpret `._pack-*.idx` as an index and fail even when the real pack is valid.
    `  if [ -d ${quotedImageGitDir}/objects/pack ]; then find ${quotedImageGitDir}/objects/pack -maxdepth 1 -type f -name '._*' -delete || { printf 'ELANOUS_POD_SOURCE_IMAGE_FAIL appledouble-cleanup\n'; exit 5; }; fi`,
    `  image_commit=$(cat ${quotedCommitFile})`,
    `  if [[ "$image_commit" =~ ^[0-9a-f]{40}$ ]] && git -C ${quotedImageGitDir} cat-file -e "$image_commit^{commit}" 2>/dev/null && [ -f ${quotedImageGitDir}/shallow ] && grep -Fxq "$image_commit" ${quotedImageGitDir}/shallow; then`,
    `    ln -s ${quotedImageDir} repo || exit 5`,
    `    image_objects=$(git -C ${quotedImageGitDir} rev-parse --path-format=absolute --git-path objects)`,
    `    if git -C repo init -q -b main && mkdir -p repo/.git/objects/info && printf '%s\\n' "$image_objects" > repo/.git/objects/info/alternates; then`,
    `      if [ -d ${quotedMirror} ]; then mirror_objects=$(git -C ${quotedMirror} rev-parse --path-format=absolute --git-path objects 2>/dev/null || :); [ -z "$mirror_objects" ] || printf '%s\\n' "$mirror_objects" >> repo/.git/objects/info/alternates; fi`,
    `      if [ -f ${quotedImageGitDir}/shallow ]; then cp ${quotedImageGitDir}/shallow repo/.git/shallow || exit 5; fi`,
    `      if git -C repo update-ref refs/heads/main "$image_commit" && git -C repo read-tree "$image_commit" && git -C repo update-index --refresh && git -C repo diff-files --quiet && extra=$(git -C repo ls-files --others) && [ -z "$extra" ]; then`,
    `        git -C repo remote add origin ${quotedUrl} || exit 5`,
    '      source_via=image',
    '      printf \'ELANOUS_POD_SOURCE_IMAGE %s\\n\' "$image_commit"',
    '      else',
    '        printf \'ELANOUS_POD_SOURCE_IMAGE_SKIP source-tree-mismatch\\n\'',
    '        rm -- repo || exit 5',
    '      fi',
    '    else',
    '      printf \'ELANOUS_POD_SOURCE_IMAGE_FAIL bootstrap-failed\\n\'',
    '      exit 5',
    '    fi',
    '  else',
    '    printf \'ELANOUS_POD_SOURCE_IMAGE_SKIP pin-objects-mismatch\\n\'',
    '  fi',
    'fi',
    'if [ "$source_via" != image ]; then',
    // TA-POD-WARMBOOT-PARITY (10-16): the mirror fallback used to be silent — 157 HARD gate Pods all said
    // `VIA github` and nothing said why (the Job had no /host-mirror mount). Each failed step now names itself.
    'mirror_skip=',
    ...mark('start'),
    `if ! [ -d ${quotedMirror} ]; then mirror_skip=no-mount`,
    `elif ! git -C ${quotedMirror} rev-parse --verify HEAD >/dev/null 2>&1; then mirror_skip=rev-parse-failed`,
    `elif ! git clone -q --shared -- ${quotedMirror} repo || ! git -C repo rev-parse --verify HEAD >/dev/null 2>&1; then mirror_skip=clone-failed`,
    'fi',
    'if [ -z "$mirror_skip" ]; then',
    ...mark('end').map((line) => `  ${line}`),
    `  git -C repo remote set-url origin ${quotedUrl} || exit 5`,
    '  source_via=mirror',
    'else',
    "  printf 'ELANOUS_POD_SOURCE_MIRROR_SKIP %s\\n' \"$mirror_skip\"",
    '  if [ -e repo ]; then rm -r -- repo || exit 5; fi',
    `  ${clone} || exit 5`,
    '  source_via=github',
    'fi',
    'fi',
    "printf 'ELANOUS_POD_SOURCE_VIA %s\\n' \"$source_via\"",
    'cd repo || exit 5',
  ];
  if (source.kind === 'default') {
    if (source.base && source.base !== 'main') {
      assertRemoteBase(repoUrl, source.base);
      const base = source.base;
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const quotedTrackingRef = quote(`refs/remotes/origin/${base}`);
      return [
        ...start,
        `git fetch --depth 50 origin ${quote(`+refs/heads/${base}:refs/remotes/origin/${base}`)} || exit 5`,
        `git checkout -q -B ${quote(base)} ${quotedTrackingRef} || exit 5`,
        'head=$(git rev-parse HEAD)',
        "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
      ].join('\n');
    }
    return [
      ...start,
      'if [ "$source_via" != github ]; then',
      '  remote_info=$(git ls-remote --symref origin HEAD) || exit 5',
      `  remote_head=$(printf '%s\\n' "$remote_info" | awk '$2=="HEAD" && $1!="ref:" {print $1}')`,
      `  remote_branch=$(printf '%s\\n' "$remote_info" | awk '$1=="ref:" && $3=="HEAD" && $2 ~ /^refs\\/heads\\// {sub(/^refs\\/heads\\//, "", $2); print $2}')`,
      '  if ! [[ "$remote_head" =~ ^[0-9a-f]{40}$ ]]; then exit 5; fi',
      '  if [ "$remote_head" != "$(git rev-parse HEAD)" ]; then',
      `    if [ "$source_via" = image ] && git -C ${quotedMirror} cat-file -e "$remote_head^{commit}" 2>/dev/null; then`,
      '      git reset --hard "$remote_head" || exit 5',
      "      printf 'ELANOUS_POD_SOURCE_DELTA mirror\\n'",
      '    else',
      '      git fetch --depth 50 origin HEAD && git reset --hard FETCH_HEAD || exit 5',
      "      printf 'ELANOUS_POD_SOURCE_DELTA origin\\n'",
      '    fi',
      '  fi',
      'fi',
      'if [ "$source_via" = image ] && [ -n "$remote_branch" ] && git check-ref-format --branch "$remote_branch" >/dev/null 2>&1; then',
      '  if [ "$remote_branch" != main ]; then git branch -m "$remote_branch" || exit 5; fi',
      '  git update-ref "refs/remotes/origin/$remote_branch" "$(git rev-parse HEAD)" || exit 5',
      '  git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$remote_branch" || exit 5',
      '  git branch --set-upstream-to="origin/$remote_branch" "$remote_branch" >/dev/null || exit 5',
      'fi',
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
    ].join('\n');
  }
  if (source.kind === 'commit') {
    const sha = assertSha(source.sha, 'sha');
    return [
      ...start,
      `if ! git cat-file -e '${sha}^{commit}' 2>/dev/null; then git fetch --depth 1 origin ${sha} || exit 5; fi`,
      `git checkout --detach ${sha} || exit 5`,
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE commit %s\\n' \"$head\"",
    ].join('\n');
  }
  if (source.kind === 'pr') {
    const n = assertPositiveInt(source.number);
    return [
      ...start,
      `pr_sha=$(git ls-remote origin refs/pull/${n}/head | cut -f1) || exit 5`,
      'if ! [[ "$pr_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 5; fi',
      `if ! git cat-file -e "$pr_sha^{commit}" 2>/dev/null; then git fetch --depth 50 origin pull/${n}/head || exit 5; fi`,
      `git checkout -B pr-${n} "$pr_sha" || exit 5`,
      'head=$(git rev-parse HEAD)',
      "printf 'ELANOUS_POD_SOURCE pr %s\\n' \"$head\"",
    ].join('\n');
  }
  const sha256 = assertSha256(source.sha256);
  const sizeBytes = assertSize(source.sizeBytes);
  const headCommit = assertSha(source.headCommit, 'headCommit');
  return [
    'ready=0',
    'for i in $(seq 1 300); do',
    '  if [ -f /tmp/source.ready ]; then ready=1; break; fi',
    '  sleep 1',
    'done',
    'if [ "$ready" -ne 1 ]; then',
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH ready-timeout\\n'",
    '  exit 3',
    'fi',
    'size=$(wc -c < /tmp/source.bundle | tr -d " ")',
    `if [ "$size" != "${sizeBytes}" ]; then`,
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH size\\n'",
    '  exit 3',
    'fi',
    'got=$(sha256sum /tmp/source.bundle | awk \'{print $1}\')',
    `if [ "$got" != "${sha256}" ]; then`,
    "  printf 'ELANOUS_POD_SOURCE_MISMATCH sha256\\n'",
    '  exit 3',
    'fi',
    'if [ -e repo ]; then exit 5; fi',
    ...mark('start'),
    `if [ -d ${quotedMirror} ] && git -C ${quotedMirror} rev-parse --verify HEAD >/dev/null 2>&1 && git clone -q --shared -- ${quotedMirror} repo && git -C repo rev-parse --verify HEAD >/dev/null 2>&1; then`,
    ...mark('end').map((line) => `  ${line}`),
    `  git -C repo remote set-url origin ${quotedUrl} || exit 5`,
    '  if git -C repo bundle verify /tmp/source.bundle >/dev/null 2>&1; then',
    '    git -C repo fetch /tmp/source.bundle "refs/elanous/pod-source/*:refs/remotes/bundle/*" || exit 5',
    '  else',
    '    rm -r -- repo || exit 5',
    '    git clone /tmp/source.bundle repo || exit 5',
    '    git -C repo fetch /tmp/source.bundle "refs/elanous/pod-source/*:refs/remotes/bundle/*" || exit 5',
    '  fi',
    'else',
    '  if [ -e repo ]; then rm -r -- repo || exit 5; fi',
    '  git clone /tmp/source.bundle repo || exit 5',
    '  git -C repo fetch /tmp/source.bundle "refs/elanous/pod-source/*:refs/remotes/bundle/*" || exit 5',
    'fi',
    `git -C repo checkout --detach ${headCommit} || exit 5`,
    'head=$(git -C repo rev-parse HEAD) || exit 5',
    "printf 'ELANOUS_POD_SOURCE bundle %s\\n' \"$head\"",
    'cd repo || exit 5',
  ].join('\n');
}
