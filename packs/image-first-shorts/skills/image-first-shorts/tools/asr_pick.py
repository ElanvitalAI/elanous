#!/usr/bin/env python3
# 새로 씀(image-first-shorts) — 패턴 참고: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/)의
#   «음성인식으로 발음 테이크 거르기»(faster-whisper small · difflib 비율) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 대사 한 줄의 테이크 여러 개를 음성인식으로 받아 적고, 대본과의 유사도로 통과/탈락을 가른다.
# 사용: python3 asr_pick.py --text "대본 문장" --lang en [--must 핵심단어 ...] [--min 0.8] take1.mp3 take2.mp3
# 출력(JSON): 테이크별 전사·비율·must 포함 여부·verdict. 비언어음([sighs] 등)은 ASR 로 못 잰다 → verdict=ear_check.
# 필요: pip install faster-whisper (없으면 openai-whisper 를 시도)
import argparse, difflib, json, re, sys


def norm(s):
    return re.sub(r"[^\w]+", "", s.lower())


def transcriber(lang):
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel("small", device="cpu", compute_type="int8")
        return lambda p: " ".join(seg.text for seg in m.transcribe(p, language=lang, beam_size=5, temperature=0)[0])
    except ImportError:
        import whisper
        m = whisper.load_model("small")
        return lambda p: m.transcribe(p, language=lang, temperature=0)["text"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True); ap.add_argument("--lang", default="en")
    ap.add_argument("--must", nargs="*", default=[]); ap.add_argument("--min", type=float, default=0.8)
    ap.add_argument("takes", nargs="+")
    a = ap.parse_args()
    spoken = re.sub(r"\[[^\]]*\]", "", a.text).strip()
    if not norm(spoken):
        print(json.dumps({"verdict": "ear_check", "why": "대본이 비언어음뿐이다 — 귀로 확인"}, ensure_ascii=False)); return 0
    tr = transcriber(a.lang)
    rows = []
    for p in a.takes:
        got = tr(p)
        ratio = difflib.SequenceMatcher(None, norm(spoken), norm(got)).ratio()
        must_ok = all(norm(w) in norm(got) for w in a.must)
        rows.append({"take": p, "heard": got.strip(), "ratio": round(ratio, 3), "must_ok": must_ok,
                     "verdict": "pass" if ratio >= a.min and must_ok else "reject"})
    rows.sort(key=lambda r: (r["verdict"] != "pass", -r["ratio"]))
    print(json.dumps({"text": a.text, "takes": rows, "best": rows[0]["take"] if rows[0]["verdict"] == "pass" else None},
                     ensure_ascii=False, indent=1))
    return 0 if rows[0]["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
