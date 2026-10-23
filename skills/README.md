# `skills/` — 이 저장소가 «정본»으로 갖는 스킬

## ⛔ 왜 이 디렉터리가 있나

스킬은 `elanous config get skills.dirs` 가 가리키는 곳(**`~/.claude/skills`**)에서만 읽힌다.
⇒ 거기에만 쓰면 ***저장소에 없어서 착지도 리뷰도 인계도 안 된다***.
📏 2026-08-28 실측: 이 저장소에 `SKILL.md` 가 **0건**이었다(스킬을 여럿 써 왔는데도).

⇒ 그래서 **정본은 여기**, 읽히는 자리는 **심링크**로 잇는다(`~/.claude/skills/` 의 higgsfield 묶음이
이미 쓰던 관행이다).

## 🔧 새 기계에서 거는 법 — ⛔ 이제 «도구»가 한다

```bash
bash scripts/link-repo-skills.sh <이름>          # 그 하나만 잇는다(멱등)
bash scripts/link-repo-skills.sh --all           # 전부 — ⛔ «운영 변경»이라 명시해야 한다
bash scripts/link-repo-skills.sh --check [이름]  # 걸지 않고 «지금 닿나»만 잰다 — 안 닿으면 exit 1
```

> ### ⛔⭐ 왜 한 줄짜리 `ln` 을 도구로 바꿨나 (2026-09-22 · 4차 리뷰 ①)
> 손으로 건 심링크는 ***내 기계에만*** 있다. PR 은 `skills/video-builder/SKILL.md` 를 담고
> 「슬래시를 배선했다」고 적었지만, 새로 체크아웃한 기계에서는 그 슬래시가 **아예 없었다**.
> ⇒ ***「저장소에 있다」와 「부를 수 있다」는 다른 값이다***([`ASK-installed-and-usable-right-now-are-different-values`](../내부 문서 `ASK-installed-and-usable-right-now-are-different-values-2026-09-22`)).
>
> ⛔ 이 자가 묻는 것은 ***「그 이름이 로더에 닿나」*** 이지 「이 체크아웃을 가리키나」가 **아니다**.
> 📏 1판은 뒤쪽을 물어 11개 중 **11개를 ⛔ 로 찍었다** — 실제로는 전부 닿고 있었다(다른 클론이
> 이미 그 이름을 쥐고 있었다). ⇒ **남이 세워 둔 정본은 돌려놓지 않는다**(운영 설정 변경은 사람 몫).
>
> 옛 한 줄이 필요하면: `ln -sfn "$(pwd)/skills/<이름>" ~/.claude/skills/<이름>`

## 📏 걸고 나면 «닿는지»를 잰다 — ⛔ 「만들었다」는 「닿는다」가 아니다

```bash
# 인덱스에 들어갔나 · 트리거가 «갈라» 잡혔나 · 라우터가 가리키나
bun -e '
  const {getSkillIndex}=await import("./src/skills/index.js");
  const {detectSkillTrigger}=await import("./src/skills/router.js");
  const i=getSkillIndex(); const e=i.find(x=>x.name===process.argv[1]);
  console.log(e?`명시 ${e.triggers.length} · 추출 ${e.extractedTriggers.length} · source=${e.triggerSource}`:"⛔ 인덱스에 없다");
  const t=detectSkillTrigger(process.argv[2]??"",i);
  console.log(t.top ? `${t.top.name} · score ${t.top.score} · unambiguous=${t.unambiguous}` : "(라우팅 없음)");
' <이름> "<시험 문장>"
```

> ### 🪞⛔⭐⭐ **이 검사 «자체»가 거짓말하고 있었다** (2026-08-29 · 36차가 그대로 밟아서 찾음)
> 옛 줄은 `detectSkillTrigger(...).top?.***skill***?.name` 을 읽었다. **그 필드는 «없다»** —
> 후보의 실제 꼴은 `{ name, score, matchedTriggers, … }` 다.
> ⇒ 🚨 ***라우팅이 «되고 있는데» 언제나 「(라우팅 없음)」으로 나왔다.***
> 📏 실측: `grill me on this plan` ⇒ 옛 명령 「(라우팅 없음)」 · 새 명령 `grill-me · score 1.3 · unambiguous=true`.
> ⛔ **빨간 길도 밟았다**: 안 무는 문장(`오늘 날씨가 좋네요`)은 새 명령에서도 「(라우팅 없음)」이다.
>
> 🔑 ⇒ ***「닿나」를 재는 명령이 「안 닿는다」로 «고정»돼 있으면, 그 검사는 아무것도 안 잰다.***
> 그 줄을 쓴 창은 그것을 「이 스킬은 사람이 부르는 것이라 안 잡히나 보다」로 읽고 넘어갈 수 있었다.

⛔ **트리거는 «두 칸»이다** — `triggers`(명시·이름 파생) ⊕ `extractedTriggers`(description 에서 추출).
앞 칸만 보면 「트리거가 2개뿐」으로 «잘못» 읽는다(2026-08-28 에 실제로 그렇게 읽었다).

⛔ **추출은 «인식된 마커»가 있는 문장에서만 된다**(`src/skills/trigger-extract.ts`).
`트리거 —` 같은 제 맘대로 꼴은 **한 개도 안 뽑힌다**. 무는 꼴 둘:
- 한국어(뒤로): `"A", "B", "C" 등의 언급 시 이 스킬 사용.`
- 영어(앞으로): `Use when the user wants to: A, B, C.` · `Trigger on: A, B, C.`

## 📚 지금 있는 것

| 스킬 | 무엇 | 모델이 스스로 부르나 |
|---|---|---|
| [`grill-me`](grill-me/SKILL.md) | 계획·설계를 공감대에 이를 때까지 인터뷰 | ⛔ 아니다(`disable-model-invocation`) — 사람이 부른다 |
| [`video-builder`](video-builder/SKILL.md) | 영상 파이프라인을 «능력·구현·구간»으로 조립 — 추천 스택·크레딧·구멍 | ⛔ 아니다(`autoTrigger` 미선언) — 슬래시로 «먼저» 연다 |
| [`floorplan-to-film`](floorplan-to-film/SKILL.md) | 평면도(PDF·이미지·치수) → 2D 수정 도면 → Blender 3D 투시도(Higgsfield Bridge MCP · 미연결 대안 cli-anything-blender) → 워크스루 영상 — 조립·자막·BGM 은 video-builder | O — `autoTrigger` 선언(«평면도로 3D»·«인테리어 영상» 명시 트리거 · 점수 2.0↑ 일 때 자동, 그 전엔 제안) |

---

# 📦 2026-09-17 — 기본 스킬셋 아홉을 «여기로» 들였다

> 대표 결정 2026-09-17. 계기 = 🅣 실측(`#18750`): ***새 기계가 기본 아홉을 «얻는» 길이 없다.***
> ⭐ 이 절은 위 정책(***정본은 여기 · 읽히는 자리는 심링크***)을 **바꾸지 않는다** — 그 정책을 **아홉에 적용한 것**이다.

## 🔑 왜 지금이었나 — 「카탈로그를 어디로 가리키나」의 답이 «없었다»

📏 2026-09-17 실측 — 그 아홉이 «어디 사나»:

```
origin remote 가 있는 스킬        0 / 9      ← ⛔ 가리킬 «상류»가 «없다»
.env · *.key 를 가진 스킬         6 / 9      ← 그대로 공유하면 «샌다»
```
⇒ *"저장소인가·레지스트리인가·사내경로인가"* 는 ***답이 셋 다 아니었다.*** 그래서 **가리킬 곳을 먼저 만든다.**

## 📦 무엇을 들였나 (⛔ 뺀 것)

```
node_modules/     빌드 산출 · 재설치 가능
.git/             각 스킬의 «원격 없는» 로컬 히스토리
data/  *.db       수집 «데이터»이지 스킬이 아니다 (예: apify-x-asset-sentiment/data/x_asset.db)
.env  .env.*      ⛔ 비밀          *.key  *.pem   ⛔ 비밀
*.lock            자격 락(예: kr-flow/.kis_token.lock)
__pycache__/*.pyc  .DS_Store       ← .gitignore 가 이미 뺀다(22개)
```

## ⛔ 비밀은 여기 «없다» — 그리고 그것을 «쟀다»

```
이 판이 «더한» 파일        180        (git diff --diff-filter=A origin/main...HEAD -- skills/)
이 판이 «고친» 파일          1        (skills/README.md — 이 절을 덧붙였다)
skills/ 전체 (HEAD 기준)   182        (= 이전 2 + 더한 180)
비밀형 매치                  0
.env / *.key / *.db / *.lock 0
```
⛔ **수를 «한 기준»으로만 적는다** — 앞 판에서 181·182 가 갈렸다. 위 셋은 서로 다른 것을 세고, 명령이 그것을 말한다.

📏 재는 명령 (⛔ 값은 찍지 않는다 — 이름·개수만):
```bash
# ⑴ 금지 확장자 — ⛔ 숨김 파일도 본다
find skills \( -name '.env*' -o -name '*.key' -o -name '*.pem' -o -name '*.db' -o -name '*.lock' \) | wc -l

# ⑵ 비밀형 문자열 — ⛔ --hidden 이 «있어야» .env 류를 본다 · head 로 «자르지 않는다»
rg -c --hidden --no-ignore -g '!node_modules' \
  'sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|fc-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|apify_api_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}' \
  skills/

# ⑶ tvly- 는 «따로» 센다. ⛔ 함정이 «넷» 있다:
#    ⓐ rg 는 look-ahead 를 «지원하지 않는다» ⇒ tvly-(?!YOUR) 는 파싱 오류다
#    ⓑ `rg -o` 를 «그냥» 쓰면 매치 문자열이 화면에 찍힌다 ⇒ 값이 «샌다»
#    ⓒ 「자리표시자가 있는 파일을 건너뛰기」도 틀렸다 — 같은 «파일»에 섞이면 진짜를 놓친다
#    ⓓ ⭐ `rg -c` 는 «줄 수»다 — 같은 «줄»에 자리표시자와 진짜가 섞이면 그것도 놓친다
#    ⇒ ✅ `rg -o` 를 «wc -l 로 파이프»한다 — 매치 «개수»를 세고 값은 화면에 «안 온다».
#       ⊕ 자기 참조도 정규식이 처리한다(README 의 `'tvly-'` 는 뒤에 글자가 없어 안 잡히고,
#         `tvly-YOUR_API_KEY` 는 자리표시자 쪽에서 상계된다)
total=$(rg -o --hidden --no-ignore 'tvly-[A-Za-z0-9_]+' skills/ | wc -l)
ph=$(rg -o --hidden --no-ignore 'tvly-YOUR[A-Za-z0-9_]*' skills/ | wc -l)
if [ "$total" -gt "$ph" ]; then echo "⛔ 자리표시자 아닌 tvly- $(( total - ph ))건 — 파일을 찾으려면 rg -l 로"; else echo "✅ 0"; fi
```
⛔ **`head` 를 붙이지 마라** — 매치를 자르면 「0건」이 「안 봤다」가 된다.

⚠️ 스캔에 걸렸다가 «안전»으로 판정된 것 여섯 — 값을 가리고 확인했다:
```
score_psd_event_collections.py    key = score…              ← 파이썬 «변수» 대입
omni-crawl/specs/tavily/*.md ×5   api_key = tvly-YOUR_API_KEY ← Tavily 문서의 «자리표시자»
```

## ⚠️ 이 사본은 «환경 의존»을 그대로 갖고 있다 — 비밀은 아니지만 남의 기계에선 안 돈다

📏 실측(2026-09-17 · 이름·개수만 · 값 안 찍음):
```
/Users/user 절대경로가 든 파일     27      (⛔ 이 README 를 «빼고» — 아래 명령이 그렇게 센다)
개인 호스트명(ts.net·tailscale)이 든 파일  7      (같음)
과거 프리셋 백업 (*.bak)               16
launchd plist                          1   (com.user.… 크론)
```
⛔ **익명화하지 «않았다»** — 원본을 그대로 보존하는 것이 이 판의 결정이다(고치면 원본과 갈라진다).
⇒ 그러므로 ***새 기계에서 받으면 경로·호스트·크론을 «손으로» 맞춰야 한다.***
📏 재는 명령:
```bash
# ⛔ 이 README 자신이 그 문자열을 «설명으로» 담고 있다 ⇒ 자기 참조를 뺀다. 안 빼면 수가 하나씩 늘어난다.
rg -l --hidden --no-ignore '/Users/user' skills/ | grep -v '^skills/README.md$' | wc -l
rg -l --hidden --no-ignore 'ts\.net|tailscale' skills/ | grep -v '^skills/README.md$' | wc -l
find skills -name '*.bak' | wc -l
find skills -name '*.plist'
```
📌 `*.bak` 열여섯은 ***프리셋의 과거 판***이다(`battery.json.v3.4-pre-dart.bak` 꼴).
   ⛔ 「현행 프리셋」과 헷갈리지 마라 — 현행은 확장자가 `.json` 이다. 보존한 이유는 «원본 그대로»이고, 버릴지는 별도 판단이다.

## 🛡️ 다음 갱신을 위한 방어선
`skills/.gitignore` 가 **위 제외 규칙을 파일로** 갖는다 — 다음에 사본을 갱신할 때 자격 파일이 실수로 딸려 오지 않게.
⛔ **각 스킬의 `.gitignore` 는 «안 고친다»** — 사본을 건드리면 원본과 갈라지고, 그 갈라짐을 막는 장치가 아직 없다.

## 🚀 새 기계에서 받는 법
```bash
bun bin/elanous.mjs self provision skill <이름> --source <이 저장소>/skills/<이름> --apply
```
⚠️ **키는 따로** — 이 사본엔 `.env` 가 없다.
⛔ **그리고 「`elanous config` 로 넣으면 된다」는 «스킬마다 다르다»** — 스킬이 그 경로를 «읽어야» 먹는다.
   📏 실측: `apify-x-asset-sentiment/scripts/daily_dense_run.py` 는 `APIFY_TOKEN` 을 ***환경변수에서만*** 읽는다.
   ⇒ 그 스킬은 **환경변수로** 줘야 한다. ***「config 로 넣어라」를 전 스킬에 일반화하지 마라.***
   📏 재는 법: `rg -n "os.environ|getenv|process.env" skills/<이름>/` 로 «그 스킬이 무엇을 읽나»를 본다.
⛔ 그리고 **launchd 데몬은 보조 키를 안 나른다**(대표 결정 ⓑ · 2026-09-17).
   ⚠️ **그런데 「config 로 옮기면 된다」는 «config 를 실제로 읽는 스킬»에만 해당한다** —
   바로 위에 적은 대로 환경변수«만» 읽는 스킬이 있고, 그 스킬은 config 로 옮겨도 «못 본다».
   ⇒ 데몬에서 쓰려면 ***그 스킬이 무엇을 읽나를 먼저 재고***(위 `rg -n "os.environ|getenv|process.env"`),
     env 만 읽는 스킬이면 ***그 스킬 쪽을 고쳐야*** 한다. 이 README 가 그 수리를 «했다고 말하지 않는다».

## ⚠️ 아직 «안 한 것» — 심링크로 안 이었다
위 정책은 「정본은 여기 · 읽히는 자리는 심링크」인데, 이 아홉은 ***아직 `~/.claude/skills/` 의 실제 디렉토리***다.
⇒ 그 둘이 «갈라지는 것»을 막는 장치가 없다. 그것이 다음 판이다.
📏 갈렸는지 재는 법: `diff -rq ~/.claude/skills/<이름> skills/<이름>`(위 제외 목록은 빼고 본다)
