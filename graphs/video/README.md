# 외부 프로젝트용 «표준» 그래프 템플릿

> 📄 설계 = [`RFC-graph-engineering-for-external-projects-2026-09-09`](../../내부 문서 `RFC-graph-engineering-for-external-projects-2026-09-09`)
> 📦 작동하는 실물 = `~/temp/agentic-consulting` (git · 워커 `scripts/graph-walk.ts`)

## ⛔ 왜 `graphs/` 가 «아니라» 여기인가

```
elanous 의 graphs/ 는 ***모듈 적재 시점에 통째로*** 실려 GRAPH_SPECS 가 된다
   (src/self-implement/graph-templates.ts:162·165 — defaultGraphsDir() 를 무조건 읽는다)
⇒ 여기 넣으면 그것이 «elanous 자신의 그래프»가 되어
   위상 검사·GRAPH_SPECS·오버레이 target 후보에 끼어들고,
   `plan-loop` 처럼 ***걸음 0인 그래프가 하나 더*** 늘어난다.
```
> ### 🔑 이 디렉토리는 ***런타임이 «안 싣는다»***. 버전 관리는 되고 실행에는 안 끼어든다.
🔎 반증 — ⛔ **찾으면 exit 1 · 없으면 exit 0** (22차 리뷰: 1판은 극성이 «뒤집혀» 있었다):
```bash
if grep -rn 'graphs/video' src/ | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'; then
  echo '⛔ 런타임(src/)이 이 디렉터리를 «참조»한다 — 위 줄을 걷어라'; exit 1
fi
```
> ⛔ **2026-09-22 정정** — 옛 문면은 주석 줄을 «안 뺐고», `src/video-pipeline/spine.ts` 의 주석이
> 이 경로를 언급하자 반증이 **항상 걸려** 무뎌졌다.
> 🔑 ***묻는 것은 「런타임이 싣나」이지 「이름이 나오나」가 아니다.***
> ✅ 🆕 2026-09-22: 선언이 «파싱되나»는 이제 도구가 답한다 — **`bun scripts/check-graph-declaration.ts <file...>`**
> (⊕ `--index` 로 오버레이용 노드 인덱스 표). ⛔ 손으로 `bun -e` 를 치는 대신 이것을 쓴다.
> ⛔ 2026-09-19 정정: 종전 문면은 `rg -n 'graph-templates' src/` 였는데 그것은 **모듈 이름**
>   (`src/self-implement/graph-templates.ts`)에도 맞아 **13건**이 나온다 — 「실린다」로 오독된다.
>   ⇒ 경로로 좁힌다. ⊕ 진짜 관문은 로더에게 «묻는» 것이다:
> ```bash
> bun -e "import {loadGraphTemplatesFrom} from './src/self-implement/graph-templates.js';
>          const r=loadGraphTemplatesFrom('graphs');
>          console.log(r.source, Object.keys(r.templates).length, (r.errors??[]).length)"
> # ⇒ yaml · 7 · 0   (builtin-fallback 이면 내 파일이 로더를 깬 것이다)
> ```

## 무엇이 있나

| 파일 | 답하는 질문 | 종단 |
|---|---|---|
| `impl-standard.yaml` | *"이 변경을 «어떻게» 만들고 착지시키나"* | `landed` · `blocked` |
| `exec-standard.yaml` | *"이 파이프라인을 «정기적으로» 어떻게 도나"* | `delivered` · `skipped` · `failed` · `unobserved` |
| 🆕 `film-production-standard.yaml` | *"편집 앱을 스크립트로 몰아 한 편을 만들고 소셜까지 어떻게 내나"* | `delivered` · `master-only` · `host-blocked` · `blocked` · `unobserved` |
| 🆕 `character-video-standard.yaml` | *"레퍼런스에서 캐릭터를 세우고, 연출된 컷을 뽑고, 편집까지 어떻게 한 루프로 도나"* | `delivered` · `rendered-unedited` · `blocked` · `unobserved` |
| 🆕 `explainer-line.yaml` | *"사실 목록으로 «N가지 한 번에» 설명 영상을 어떻게 만들어 검사까지 가나"* (스킬 `explainer-video` · 팩 `video-explainer`) | `delivered` · `needs-human` · `blocked` · `unobserved` |
| `overlays/render-patient.yaml` | 「같은 회차에서 N번 되돌아왔다」면 예산을 올린다 | — |
| 🆕 `vlog-found-footage-pipeline.declaration.yaml` | *"남이 찍어 보낸 소재에서 «이야기»를 어떻게 뽑아 납품까지 가나"* | `delivered` · `needs-human` · `blocked` · `unobserved` |
| 🆕 `video-production-pipeline.declaration.yaml` | *"영상 한 편을 «어느 갈래든» 어떻게 만들어 납품까지 가나"* | `delivered` · `needs-human` · `blocked` · `unobserved` |

> 🎬 **통합 영상 그래프**(2026-09-22)는 여섯 갈래(ad · shorts · script-film · floorplan · vlog · kinetic)를
> **한 뼈대**로 묶는다 — 노드는 같고 갈리는 것은 «능력·구현·구간» 셋이다.
> ⛔ **워커는 아직 없다**(선언까지). 📚 = [`MANUAL-unified-video-production`](../../내부 문서 `MANUAL-unified-video-production-2026-09-22`)
> 📄 설계 = [`RFC-composable-video-pipeline`](../../내부 문서 `RFC-composable-video-pipeline-2026-09-22`)
> ⚠️ 그 과정에서 **`evas-shorts-pipeline.declaration.yaml` 이 «아직도» 파싱되지 않음**을 실측했다 —
> (📏 수는 적지 않는다 — `check-graph-declaration.ts` 가 그 자리에서 찍는다)
> 그것은 걸을 그래프가 아니라 읽을 문서다. 통합 선언이 그 자리를 대신한다.

> 🎥 브이로그 그래프의 «값»은 노드가 아니라 **되돌아가는 간선**이다 — 같은 증상(검정 프레임)이라도
> 원인 노드가 다르다(`qc.blackframe → cut` · `qc.layer-missing → layers` · `qc.sheet-mismatch → storyboard`).
> 📏 걸음 검증 12 시나리오 전부 기대대로(그중 5개는 2026-09-19 에 «실제로 난» 일).
> 📚 = [`MANUAL-vlog-from-found-footage`](../../내부 문서 `MANUAL-vlog-from-found-footage-2026-09-19`)

📚 `film-production-standard` 의 절차·함정·실측 = [`MANUAL-script-driven-film-production`](../../내부 문서 `MANUAL-script-driven-film-production-2026-09-16`).
⭐ 그 그래프의 존재 이유는 **갈림 넷**이다 — 호스트(사람 앱이 안 뜬 것은 «실패»가 아니다) ·
음악(조립을 «거치지 않는다» · 20dB) · 리프레임(최대 안전줌 ≈1) · 이음매(「마스터가 났다」 ≠ 「소셜까지 났다」).
⛔⭐ 이 축의 함정은 거의 전부 **「성공을 반환하고 조용히 빈다」** 계열이라, 관문이 전부
***「돌았나」가 아니라 「값이 들어갔나」***를 잰다(`assemble-gate` 는 «잰 길이»로, `loudness` 는 «세 구간»으로).

📚 `character-video-standard` 의 절차·함정·실측 = [`MANUAL-character-to-video-pipeline`](../../내부 문서 `MANUAL-character-to-video-pipeline-2026-09-17`).
⭐ 그 그래프의 존재 이유는 **갈림 셋**이다 — 등록(`face_not_found` 는 실패가 아니라 «갈림») ·
리프레임(잉크 폭 1.00 이면 잘라선 못 키운다) · 이음매(「컷이 났다」 ≠ 「편집까지 갔다」).

⛔ **둘을 한 그래프로 합치지 않는다** — 한 런이 두 그래프를 걸으면 원장이 «한 신원»으로 적어 사후 해석이 깨진다.

## 🚶 걸어 봤나 — ⛔ 「선언이 섰다」와 «다른 값»이다 (2026-09-18 실측)

📄 `walk-templates.mjs` — 두 표준 그래프를 **시나리오 19개**로 실제로 걷는다.

```bash
bun graphs/video/walk-templates.mjs        # 워커 경로는 GRAPH_WALKER 로 덮는다
```

| 그래프 | 시나리오 | 종단 «걸어서» 닿음 | 종단 아닌 노드의 계약 미선언 |
|---|---|---|---|
| `film-production-standard` | 10 | **5/5** ✅ | 0 ✅ |
| `character-video-standard` | 9 | **4/4** ✅ | 0 ✅ |

⭐ **위상 도달과 걸음 도달은 다른 값이다.** 위상은 「엣지가 가리킨다」만 말하고,
걸음은 「그 엣지로 «실제로 갈 수 있다»」를 말한다. 아래 걸음 수가 그 증거다:

```
film   ① 정상 14걸음 · ② master-only 13 · ③ host-blocked 2 · ③b 모달 6
       ④ blocked 4 · ⑤ unobserved 14 · ⑥ 폐루프 소진 6 · ⑦ 「못 쟀다」 6
       ⑧ 조립 빈범위 소진 12 · ⑨ 전용합성 우회 15
char   ① 11 · ② face_not_found 갈림 11 · ③ rendered-unedited 11 · ④ 2
       ⑤ unobserved 9 · ⑥ 폐루프 소진 7 · ⑦ 비율 재렌더 우회 14
       ⑧ 정체성 재등록 우회 14 · ⑨ 핀 0건 소진 4
```

### 🩸 발견 ① — ***`tools` 어휘는 «닫힌 여섯»이다. 지어내면 계약 검사가 통째로 어두워진다.***

```
read-only · read-and-run · network-read · workspace-write · network-write · git-write
```

⛔ 나는 `browser-read`·`local-write`·`host-write` **셋을 지어냈고**, 워커의 `TOOL_RANK` 에 없는 값은
`undeclared` 로 떨어진다 — 그런데 **`undeclared` 는 「위반 없음」이 아니라 「계약 없음」**이다.
⇒ 첫 걸음에서 **비-종단 노드 40 + 24 걸음이 전부 계약 미선언**이었다. 즉 검사가 **하나도 안 돌았다.**
그래도 걸음은 «초록으로» 끝났다 — 이것이 그 매뉴얼들이 말하는 「성공을 반환하고 조용히 빈다」의 그래프판이다.
✅ 고친 뒤 비-종단 미선언 **0**. (종단 `judge` 노드는 하는 일이 없어 계약이 «없는 게 맞다».)

📌 **처방**: 새 그래프를 쓰면 **먼저 걸어서** `undeclared` 를 «세어» 본다. 위상 검사로는 안 잡힌다.

### 🩸 발견 ② — 워커의 `stopReason: 'unobserved'` 는 «도달 불가»다

`walkGraph` 는 걸음이 결과를 못 내면 `stopReason='unobserved'` 로 놓고 `unobservedNode` 로 «간다».
그런데 그 노드가 종단이라 **다음 걸음에서 `stopReason` 이 `'terminal'` 로 덮인다.**
⇒ `unobservedNode` 를 주면 그 값은 `maxSteps` 소진 말고는 나올 수 없다.
원인은 `terminal: 'unobserved'` 칸에 남으므로 **정보가 다 사라지진 않지만**,
선언된 네 값 중 하나가 «권장 설정에서 못 나온다». ⚠️ 워커는 🅢 소유라 채널로 알린다.

---

## 쓰는 법

```bash
cp graphs/video/*.yaml            <내 프로젝트>/graphs/
cp graphs/video/overlays/*.yaml   <내 프로젝트>/graphs/overlays/
# 워커는 ~/temp/agentic-consulting/scripts/graph-walk.ts 를 참고한다(의존 0 · 523줄)
```

⛔ **베낀 뒤 «먼저» 할 것 셋**(전부 실물에서 데인 것 · RFC §8b):
```
① max_visits 를 «감»으로 좁히지 마라 — 넉넉히 두고 관측한 뒤 조인다
② 정기 잡의 수집 «엔진을 못 박아라» — 자동 라우팅은 산출 «형식»을 회차마다 바꾼다
③ 외부 도구 계약을 «먼저 밟아라» — 없는 인자를 지어내면 그 노드가 예산만큼 헛돈다
```
