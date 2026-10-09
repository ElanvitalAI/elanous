#!/usr/bin/env python3
# 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건
# 변경: 없음(키트 templates/fill.py 그대로). 사용법은 아래 docstring.
"""템플릿 채우기. 외부 호출 없음.
  python3 fill.py text  <template.txt> <vars.json>   # image / flow / tts : 빈 값 블록은 건너뛰고 공백 1칸으로 이음
  python3 fill.py music <music_plan_template.json> <vars.json>
  python3 fill.py tts   <tts_request_template.json> <vars.json>
"""
import json, re, sys

TOKEN = re.compile(r"\{([A-Z_]+)\}")


def fill_text(template, v):
    # 템플릿 = 공백으로 나뉜 {BLOCK} 토큰 줄. 빈 블록은 빠짐(여분 공백 안 생김)
    out = []
    for tok in template.strip().split(" "):
        m = TOKEN.fullmatch(tok)
        if m:
            val = v.get(m.group(1), "")
            if val:
                out.append(val)
        else:
            # [{TAG}] 같은 혼합 토큰
            out.append(TOKEN.sub(lambda mm: str(v.get(mm.group(1), "")), tok))
    return " ".join(out)


def _sub(node, v):
    if isinstance(node, dict):
        return {k: _sub(x, v) for k, x in node.items() if not k.startswith("_")}
    if isinstance(node, list):
        return [_sub(x, v) for x in node]
    if isinstance(node, str):
        m = TOKEN.fullmatch(node)
        if m and m.group(1) in v:
            return v[m.group(1)]  # 숫자·리스트도 그 타입 그대로
        return node
    return node


def fill_music(tpl, v):
    chunk_tpl = tpl["composition_plan"]["chunks"][0]
    out = _sub(tpl, {})
    out["composition_plan"]["chunks"] = [_sub(chunk_tpl, c) for c in v["chunks"]]
    return out


def fill_json(tpl, v):
    return _sub(tpl, v)


if __name__ == "__main__":
    kind, tpath, vpath = sys.argv[1:4]
    v = json.load(open(vpath, encoding="utf-8"))
    if kind == "text":
        sys.stdout.write(fill_text(open(tpath, encoding="utf-8").read(), v) + "\n")
    else:
        tpl = json.load(open(tpath, encoding="utf-8"))
        res = fill_music(tpl, v) if kind == "music" else fill_json(tpl, v)
        print(json.dumps(res, ensure_ascii=False, indent=1))
