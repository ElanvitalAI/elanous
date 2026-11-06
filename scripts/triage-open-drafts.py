#!/usr/bin/env python3
"""🅢 열린 self-impl draft PR 트리아지 — 「버려진 가치가 있나」를 «반복 가능»하게 묻는다.

⚠️ 이 자가 답하는 것은 「어느 것을 «열어 볼» 가치가 있나」까지다.
   ⛔ 「병합해도 되나」는 «안» 답한다 — 그것은 브랜치를 실제로 돌려야 나온다(반증 포함).
"""
import json, os, re, subprocess, sys, tempfile

MAIN_ACCEPTED_ALL = '🟢 main에 전부 있음'
MAIN_ACCEPTED_NONE = '🔴 main에 하나도 없음'
MAIN_ACCEPTED_PARTIAL = '🟡 main에 일부만 있음'
MAIN_ACCEPTANCE_UNMEASURED = '⚪ main 수용 못 쟀다'
MAIN_ACCEPTANCE_MISSING_BRANCH = '브랜치 없음'
MAIN_ACCEPTANCE_AMBIGUOUS_MAPPING = '대응 모호'
MAIN_ACCEPTANCE_COMMAND_FAILURE = '명령 실패'
MAIN_ACCEPTANCE_STALE_REF = '로컬 ref 낡음'


def gh(args, timeout=30):
    try: return subprocess.run(['gh', *args], capture_output=True, text=True, timeout=timeout).stdout
    except Exception: return ''


def git_result(args, timeout=30, env=None):
    try:
        return subprocess.run(['git', *args], capture_output=True, text=True, timeout=timeout, env=env)
    except Exception:
        return None


def git(args, timeout=30, env=None):
    result = git_result(args, timeout=timeout, env=env)
    return result.stdout if result and result.returncode == 0 else None


def classify_draft_body(body):
    gate = 'PASS' if '[test] PASS' in body else ('FAIL' if '[test] FAIL' in body else '-')
    m = re.search(r'(?ms)^## 마지막 리뷰 must-fix\s*$(.*?)(?=^## |\Z)', body)
    must_fix = len([line for line in m.group(1).strip().split('\n') if line.strip().startswith('-')]) if m else 0
    return '① gate PASS · must-fix 0' if (gate == 'PASS' and must_fix == 0) else \
        '② gate PASS · must-fix 있음' if gate == 'PASS' else \
        '③ gate FAIL' if gate == 'FAIL' else '④ gate 판정 없음(예산 등)'


def classify_main_acceptance(change_results):
    """Classify measured merge-base-relative changes without discarding local uncertainty."""
    if change_results is None:
        return MAIN_ACCEPTANCE_UNMEASURED
    measured = [result for result in change_results if result is not None]
    unmeasured = len(change_results) - len(measured)
    if not measured:
        return MAIN_ACCEPTANCE_UNMEASURED
    status = MAIN_ACCEPTED_ALL if all(measured) else MAIN_ACCEPTED_NONE if not any(measured) else MAIN_ACCEPTED_PARTIAL
    return f'{status} ({len(change_results)}칸 중 {unmeasured}칸 못 쟀다)' if unmeasured else status


def main_acceptance_bucket(acceptance):
    status = acceptance[0] if isinstance(acceptance, (tuple, list)) else acceptance
    if MAIN_ACCEPTANCE_UNMEASURED in status or '못 쟀다' in status:
        return MAIN_ACCEPTANCE_UNMEASURED
    for bucket in (MAIN_ACCEPTED_ALL, MAIN_ACCEPTED_NONE, MAIN_ACCEPTED_PARTIAL):
        if status.startswith(bucket):
            return bucket
    return MAIN_ACCEPTANCE_UNMEASURED


def main_acceptance_reason(acceptance):
    return acceptance[1] if isinstance(acceptance, (tuple, list)) else None


def source_diff_args(base, branch):
    return ['diff', '--no-ext-diff', '--unified=3', base, branch, '--', '.', ':(exclude)docs/**']


def source_raw_args(base, revision):
    return ['diff', '--no-ext-diff', '--find-renames', '--raw', base, revision, '--', '.', ':(exclude)docs/**']


def metadata_entries(raw):
    """Return source metadata entries, excluding ordinary content-only modifications."""
    entries = []
    for line in raw.splitlines():
        header, separator, names = line.partition('\t')
        fields = header.split()
        if not separator or len(fields) != 5 or not fields[0].startswith(':'):
            continue
        old_mode, new_mode, old_blob, new_blob, status = fields[0][1:], fields[1], fields[2], fields[3], fields[4][0]
        if old_mode != new_mode or status in {'A', 'D', 'R', 'C', 'T'}:
            entries.append((status, old_blob, new_blob, tuple(names.split('\t'))))
    return entries


def split_source_hunks(patch):
    """Split source changes while retaining hunk context and EOF markers for git apply."""
    files, current = [], []
    for line in patch.splitlines(keepends=True):
        if line.startswith('diff --git '):
            if current: files.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current: files.append(current)
    changes = []
    for lines in files:
        if any(line.startswith('GIT binary patch') or line.startswith('Binary files ') for line in lines): return None
        starts = [index for index, line in enumerate(lines) if line.startswith('@@ ')]
        if not starts: continue
        file_header = lines[:starts[0]]
        if any(line.startswith(('new file mode ', 'deleted file mode ', 'similarity index ', 'rename from ', 'rename to ', 'copy from ', 'copy to ')) for line in file_header):
            continue
        for index, start in enumerate(starts):
            end = starts[index + 1] if index + 1 < len(starts) else len(lines)
            match = re.match(r'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', lines[start])
            if not match: return None
            old_start, new_start = int(match.group(1)), int(match.group(3))
            body = lines[start + 1:end]
            groups, position = [], 0
            old_position, new_position = old_start, new_start
            def append_group(kind, group_lines):
                nonlocal old_position, new_position
                groups.append((kind, group_lines, old_position, new_position))
                old_position += sum(line.startswith(('-', ' ')) for line in group_lines)
                new_position += sum(line.startswith(('+', ' ')) for line in group_lines)
            while position < len(body):
                if body[position].startswith(' '):
                    append_group('context', [body[position]]); position += 1
                elif body[position].startswith(('-', '+')):
                    change_lines = []
                    while position < len(body) and (body[position].startswith(('-', '+')) or body[position].startswith('\\ No newline at end of file')):
                        change_lines.append(body[position]); position += 1
                    if any(line.startswith('\\ No newline at end of file') for line in change_lines):
                        append_group('change', change_lines)
                        continue
                    removed = [line for line in change_lines if line.startswith('-')]
                    added = [line for line in change_lines if line.startswith('+')]
                    paired = min(len(removed), len(added))
                    for pair in range(paired): append_group('change', [removed[pair], added[pair]])
                    for line in removed[paired:]: append_group('change', [line])
                    for line in added[paired:]: append_group('change', [line])
                else:
                    return None
            for selected, (kind, selected_lines, selected_old_start, selected_new_start) in enumerate(groups):
                if kind != 'change': continue
                before = []
                for group_kind, group_lines, _, _ in reversed(groups[:selected]):
                    if group_kind != 'context' or len(before) == 3:
                        break
                    before.append((group_kind, group_lines))
                before.reverse()
                after = []
                for group_kind, group_lines, _, _ in groups[selected + 1:]:
                    if group_kind != 'context' or len(after) == 3:
                        break
                    after.append((group_kind, group_lines))
                rendered = [line for _, lines in before for line in lines] + selected_lines + [line for _, lines in after for line in lines]
                old_count = sum(line.startswith(('-', ' ')) for line in rendered)
                new_count = sum(line.startswith(('+', ' ')) for line in rendered)
                before_old_count = sum(line.startswith(('-', ' ')) for _, lines in before for line in lines)
                before_new_count = sum(line.startswith(('+', ' ')) for _, lines in before for line in lines)
                has_addition = any(line.startswith('+') for line in selected_lines)
                hunk = f'@@ -{selected_old_start - before_old_count},{old_count} +{selected_new_start - before_new_count},{new_count} @@\n'
                changes.append((has_addition, ''.join(file_header + [hunk] + rendered)))
    return changes


def patch_matches_main(patch):
    """Prove an unapplyable addition has its exact local hunk context in main."""
    path = re.search(r'^\+\+\+ b/(.+)$', patch, re.M)
    hunk = re.search(r'^@@ .* @@\n(?P<body>.*)', patch, re.M | re.S)
    if not path or not hunk:
        return None
    content = git(['show', f'origin/main:{path.group(1)}'])
    if content is None:
        return None
    body = hunk.group('body').splitlines()
    expected = [line[1:] for line in body if line.startswith((' ', '+'))]
    changed = [line[1:] for line in body if line.startswith('+')]
    if not changed or not expected:
        return None
    lines = content.splitlines()
    return True if any(lines[index:index + len(expected)] == expected for index in range(len(lines) - len(expected) + 1)) else None


def patch_retains_removed_value(patch):
    """Check whether a removed value remains near this hunk's mapped source position."""
    path = re.search(r'^--- a/(.+)$', patch, re.M)
    hunk = re.search(r'^@@ -(\d+)(?:,\d+)? .*@@\n(?P<body>.*)', patch, re.M | re.S)
    if not path or not hunk:
        return None
    content = git(['show', f'origin/main:{path.group(1)}'])
    if content is None:
        return None
    removed = [line[1:] for line in hunk.group('body').splitlines() if line.startswith('-')]
    if not removed:
        return None
    lines = content.splitlines()
    position = int(hunk.group(1)) - 1
    window = lines[max(0, position - 3):position + 4]
    return any(value in window for value in removed)


def patch_applies(patch, env, reverse=False):
    """Check a merge-base-relative patch against the origin/main index."""
    try:
        completed = subprocess.run(
            ['git', 'apply', '--check', '--cached', '--recount', *( ['--reverse'] if reverse else []), '-'],
            input=patch, capture_output=True, text=True, env=env, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.returncode == 0


def metadata_acceptance(base, branch, run=git):
    """Compare merge-base-relative metadata deltas, not whole current files."""
    branch_raw = run(source_raw_args(base, branch))
    main_raw = run(source_raw_args(base, 'origin/main'))
    if branch_raw is None or main_raw is None:
        return None
    branch_entries = metadata_entries(branch_raw)
    main_entries = set(metadata_entries(main_raw))
    return [entry in main_entries for entry in branch_entries]


def measurement_ref(branch, pr_number=None):
    if git(['rev-parse', '--verify', '--quiet', branch]) is not None:
        return branch
    if pr_number is not None and git(['rev-parse', '--verify', '--quiet', f'refs/remotes/origin/pr/{pr_number}']) is not None:
        return f'refs/remotes/origin/pr/{pr_number}'
    return branch


def pinned_head_revision(branch, pr_number, head_sha):
    """PR-HEAD-FETCH-STATELESS: measure the PR's pinned head SHA itself, not a named local ref.

    A named ref (local branch · refs/remotes/origin/pr/N) can lag a rebased PR. When the pinned
    commit object is local, the SHA is the revision; otherwise an existing named ref is «stale»
    (it cannot equal a commit we do not have), and no ref at all is «missing».
    """
    if git(['cat-file', '-e', f'{head_sha}^{{commit}}']) is not None:
        return head_sha, None
    named = [branch] + ([f'refs/remotes/origin/pr/{pr_number}'] if pr_number is not None else [])
    if any(git(['rev-parse', '--verify', '--quiet', ref]) is not None for ref in named):
        return None, MAIN_ACCEPTANCE_STALE_REF
    return None, MAIN_ACCEPTANCE_MISSING_BRANCH


_UNPINNED = object()


def measure_main_acceptance(branch, pr_number=None, run=git, head_sha=_UNPINNED):
    """Measure local git only and name why an unmeasured branch cannot be assessed.

    `head_sha` omitted keeps the legacy named-ref lookup for direct callers. Once a caller pins it
    (main() always does, from gh headRefOid), an absent or malformed SHA is a command failure — never a
    silent fallback to a named ref that may be stale.
    """
    if head_sha is not _UNPINNED and not (isinstance(head_sha, str) and re.fullmatch(r'[0-9a-f]{40}', head_sha)):
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
    if run is git and head_sha is not _UNPINNED:
        revision, reason = pinned_head_revision(branch, pr_number, head_sha)
        if revision is None:
            return MAIN_ACCEPTANCE_UNMEASURED, reason
    else:
        revision = measurement_ref(branch, pr_number) if run is git else branch
    if run is git:
        verified = git_result(['rev-parse', '--verify', '--quiet', revision])
        if verified is None:
            return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
        if verified.returncode == 1:
            return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_MISSING_BRANCH
        if verified.returncode != 0:
            return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
    elif run(['rev-parse', '--verify', '--quiet', revision]) is None:
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_MISSING_BRANCH
    if run(['merge-base', '--is-ancestor', revision, 'origin/main']) == '':
        return MAIN_ACCEPTED_ALL, None
    base = run(['merge-base', 'origin/main', revision])
    if base is None or not base.strip():
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
    patch = run(source_diff_args(base.strip(), revision))
    if patch is None or run is not git:
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
    changes = split_source_hunks(patch)
    if changes is None:
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_AMBIGUOUS_MAPPING
    results, reasons = [], []
    try:
        with tempfile.TemporaryDirectory() as temporary_directory:
            env = {**os.environ, 'GIT_INDEX_FILE': os.path.join(temporary_directory, 'main.index')}
            if git(['read-tree', 'origin/main'], env=env) is None:
                return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
            for is_addition, atomic_patch in changes:
                forward = patch_applies(atomic_patch, env)
                reverse = patch_applies(atomic_patch, env, reverse=True)
                if forward is None or reverse is None:
                    results.append(None); reasons.append(MAIN_ACCEPTANCE_COMMAND_FAILURE); continue
                retained = patch_retains_removed_value(atomic_patch)
                if is_addition and retained:
                    results.append(False)
                elif not forward and not reverse:
                    result = patch_matches_main(atomic_patch) if is_addition else (not retained if retained is not None else None)
                    if result is None:
                        results.append(None); reasons.append(MAIN_ACCEPTANCE_AMBIGUOUS_MAPPING)
                    else:
                        results.append(result)
                else:
                    results.append(reverse if is_addition else not forward)
            metadata = metadata_acceptance(base.strip(), revision)
            if metadata is None:
                return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
            results.extend(metadata)
    except (OSError, subprocess.SubprocessError):
        return MAIN_ACCEPTANCE_UNMEASURED, MAIN_ACCEPTANCE_COMMAND_FAILURE
    status = classify_main_acceptance(results)
    if reasons:
        return status, MAIN_ACCEPTANCE_COMMAND_FAILURE if MAIN_ACCEPTANCE_COMMAND_FAILURE in reasons else MAIN_ACCEPTANCE_AMBIGUOUS_MAPPING
    return status, None


def main(run=git):
    raw = gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,isDraft,headRefName,headRefOid,updatedAt'])
    if not raw.strip():
        print('⛔ PR 목록을 못 얻었다 — 「0건」이 아니라 «못 셌음»이다', file=sys.stderr); return 2
    prs = [p for p in json.loads(raw) if p['isDraft'] and p['headRefName'].startswith('self-impl/')]
    print(f"self-impl draft {len(prs)}건\n")
    print(f"  {'PR':<9}{'verdict':<17}{'gate':<7}{'must-fix':<10}{'나이':<7} 제목")
    buckets, acceptance_buckets, acceptance_reasons = {}, {}, {}
    for p in sorted(prs, key=lambda x: x['updatedAt']):
        b = gh(['pr', 'view', str(p['number']), '--json', 'body', '--jq', '.body'])
        v = re.search(r'verdict:\s*(\S+)', b); v = v.group(1) if v else '-'
        gate = 'PASS' if '[test] PASS' in b else ('FAIL' if '[test] FAIL' in b else '-')
        m = re.search(r'(?ms)^## 마지막 리뷰 must-fix\s*$(.*?)(?=^## |\Z)', b)
        n = len([line for line in m.group(1).strip().split('\n') if line.strip().startswith('-')]) if m else 0
        key = classify_draft_body(b); buckets.setdefault(key, []).append(p['number'])
        acceptance = measure_main_acceptance(p['headRefName'], p['number'], run, head_sha=p.get('headRefOid'))
        acceptance_buckets.setdefault(main_acceptance_bucket(acceptance), []).append(p['number'])
        reason = main_acceptance_reason(acceptance)
        if reason: acceptance_reasons.setdefault(reason, []).append(p['number'])
        print(f"  #{p['number']:<8}{v:<17}{gate:<7}{n:<10}{p['updatedAt'][5:10]:<7} {p['title'][:40]}")
    print()
    for key in sorted(buckets): print(f"  {key:<28} {len(buckets[key])}건  {' '.join('#'+str(number) for number in buckets[key])}")
    print('\n  main 수용 측정 (merge-base 대비 · docs/ 제외)')
    for key in (MAIN_ACCEPTED_ALL, MAIN_ACCEPTED_NONE, MAIN_ACCEPTED_PARTIAL, MAIN_ACCEPTANCE_UNMEASURED):
        numbers = acceptance_buckets.get(key, [])
        print(f"  {key:<28} {len(numbers)}건  {' '.join('#'+str(number) for number in numbers)}")
    for reason in (MAIN_ACCEPTANCE_MISSING_BRANCH, MAIN_ACCEPTANCE_STALE_REF, MAIN_ACCEPTANCE_AMBIGUOUS_MAPPING, MAIN_ACCEPTANCE_COMMAND_FAILURE):
        numbers = acceptance_reasons.get(reason, [])
        print(f"    {reason:<24} {len(numbers)}건  {' '.join('#'+str(number) for number in numbers)}")
    # PR-HEAD-FETCH-STATELESS: fetch objects only (FETCH_HEAD) — no named destination ref, so a rebased
    # PR head can never be refused as non-fast-forward; the next run measures the pinned headRefOid itself.
    missing_numbers = sorted(acceptance_reasons.get(MAIN_ACCEPTANCE_MISSING_BRANCH, []) + acceptance_reasons.get(MAIN_ACCEPTANCE_STALE_REF, []))
    if missing_numbers:
        refs = ' '.join(f'refs/pull/{number}/head' for number in missing_numbers)
        print(f"    가져오기 안내 (실행 안 함): git fetch origin {refs}")
    print("\n  ⛔ ①이라고 「병합 가능」이 아니다 — 브랜치를 돌리고 «반증»까지 하고 판단한다(R-REV3·R-CLM13).")
    print("  ⛔ 오래된 것은 리베이스 비용이 붙는다 — 나이를 같이 본다.")
    return 0


if __name__ == '__main__': sys.exit(main())
