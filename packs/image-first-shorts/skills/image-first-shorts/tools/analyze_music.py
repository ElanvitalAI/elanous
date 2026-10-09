#!/usr/bin/env python3
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 원본: 키트 tools/04_audio/_work/analyze.py (librosa BPM·비트·RMS·저역 에너지) — 콘솔 출력을 JSON(beats.json 꼴)으로 바꾸고
#   «드롭 후보»(저역 에너지가 직전 2초 평균의 DROP_RATIO 배 이상으로 뛰는 첫 지점)·«점수»를 새로 더했다.
# 사용: python3 analyze_music.py <target_bpm> <곡1> [곡2 ...] > candidates.json
#   점수 = BPM 근접(목표와의 차, 배·반배 허용) + 드롭이 원하는 창(DROP_MIN~DROP_MAX 초) 안에 있나. 고르는 건 사람/에이전트 — 이 값은 «정렬 근거»다.
import json, os, sys
import numpy as np, librosa

DROP_RATIO = float(os.environ.get("DROP_RATIO", "1.8"))
DROP_MIN, DROP_MAX = float(os.environ.get("DROP_MIN", "4")), float(os.environ.get("DROP_MAX", "12"))


def analyze(path, target):
    y, sr = librosa.load(path, sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=target, units="time")
    hop = int(sr * 0.25)
    S = np.abs(librosa.stft(y, hop_length=hop))
    f = librosa.fft_frequencies(sr=sr)
    low = S[f < 150].mean(0)
    rms = librosa.feature.rms(y=y, hop_length=hop, frame_length=hop)[0]
    drop = None
    for i in range(8, len(low)):
        base = low[i - 8:i].mean()
        if base > 0 and low[i] / base >= DROP_RATIO:
            drop = round(i * 0.25, 2)
            break
    bpm = float(np.atleast_1d(tempo)[0])
    near = min(abs(bpm - target), abs(bpm * 2 - target), abs(bpm / 2 - target))
    score = max(0.0, 1 - near / 10) + (1.0 if drop is not None and DROP_MIN <= drop <= DROP_MAX else 0.0)
    return {"file": path, "duration_s": round(len(y) / sr, 2), "bpm": round(bpm, 1), "drop_s": drop,
            "beats_s": [round(float(b), 3) for b in beats], "rms_q": [round(float(x), 4) for x in rms],
            "score": round(score, 3)}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: analyze_music.py <target_bpm> <audio...>")
    target = float(sys.argv[1])
    rows = sorted((analyze(p, target) for p in sys.argv[2:]), key=lambda r: -r["score"])
    print(json.dumps({"target_bpm": target, "candidates": rows}, ensure_ascii=False, indent=1))
