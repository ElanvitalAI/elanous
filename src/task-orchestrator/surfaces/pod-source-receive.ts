/** Pod Job 원천 단계 — default clone · 커밋 · PR · 호스트 번들.
 *  sha·PR·커밋은 형식 검사 전에 스크립트에 넣지 않는다(셸 주입 차단). */

import { execFileSync } from 'node:child_process';
import { siTaskPodStageShell } from './pod-lifecycle-stages.js';
import { decidePodReuseCleanup } from './pod-reuse-cleanup.js';

export type PodSource =
  | { kind: 'default'; base?: string; baseSha?: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'pr'; number: number }
  | { kind: 'bundle'; bundlePath: string; sha256: string; sizeBytes: number; headCommit: string }
  /** POD-REUSE-MIN-SYNC — 웜 Pod 재사용: 이미 있는 체크아웃을 지우지 않고 «이전 head → 새 base» 차이만 맞춘다.
   *  base 는 호스트 미러 또는 부모가 넘긴 git bundle 에서만 받는다(GitHub 원격 호출 0 — PR push 1회는 이 단계 밖).
   *  `lockHash` — 새 base 가 요구하는 bun.lock 해시. 실제 상주 설치 해시는
   *  node_modules/.elanous-installed-lock-hash 에 따로 기록해 비교한다. */
  | { kind: 'min-sync'; baseSha: string; previousHead: string; bundle?: { bundlePath: string; sha256: string; sizeBytes: number }; lockHash?: string };

const SHA40 = /^[0-9a-f]{40}$/;

/** Fail-closed typed error — resolved SHA 형식이 틀리면 스크립트 생성 이전에 거부한다. */
export class PodSourceShaFormatError extends Error {
  constructor(public readonly label: string, public readonly value: string) {
    super(`${label} must be 40 hex characters`);
    this.name = 'PodSourceShaFormatError';
  }
}

function assertSha(value: string, label: string): string {
  if (!SHA40.test(value)) throw new PodSourceShaFormatError(label, value);
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
export function podSourceScript(source: PodSource, repoUrl: string, mirrorPath = '/host-mirror', options: { stageMarkers?: boolean; imageSourceDir?: string; imageCommitFile?: string; imageGitDir?: string; /** min-sync 만: 스크립트가 다루는 체크아웃 경로(기본 `repo` — Job 스크립트 관례). 상주 런타임은 절대 경로를 준다. */ checkoutDir?: string } = {}): string {
  // 검증 우선 — 부모 resolver 가 준 baseSha 는 셸 스크립트 문자열에 삽입되기 전에 형식 검사를 통과해야 한다.
  const sourceBaseSha = source.kind === 'default' ? source.baseSha : undefined;
  const baseSha = sourceBaseSha ? assertSha(sourceBaseSha, 'base sha') : undefined;
  const mark = (edge: 'start' | 'end'): string[] => options.stageMarkers ? [siTaskPodStageShell('mirror', edge)] : [];
  const quotedUrl = `'${repoUrl.replace(/'/g, `'\\''`)}'`;
  const quotedMirror = `'${mirrorPath.replace(/'/g, `'\\''`)}'`;
  const quotedImageDir = `'${(options.imageSourceDir ?? '/opt/elanous-source').replace(/'/g, `'\\''`)}'`;
  const quotedCommitFile = `'${(options.imageCommitFile ?? '/opt/elanous-source-commit').replace(/'/g, `'\\''`)}'`;
  const quotedImageGitDir = `'${(options.imageGitDir ?? '/opt/elanous-pin.git').replace(/'/g, `'\\''`)}'`;
  const clone = `git clone -q --depth 50 ${quotedUrl} repo`;
  const sourceRecordSha = source.kind === 'default' ? (baseSha ?? '')
    : source.kind === 'commit' ? assertSha(source.sha, 'commit sha')
    : source.kind === 'bundle' ? assertSha(source.headCommit, 'headCommit')
    : source.kind === 'min-sync' ? assertSha(source.baseSha, 'base sha') : '';
  const sourceOutcomeStart = [
    `pod_source_kind='${source.kind}'`,
    `pod_source_base_sha='${sourceRecordSha}'`,
    'pod_source_stage=source-preflight',
    'pod_source_failure_code=',
    'pod_source_result_reported=0',
    'pod_source_result_emit() {',
    '  pod_source_exit="${1:-0}"',
    '  [ "$pod_source_result_reported" -eq 0 ] || return 0; pod_source_result_reported=1',
    '  pod_source_result_status=failed; if [ "${pod_source_io_measured:-0}" -eq 1 ]; then pod_source_result_status=complete; elif [ "$pod_source_exit" -eq 0 ]; then pod_source_result_status=incomplete; fi',
    '  if [ "$pod_source_exit" -ne 0 ] && [ -z "$pod_source_failure_code" ]; then pod_source_failure_code=source-step-failed; fi',
    '  pod_source_failure_json=null; if [ -n "$pod_source_failure_code" ]; then pod_source_failure_json="\\\"$pod_source_failure_code\\\""; fi',
    '  pod_source_base_sha_json=null; if [ -n "$pod_source_base_sha" ]; then pod_source_base_sha_json="\\\"$pod_source_base_sha\\\""; fi',
    '  printf \'ELANOUS_POD_SOURCE_RESULT {"sourceStage":"%s","sourceKind":"%s","sourceVia":"%s","sourceStatus":"%s","baseSha":%s,"exitCode":%s,"failureCode":%s}\\n\' "$pod_source_stage" "$pod_source_kind" "${source_via:-unknown}" "$pod_source_result_status" "$pod_source_base_sha_json" "$pod_source_exit" "$pod_source_failure_json"',
    '}',
  ];
  // First observation slice: count source checkout work without changing its routing.
  const ioStart = [
    ...sourceOutcomeStart,
    // Count calls performed by this Pod source stage. Branch validation via
    // assertRemoteBase runs on the host before Job creation and is outside it.
    'pod_source_io_origin_calls=0',
    'pod_source_io_started=$(date +%s)',
    'pod_source_io_reported=0',
    'pod_source_io_measured=0',
    'pod_source_io_measure() { pod_source_io_files=$(git ls-files -z | tr -cd "\\000" | wc -c | tr -d " "); pod_source_io_seconds=$(( $(date +%s) - pod_source_io_started )); pod_source_io_measured=1; pod_source_stage=source-complete; }',
    'pod_source_io_emit() {',
    '  pod_source_exit=$?',
    '  [ "$pod_source_io_reported" -eq 0 ] || return 0; pod_source_io_reported=1',
    '  [ -n "${pod_source_io_seconds:-}" ] || pod_source_io_seconds=$(( $(date +%s) - pod_source_io_started ))',
    '  [ -n "${pod_source_io_files:-}" ] || pod_source_io_files=null',
    '  pod_source_io_status=incomplete; if [ "$pod_source_io_measured" -eq 1 ]; then pod_source_io_status=complete; fi',
    '  printf \'ELANOUS_POD_SOURCE_IO {"originCalls":%s,"checkoutFiles":%s,"sourceVia":"%s","sourceSeconds":%s,"sourceStatus":"%s","pushCalls":null,"installRan":null,"installSeconds":null}\\n\' "$pod_source_io_origin_calls" "$pod_source_io_files" "${source_via:-unknown}" "$pod_source_io_seconds" "$pod_source_io_status"',
    '  pod_source_result_emit "$pod_source_exit"',
    '}',
    'trap pod_source_io_emit EXIT',
  ];
  const start = [
    'if [ -e repo ]; then exit 5; fi',
    // POD-MIRROR-IO: the image's pinned tree is a shared read-only lower layer.
    // Git metadata is tiny and private to this Pod; alternates point first at
    // the image's shallow pin objects, then optionally at the host mirror.
    'source_via=',
    'pod_source_stage=image-source',
    `if [ -f ${quotedCommitFile} ] && [ -d ${quotedImageDir} ] && [ -d ${quotedImageGitDir} ]; then`,
    // Older pinned images can contain macOS AppleDouble pack sidecars. Git may
    // interpret `._pack-*.idx` as an index and fail even when the real pack is valid.
    `  if [ -d ${quotedImageGitDir}/objects/pack ]; then find ${quotedImageGitDir}/objects/pack -maxdepth 1 -type f -name '._*' -delete || { printf 'ELANOUS_POD_SOURCE_IMAGE_FAIL appledouble-cleanup\n'; exit 5; }; fi`,
    `  image_commit=$(cat ${quotedCommitFile})`,
    `  if [[ "$image_commit" =~ ^[0-9a-f]{40}$ ]] && git -C ${quotedImageGitDir} cat-file -e "$image_commit^{commit}" 2>/dev/null && [ -f ${quotedImageGitDir}/shallow ] && grep -Fxq "$image_commit" ${quotedImageGitDir}/shallow; then`,
    `    ln -s ${quotedImageDir} repo || exit 5`,
    `    image_objects=$(git -C ${quotedImageGitDir} rev-parse --path-format=absolute --git-path objects)`,
    `    if git -C repo init -q -b main && mkdir -p repo/.git/objects/info && printf '%s\\n' "$image_objects" > repo/.git/objects/info/alternates; then`,
    // 부모 resolver 가 exact SHA 를 준 image 라우트에선 호스트 미러를 alternates 로 빌리지 않는다.
    // 그 SHA 는 아래 baseSha 분기의 raw-SHA fetch 로 Pod 전용 object store 에 직접 들어오므로
    // ① ELANOUS_POD_SOURCE_BASE_SHA_FROM 마커가 «실제» 객체 출처를 말하고
    // ② 호스트 마운트가 런타임에 사라져도 'unable to normalize alternate object path' 로
    //    checkout 이 깨지지 않는다(라운드1 미러 alternates 플레이크의 뿌리 제거).
    ...(source.kind === 'default' && baseSha
      ? []
      : [
          `      if [ -d ${quotedMirror} ]; then mirror_objects=$(git -C ${quotedMirror} rev-parse --path-format=absolute --git-path objects 2>/dev/null || :); [ -z "$mirror_objects" ] || printf '%s\\n' "$mirror_objects" >> repo/.git/objects/info/alternates; fi`,
        ]),
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
    'pod_source_stage=mirror-source',
    // TA-POD-WARMBOOT-PARITY (10-16): the mirror fallback used to be silent — 157 HARD gate Pods all said
    // `VIA github` and nothing said why (the Job had no /host-mirror mount). Each failed step now names itself.
    'mirror_skip=',
    ...mark('start'),
    `if ! [ -d ${quotedMirror} ]; then mirror_skip=no-mount`,
    `elif ! git -C ${quotedMirror} rev-parse --verify HEAD >/dev/null 2>&1; then mirror_skip=rev-parse-failed`,
    ...(source.kind === 'default' && baseSha
      ? [`elif ! git init -q -b main repo || ! git -C repo fetch --quiet --no-write-fetch-head ${quotedMirror} '${baseSha}' || ! git -C repo cat-file -e '${baseSha}^{commit}' 2>/dev/null; then mirror_skip=sha-fetch-failed`]
      : [`elif ! git clone -q --shared -- ${quotedMirror} repo || ! git -C repo rev-parse --verify HEAD >/dev/null 2>&1; then mirror_skip=clone-failed`]),
    'fi',
    'if [ -z "$mirror_skip" ]; then',
    ...mark('end').map((line) => `  ${line}`),
    ...(source.kind === 'default' && baseSha
      ? [`  git -C repo remote add origin ${quotedUrl} || exit 5`]
      : [`  git -C repo remote set-url origin ${quotedUrl} || exit 5`]),
    '  source_via=mirror',
    'else',
    "  printf 'ELANOUS_POD_SOURCE_MIRROR_SKIP %s\\n' \"$mirror_skip\"",
    '  if [ -e repo ]; then rm -r -- repo || exit 5; fi',
    ...(source.kind === 'default' && baseSha ? [] : ['  pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))']),
    ...(source.kind === 'default' && baseSha ? [
        `  pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' '${baseSha}'`,
      '  exit 5',
    ] : [`  ${clone} || exit 5`]),
    '  source_via=github',
    'fi',
    'fi',
    "printf 'ELANOUS_POD_SOURCE_VIA %s\\n' \"$source_via\"",
    'cd repo || exit 5',
  ];
  if (source.kind === 'default') {
    if (baseSha) {
      const sha = baseSha;
      const base = source.base ?? 'main';
      if (base.startsWith('-') || !/^[\w./-]+$/.test(base)) throw new Error(`invalid Pod base ref: ${base}`);
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const quotedBase = quote(base);
      const quotedTrackingRef = quote(`refs/remotes/origin/${base}`);
      const quotedUpstream = quote(`origin/${base}`);
      return [
        ...ioStart,
        ...start,
        // «실제 객체 출처» 마커: image 라우트는 핀 객체, mirror 라우트는 --shared alternates 가
        // 해결된 SHA 를 이미 갖고 있으면 그 쪽이 출처다. 어느 쪽에도 없으면 호스트 미러에서
        // raw-SHA fetch 로 Pod 전용 object store 에 직접 가져온다(프로덕션 미러 = push 로 심은
        // bare 저장소, upload-pack 기본 설정 · refs/브랜치 경유 없음).
        'pod_source_base_sha_from="$source_via"',
        `if ! git cat-file -e '${sha}^{commit}' 2>/dev/null; then pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' '${sha}'; exit 5; fi`,
        `printf 'ELANOUS_POD_SOURCE_BASE_SHA_FROM %s\\n' "$pod_source_base_sha_from"`,
        `git checkout -q -B ${quotedBase} '${sha}' || exit 5`,
        `git update-ref ${quotedTrackingRef} '${sha}' || exit 5`,
        `git symbolic-ref refs/remotes/origin/HEAD ${quotedTrackingRef} || exit 5`,
        `git branch --set-upstream-to=${quotedUpstream} ${quotedBase} >/dev/null || exit 5`,
        'head=$(git rev-parse HEAD)',
        'pod_source_io_measure',
        "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
        'pod_source_io_emit',
      ].join('\n');
    }
    if (source.base && source.base !== 'main') {
      assertRemoteBase(repoUrl, source.base);
      const base = source.base;
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const quotedTrackingRef = quote(`refs/remotes/origin/${base}`);
      return [
        ...ioStart,
        ...start,
        'pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
        `git fetch --depth 50 origin ${quote(`+refs/heads/${base}:refs/remotes/origin/${base}`)} || exit 5`,
        `git checkout -q -B ${quote(base)} ${quotedTrackingRef} || exit 5`,
        'head=$(git rev-parse HEAD)',
        'pod_source_io_measure',
        "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
        'pod_source_io_emit',
      ].join('\n');
    }
    return [
      ...ioStart,
      ...start,
      'if [ "$source_via" != github ]; then',
      '  pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      '  remote_info=$(git ls-remote --symref origin HEAD) || exit 5',
      `  remote_head=$(printf '%s\\n' "$remote_info" | awk '$2=="HEAD" && $1!="ref:" {print $1}')`,
      `  remote_branch=$(printf '%s\\n' "$remote_info" | awk '$1=="ref:" && $3=="HEAD" && $2 ~ /^refs\\/heads\\// {sub(/^refs\\/heads\\//, "", $2); print $2}')`,
      '  if ! [[ "$remote_head" =~ ^[0-9a-f]{40}$ ]]; then exit 5; fi',
      '  if [ "$remote_head" != "$(git rev-parse HEAD)" ]; then',
      `    if [ "$source_via" = image ] && git -C ${quotedMirror} cat-file -e "$remote_head^{commit}" 2>/dev/null; then`,
      '      git reset --hard "$remote_head" || exit 5',
      "      printf 'ELANOUS_POD_SOURCE_DELTA mirror\\n'",
      '    else',
      '      pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
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
      'pod_source_io_measure',
      "printf 'ELANOUS_POD_SOURCE default %s\\n' \"$head\"",
      'pod_source_io_emit',
    ].join('\n');
  }
  if (source.kind === 'commit') {
    const sha = assertSha(source.sha, 'sha');
    return [
      ...ioStart,
      ...start,
      `if ! git cat-file -e '${sha}^{commit}' 2>/dev/null; then pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1)); git fetch --depth 1 origin ${sha} || exit 5; fi`,
      `git checkout --detach ${sha} || exit 5`,
      'head=$(git rev-parse HEAD)',
      'pod_source_io_measure',
      "printf 'ELANOUS_POD_SOURCE commit %s\\n' \"$head\"",
      'pod_source_io_emit',
    ].join('\n');
  }
  if (source.kind === 'pr') {
    const n = assertPositiveInt(source.number);
    return [
      ...ioStart,
      ...start,
      'pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      `pr_sha=$(git ls-remote origin refs/pull/${n}/head | cut -f1) || exit 5`,
      'if ! [[ "$pr_sha" =~ ^[0-9a-f]{40}$ ]]; then exit 5; fi',
      `if ! git cat-file -e "$pr_sha^{commit}" 2>/dev/null; then pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1)); git fetch --depth 50 origin pull/${n}/head || exit 5; fi`,
      `git checkout -B pr-${n} "$pr_sha" || exit 5`,
      // A pinned image starts at one shallow main commit. Fetching a PR tip at
      // depth 50 can leave that pin and the PR in disconnected shallow spans.
      // Deepen only after merge-base fails; the gate still reports unavailable
      // if ancestry cannot be obtained.
      'pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      'remote_info=$(git ls-remote --symref origin HEAD 2>/dev/null) || { printf \'ELANOUS_POD_COMPARISON_BASE unavailable\\n\'; exit 5; }',
      `base_branch=$(printf '%s\\n' "$remote_info" | awk '$1=="ref:" && $3=="HEAD" && $2 ~ /^refs\\/heads\\// {sub(/^refs\\/heads\\//, "", $2); print $2}')`,
      'if [ -n "$base_branch" ] && git check-ref-format --branch "$base_branch" >/dev/null 2>&1; then',
      '  base_ref="refs/remotes/origin/$base_branch"',
      '  pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      '  git fetch --depth 50 origin "+refs/heads/$base_branch:$base_ref" || { printf \'ELANOUS_POD_COMPARISON_BASE unavailable\\n\'; exit 5; }',
      '  git symbolic-ref refs/remotes/origin/HEAD "$base_ref" || exit 5',
      '  if ! git merge-base HEAD "$base_ref" >/dev/null 2>&1 && [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
      '    pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      `    git fetch --deepen=100 origin "+refs/heads/$base_branch:$base_ref" +refs/pull/${n}/head:refs/remotes/origin/pr-${n}-head || printf 'ELANOUS_POD_COMPARISON_BASE deepen-failed\\n'`,
      '  fi',
      '  if ! git merge-base HEAD "$base_ref" >/dev/null 2>&1 && [ "$(git rev-parse --is-shallow-repository)" = true ]; then',
      '    pod_source_io_origin_calls=$((pod_source_io_origin_calls + 1))',
      `    git fetch --unshallow origin "+refs/heads/$base_branch:$base_ref" +refs/pull/${n}/head:refs/remotes/origin/pr-${n}-head || { printf 'ELANOUS_POD_COMPARISON_BASE unavailable\\n'; exit 5; }`,
      '  fi',
      "  if ! git merge-base HEAD \"$base_ref\" >/dev/null 2>&1; then printf 'ELANOUS_POD_COMPARISON_BASE unavailable\\n'; fi",
      "else printf 'ELANOUS_POD_COMPARISON_BASE unavailable\\n'; exit 5; fi",
      'head=$(git rev-parse HEAD)',
      'pod_source_io_measure',
      "printf 'ELANOUS_POD_SOURCE pr %s\\n' \"$head\"",
      'pod_source_io_emit',
    ].join('\n');
  }
  if (source.kind === 'min-sync') {
    // POD-REUSE-MIN-SYNC — 같은 웜 Pod 재사용 수신. 새 Pod 갈래(clone/image)와 반대로:
    //  ① 대상 base 를 호스트 미러 또는 부모가 넘긴 git bundle 에서만 받는다(GitHub 원격 호출 0).
    //  ② 기존 작업 트리를 지우지 않고 «이전 head → 새 base» 차이 파일만 checkout/reset 하고
    //     남은 untracked·빌드 산출만 clean 한다(제외 목록·status 게이트 = decidePodReuseCleanup).
    //  ③ node_modules 는 bun.lock 해시가 같으면 그대로 재사용(설치 건너뜀), 다르면 재설치한다.
    //  ④ 요청마다 «GitHub 호출 수 · 바뀐 파일 수 · 소요 초»를 ELANOUS_POD_STAGE 표지로 남긴다.
    const baseSha = assertSha(source.baseSha, 'base sha');
    const previousHead = assertSha(source.previousHead, 'previous head');
    const lockHash = source.lockHash ? assertSha256(source.lockHash) : undefined;
    const bundle = source.bundle ? {
      bundlePath: source.bundle.bundlePath, sha256: assertSha256(source.bundle.sha256), sizeBytes: assertSize(source.bundle.sizeBytes),
    } : undefined;
    const cleanupPlan = decidePodReuseCleanup({ base: baseSha, resetExitCode: 0, cleanExitCode: 0, statusExitCode: 0, statusPorcelain: '' });
    const checkout = options.checkoutDir ?? 'repo';
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const quotedCheckout = quote(checkout);
    const gitArgv = (args: readonly string[]) => args.map(quote).join(' ');
    return [
      ...sourceOutcomeStart,
      'source_via=min-sync',
      'pod_source_stage=min-sync',
      'pod_source_io_origin_calls=0',
      'pod_source_io_started=$(date +%s)',
      'pod_source_io_reported=0',
      'pod_source_io_measured=0',
      'pod_source_io_install_ran=false',
      'pod_source_io_install_seconds=null',
      'pod_source_io_emit() {',
      '  pod_source_exit=$?',
      '  [ "$pod_source_io_reported" -eq 0 ] || return 0; pod_source_io_reported=1',
      '  [ -n "${pod_source_io_seconds:-}" ] || pod_source_io_seconds=$(( $(date +%s) - pod_source_io_started ))',
      '  pod_source_io_status=incomplete; if [ "$pod_source_io_measured" -eq 1 ]; then pod_source_io_status=complete; fi',
      '  printf \'ELANOUS_POD_SOURCE_IO {"originCalls":%s,"checkoutFiles":%s,"sourceVia":"%s","sourceSeconds":%s,"sourceStatus":"%s","pushCalls":null,"installRan":%s,"installSeconds":%s}\\n\' "$pod_source_io_origin_calls" "${pod_source_io_files:-null}" "$source_via" "$pod_source_io_seconds" "$pod_source_io_status" "$pod_source_io_install_ran" "$pod_source_io_install_seconds"',
      '  pod_source_result_emit "$pod_source_exit"',
      '}',
      'trap pod_source_io_emit EXIT',
      `if [ ! -d ${quotedCheckout}/.git ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH no-warm-checkout\\n'; exit 5; fi`,
      `cd ${quotedCheckout} || exit 5`,
      'resident_head=$(git rev-parse HEAD) || exit 5',
      `if [ "$resident_head" != ${quote(previousHead)} ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH previous-head-mismatch %s\\n' "$resident_head"; exit 5; fi`,
      `if ! git cat-file -e ${quote(`${baseSha}^{commit}`)} 2>/dev/null; then`,
      ...(bundle ? [
        `  size=$(wc -c < ${quote(bundle.bundlePath)} | tr -d " ")`,
        `  if [ "$size" != "${bundle.sizeBytes}" ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH size\\n'; exit 3; fi`,
        `  got=$(sha256sum ${quote(bundle.bundlePath)} | awk '{print $1}')`,
        `  if [ "$got" != "${bundle.sha256}" ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH sha256\\n'; exit 3; fi`,
        `  git fetch --quiet --no-write-fetch-head ${quote(bundle.bundlePath)} ${quote(baseSha)} || { pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' ${quote(baseSha)}; exit 5; }`,
      ] : [
        `  if [ -d ${quotedMirror} ]; then git fetch --quiet --no-write-fetch-head ${quotedMirror} ${quote(baseSha)} || { pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' ${quote(baseSha)}; exit 5; }; else pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' ${quote(baseSha)}; exit 5; fi`,
      ]),
      'fi',
      `if ! git cat-file -e ${quote(`${baseSha}^{commit}`)} 2>/dev/null; then pod_source_stage=base-sha; pod_source_failure_code=base-sha-unavailable; printf 'ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' ${quote(baseSha)}; exit 5; fi`,
      'minsync_paths=$(mktemp) || exit 5',
      `git diff --name-only -z ${quote(previousHead)} ${quote(baseSha)} > "$minsync_paths" || exit 5`,
      `pod_source_io_files=$(tr -cd "\\000" < "$minsync_paths" | wc -c | tr -d " ")`,
      `git reset -q ${quote(baseSha)} || exit 5`,
      "while IFS= read -r -d '' path; do",
      `  if git cat-file -e ${quote(`${baseSha}:`)}"$path" 2>/dev/null; then git checkout -q -- "$path" || exit 5; fi`,
      'done < "$minsync_paths"',
      'rm -f -- "$minsync_paths"',
      `git ${gitArgv(cleanupPlan.cleanArgs)} || exit 5`,
      ...(lockHash ? [
        'if [ ! -f bun.lock ]; then printf \'ELANOUS_POD_SOURCE_MISMATCH lockfile-missing\\n\'; exit 5; fi',
        "lock_now=$(sha256sum bun.lock | awk '{print $1}')",
        `if [ "$lock_now" != ${quote(lockHash)} ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH lock-hash-does-not-match-request\\n'; exit 5; fi`,
        "installed_lock_hash=",
        'install_marker=node_modules/.elanous-installed-lock-hash',
        'if [ -f "$install_marker" ] && [ ! -L "$install_marker" ]; then installed_lock_hash=$(cat "$install_marker") || exit 5; fi',
        'if [ "$installed_lock_hash" != "$lock_now" ]; then',
        '  install_t0=$SECONDS',
        "  if ! bun install >/dev/null 2>&1; then printf 'ELANOUS_POD_SOURCE_MISMATCH install-failed\\n'; exit 5; fi",
        '  pod_source_io_install_ran=true',
        '  pod_source_io_install_seconds=$(( SECONDS - install_t0 ))',
        '  install_marker_tmp=$(mktemp "$install_marker.tmp.XXXXXX") || exit 5',
        '  printf \'%s\\n\' "$lock_now" > "$install_marker_tmp" && mv -- "$install_marker_tmp" "$install_marker" || { rm -f -- "$install_marker_tmp"; exit 5; }',
        'fi',
      ] : []),
      `minsync_status=$(git ${gitArgv(cleanupPlan.statusArgs)}) || exit 5`,
      `if [ -n "$minsync_status" ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH worktree-not-clean\\n'; exit 5; fi`,
      'head=$(git rev-parse HEAD) || exit 5',
      `if [ "$head" != ${quote(baseSha)} ]; then printf 'ELANOUS_POD_SOURCE_MISMATCH base-head-mismatch\\n'; exit 5; fi`,
      'pod_source_io_seconds=$(( $(date +%s) - pod_source_io_started ))',
      'pod_source_io_measured=1',
      `printf 'ELANOUS_POD_STAGE min-sync %s %s %s\\n' "$pod_source_io_origin_calls" "$pod_source_io_files" "$pod_source_io_seconds"`,
      `printf 'ELANOUS_POD_SOURCE min-sync %s\\n' "$head"`,
      'pod_source_io_emit',
    ].join('\n');
  }
  const sha256 = assertSha256(source.sha256);
  const sizeBytes = assertSize(source.sizeBytes);
  const headCommit = assertSha(source.headCommit, 'headCommit');
  return [
    ...ioStart,
    'source_via=bundle',
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
    'cd repo || exit 5',
    'head=$(git rev-parse HEAD) || exit 5',
    'pod_source_io_measure',
    "printf 'ELANOUS_POD_SOURCE bundle %s\\n' \"$head\"",
    'pod_source_io_emit',
  ].join('\n');
}
