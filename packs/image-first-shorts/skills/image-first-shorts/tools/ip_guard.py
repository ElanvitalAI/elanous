#!/usr/bin/env python3
# 새로 씀(image-first-shorts) — 장치 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트의 «IP 단어 0건 검사»
#   (https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 생성 프롬프트(이미지·영상)와 노래 가사에 금지어(작품명·캐릭터명·고유 지명 등)가 «0건»인지 검사한다.
# 자막·VO 는 검사 밖(키트 원칙: IP 단어는 자막·VO 에서만).
# 사용: python3 ip_guard.py --blocklist words.txt jobs/images.jsonl jobs/video.jsonl [music_plan.json ...]
#   words.txt = 줄당 금지어(대소문자 무시, 공백·하이픈 차이 무시). exit 0 = 0건, 1 = 걸림(위치 출력), 2 = 사용법 오류
import argparse, json, re, sys


def squash(s):
    return re.sub(r"[\s\-_·.]+", "", s.lower())


def texts(path):
    if path.endswith(".jsonl"):
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            if line.strip():
                row = json.loads(line)
                for k in ("prompt", "text", "lyrics"):
                    if isinstance(row.get(k), str):
                        yield f"{path}:{n}:{k}", row[k]
    else:
        def walk(node, at):
            if isinstance(node, dict):
                for k, v in node.items():
                    yield from walk(v, f"{at}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    yield from walk(v, f"{at}[{i}]")
            elif isinstance(node, str):
                yield at, node
        yield from walk(json.load(open(path, encoding="utf-8")), path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocklist", required=True); ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    words = [w.strip() for w in open(a.blocklist, encoding="utf-8") if w.strip() and not w.startswith("#")]
    if not words:
        print("blocklist 가 비었다 — 원작 캐릭터라면 그래프 입력 ip_blocklist_none=true 로 «명시»하라", file=sys.stderr)
        return 2
    hits = []
    for f in a.files:
        for where, text in texts(f):
            flat = squash(text)
            hits += [{"at": where, "word": w} for w in words if squash(w) and squash(w) in flat]
    print(json.dumps({"checked_words": len(words), "hits": hits}, ensure_ascii=False))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
