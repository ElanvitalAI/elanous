#!/usr/bin/env python3
"""Remove only stale train batch scratch trees (legacy batch-*/primary-tmp and short <home>/.etb/<hex10>); preserve all artifact trees."""
import re
import json
import os
import pathlib
import shutil
import sys
import time


def active_reference(target: pathlib.Path) -> str | None:
    proc_root = pathlib.Path('/proc')
    if not proc_root.is_dir():
        import subprocess
        result = subprocess.run(['lsof', '-t', '+D', str(target)], capture_output=True, text=True, timeout=20)
        if result.returncode not in (0, 1):
            return 'unknown-active-state'
        return result.stdout.strip().splitlines()[0] if result.stdout.strip() else None
    for proc in proc_root.iterdir():
        if not proc.name.isdigit():
            continue
        try:
            uid = int(next(line.split()[1] for line in (proc / 'status').read_text().splitlines()
                           if line.startswith('Uid:')))
        except (OSError, StopIteration, ValueError):
            continue
        if uid != os.getuid():
            continue
        for link in (proc / 'cwd', *(proc / 'fd').glob('*')):
            try:
                current = pathlib.Path(os.readlink(link))
            except OSError:
                continue
            if current == target or target in current.parents:
                return proc.name
    return None


def candidate_is_old(path: pathlib.Path, cutoff: float, now: float) -> bool:
    if path.is_symlink() or not path.is_dir():
        return False
    if path.stat(follow_symlinks=False).st_mtime > cutoff:
        return False
    for root, dirs, files in os.walk(path, followlinks=False):
        root_path = pathlib.Path(root)
        if root_path.stat(follow_symlinks=False).st_mtime > cutoff:
            return False
        for name in dirs + files:
            entry = root_path / name
            # rmtree unlinks symlinks without following their targets. Check the
            # link's own age so old node_modules/.bin links do not pin scratch.
            if entry.stat(follow_symlinks=False).st_mtime > cutoff:
                return False
    return True


def clean(root: pathlib.Path, age_seconds: int, now: float | None = None) -> list[dict]:
    if age_seconds < 21600:
        raise ValueError('minimum primary-tmp age is 21600 seconds')
    if root.is_symlink() or not root.is_dir() or root.name != 'train-artifacts':
        raise ValueError('artifact root must be a real train-artifacts directory')
    now = time.time() if now is None else now
    cutoff = now - age_seconds
    results = []
    for batch in sorted(root.glob('batch-*')):
        if not batch.is_dir() or batch.is_symlink() or not batch.name[6:].isdigit():
            continue
        scratch = batch / 'primary-tmp'
        if not scratch.exists() and not scratch.is_symlink():
            continue
        reason = ''
        try:
            if batch.stat(follow_symlinks=False).st_mtime > cutoff:
                reason = 'batch-younger-than-cutoff'
            elif not candidate_is_old(scratch, cutoff, now):
                reason = 'scratch-younger-or-unsafe'
            else:
                real = scratch.resolve(strict=True)
                resolved_batch = batch.resolve(strict=True)
                if real.name != scratch.name or real.parent != resolved_batch or resolved_batch.parent != root.resolve(strict=True):
                    reason = 'path-escaped-batch'
                else:
                    active = active_reference(real)
                    if active:
                        reason = f'active-process:{active}'
                    else:
                        for current, dirs, files in os.walk(real):
                            os.chmod(current, pathlib.Path(current).stat(follow_symlinks=False).st_mode | 0o700)
                            for name in files:
                                item = pathlib.Path(current) / name
                                if not item.is_symlink():
                                    os.chmod(item, item.stat(follow_symlinks=False).st_mode | 0o600)
                        shutil.rmtree(real)
                        reason = 'removed'
        except OSError as exc:
            reason = f'error:{type(exc).__name__}:{exc}'
        results.append({'path': str(scratch), 'status': reason})
    return results


def clean_short(etb: pathlib.Path, root: pathlib.Path, age_seconds: int, now: float | None = None) -> list[dict]:
    """Sweep short gate scratch dirs (<home>/.etb/<hex10>). A dir is removed only if its .owner marker names an
    artifact directory directly under <root>/batch-N, every entry is older than the cutoff and nothing uses it."""
    if age_seconds < 21600:
        raise ValueError('minimum scratch age is 21600 seconds')
    if root.is_symlink() or not root.is_dir() or root.name != 'train-artifacts':
        raise ValueError('artifact root must be a real train-artifacts directory')
    results = []
    if etb.is_symlink() or not etb.is_dir() or etb.name != '.etb':
        return results
    now = time.time() if now is None else now
    cutoff = now - age_seconds
    for scratch in sorted(etb.iterdir()):
        if not re.fullmatch(r'[0-9a-f]{10}', scratch.name) or scratch.is_symlink() or not scratch.is_dir():
            continue  # never touch anything that is not our own naming
        owner = scratch / '.owner'
        try:
            if owner.is_symlink() or not owner.is_file():
                reason = 'no-owner-marker'
            else:
                art = pathlib.Path(owner.read_text().strip())
                if art.parent.parent != root.resolve(strict=True) or not re.fullmatch(r'batch-[0-9]+', art.parent.name):
                    reason = 'owner-outside-train-artifacts'
                elif not candidate_is_old(scratch, cutoff, now):
                    reason = 'scratch-younger-or-unsafe'
                else:
                    active = active_reference(scratch.resolve(strict=True))
                    if active:
                        reason = f'active-process:{active}'
                    else:
                        for current, dirs, files in os.walk(scratch):
                            os.chmod(current, pathlib.Path(current).stat(follow_symlinks=False).st_mode | 0o700)
                        shutil.rmtree(scratch)
                        reason = 'removed'
        except OSError as exc:
            reason = f'error:{type(exc).__name__}:{exc}'
        results.append({'path': str(scratch), 'status': reason})
    return results


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print('usage: train-primary-tmp-clean.py <train-artifacts> [age-seconds]', file=sys.stderr)
        return 2
    try:
        age = int(sys.argv[2]) if len(sys.argv) == 3 else 21600
        results = clean(pathlib.Path(sys.argv[1]), age)
        results += clean_short(pathlib.Path.home() / '.etb', pathlib.Path(sys.argv[1]), age)
    except (OSError, ValueError) as exc:
        print(f'train-primary-tmp-clean: {exc}', file=sys.stderr)
        return 2
    print(json.dumps({'cutoffSeconds': int(sys.argv[2]) if len(sys.argv) == 3 else 21600,
                      'results': results}, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
