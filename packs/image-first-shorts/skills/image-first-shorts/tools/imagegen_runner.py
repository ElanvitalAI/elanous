#!/usr/bin/env python3
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 변경(키트 _tools/imagegen_runner.py 대비):
#   ① 하드코딩 경로 제거 — PROMPTS·OUTDIR·CODEX_HOME 환경변수
#   ② 회수: codex exec --json 의 thread_id 로 «그 세션 폴더»의 png 를 집는다(레이스 없음).
#      thread_id 를 못 얻을 때만 키트 방식(가장 새 미회수 파일)으로 폴백하고 그 행에 race_fallback=true 를 남긴다.
#   ③ 결과마다 manifest(<OUTDIR>/assets/images/manifest.jsonl)에 content_checked=false 로 기록 —
#      병렬 생성은 파일명이 뒤바뀔 수 있으니 «내용을 보고» 확인·재명명하기 전엔 그래프 images 노드가 통과시키지 않는다.
#   ④ 모델은 MODEL 이 있을 때만 -m 으로 넘긴다(codex 기본값 존중).
# 실행: PROMPTS=jobs/images.jsonl OUTDIR=<workspace> PARALLEL=4 python3 imagegen_runner.py
# jsonl 한 줄: {"id","prompt","size","quality","output_path","images":[참조 이미지 절대경로...]}
import json, os, subprocess, sys, time, threading, shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

PROMPTS = Path(os.environ.get("PROMPTS", "jobs/images.jsonl"))
OUTDIR = Path(os.environ.get("OUTDIR", "."))
PARALLEL = int(os.environ.get("PARALLEL", "4"))
TIMEOUT = int(os.environ.get("TIMEOUT", "300"))
CODEX_IMG = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "generated_images"
WRAPPER = Path(__file__).resolve().parent.parent / "templates" / "image_runner_wrapper.txt"
MANIFEST = OUTDIR / "assets" / "images" / "manifest.jsonl"

_lock = threading.Lock()
_claimed = set()


def newest_unclaimed(after_ts, folder=None):
    with _lock:
        best = None
        pattern = f"{folder}/*.png" if folder else "*/*.png"
        if CODEX_IMG.exists():
            for png in CODEX_IMG.glob(pattern):
                p = str(png)
                if p in _claimed:
                    continue
                try:
                    m = png.stat().st_mtime
                except OSError:
                    continue
                if m > after_ts and (best is None or m > best[1]):
                    best = (png, m)
        if best:
            _claimed.add(str(best[0]))
            return best[0]
        return None


def instruction(item):
    text = WRAPPER.read_text(encoding="utf-8")
    if not item.get("images"):
        text = text.replace("Attached reference image(s) are for STYLE and design guidance only; create a new original image following the prompt.\n", "")
    return (text.replace("{SIZE}", item.get("size", "1024x1536"))
                .replace("{QUALITY}", item.get("quality", "high"))
                .replace("{PROMPT}", item["prompt"]))


def thread_id(stdout):
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        for key in ("thread_id", "session_id"):
            if isinstance(ev.get(key), str):
                return ev[key]
    return None


def run_one(item):
    pid = item["id"]
    out = OUTDIR / item["output_path"]
    if out.exists():
        return (pid, "skip", 0, None)
    cmd = ["codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
           "-c", "model_reasoning_effort=low"]
    if os.environ.get("MODEL"):
        cmd += ["-m", os.environ["MODEL"]]
    for r in item.get("images", []):
        cmd += ["-i", r]
    cmd += ["--", instruction(item)]
    before = time.time() - 1
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT, text=True)
    except subprocess.TimeoutExpired:
        return (pid, "timeout", time.time() - before, None)
    tid = thread_id(r.stdout or "")
    src = None
    deadline = time.time() + 30
    while time.time() < deadline:
        src = newest_unclaimed(before, tid) if tid else newest_unclaimed(before)
        if src:
            break
        time.sleep(1)
    if not src:
        return (pid, "rejected/no-image " + (r.stderr or "")[-300:], time.time() - before, None)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(out))
    row = {"id": pid, "file": item["output_path"], "content_checked": False, "race_fallback": tid is None,
           "codex_thread": tid, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    return (pid, "ok", time.time() - before, row)


def main():
    items = [json.loads(l) for l in PROMPTS.read_text(encoding="utf-8").splitlines() if l.strip()]
    items = [it for it in items if not (OUTDIR / it["output_path"]).exists()]
    print(f"[spawn] todo={len(items)} parallel={PARALLEL}", flush=True)
    ok = fail = 0
    t0 = time.time()
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futs = {ex.submit(run_one, it): it["id"] for it in items}
        for f in as_completed(futs):
            pid, status, el, row = f.result()
            if status == "ok":
                ok += 1
                with _lock, MANIFEST.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(f"[ok] {pid} ({el:.0f}s){' race-fallback' if row['race_fallback'] else ''}", flush=True)
            elif status != "skip":
                fail += 1
                print(f"[fail] {pid} ({el:.0f}s) {status}", flush=True)
    print(f"=== done: {ok} ok / {fail} fail / {(time.time() - t0) / 60:.1f}min — 다음: 내용 대조 후 manifest content_checked=true ===", flush=True)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
