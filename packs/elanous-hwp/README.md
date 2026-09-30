# elanous-hwp

**S** — 한국 업무 보고서는 HWP/HWPX 양식으로 제출된다. **C** — Markdown 보고서만으로는 그 결과를 전달할 수 없다. **Q** — (C와 같은 물음이므로 비움). **A** — `hwp-read` · `hwp-write` · `hwp-fill` 스킬과 `hwp:to-md` · `hwp:from-md` 선언형 워크플로 노드. 무료 · official · Productivity 팩이다.

## 실행

Python 3 표준 라이브러리만으로 HWPX 읽기·쓰기·채우기를 수행한다. elanous venv에서 Python을 사용한다. 레거시 **HWP 5.0** 입력만 사용자 환경의 선택 의존성 `pyhwp` (`hwp5txt`)가 필요하다. 설치가 필요한 경우 해당 환경에서 `python -m pip install pyhwp`를 실행한다. 이 팩은 다른 후보의 코드를 번들하지 않는다. 후보별 라이선스 검증 결과는 [NOTICE.md](NOTICE.md) 참조.

```sh
python packs/elanous-hwp/scripts/hwp.py write sample.md --template report -o out.hwpx
python packs/elanous-hwp/scripts/hwp.py read out.hwpx
python packs/elanous-hwp/scripts/hwp.py fill form.hwpx --fields fields.json -o filled.hwpx
```

`sample.md` 예: `# 기업 직무훈련 보고서` 다음에 근거를 확인한 NCS 코드와 `| NCS 코드 | 역량 |` 표를 쓴다. `fields.json` 예: `{"이름":"홍길동","기관":"기업명"}`. `official-letter`는 공문 글꼴·여백을 사용한다. 모든 명령은 성공 시 `{"ok":true,...}`, 실패 시 `{"ok":false,"error":"..."}` 한 줄을 표준 출력으로 내보낸다. `write`/`fill` 출력은 `.hwpx`; `.hwp` 작성은 지원하지 않는다. 출력 경로는 기존 양식 파일과 달라야 하고 이미 존재하는 파일을 덮어쓸 수 없다.

`templates/report.yaml` · `templates/official-letter.yaml`은 JSON 문법의 YAML(파이썬 표준 라이브러리에서 그대로 파싱)이며 글꼴, 크기, 여백, 표 헤더·테두리 설정을 기록한다. HWPX는 ZIP이며 `Contents/section0.xml`과 `Contents/header.xml`을 담는다. 읽기는 제목·문단·GFM 표를 반환한다. 표 채우기는 기존 XML의 다른 run/스타일 및 ZIP 멤버를 유지한다. **페이지 검사 한계:** 출력 전후 XML의 명시적 pageBreak 개수만 비교한다. 내용에 따른 실제 렌더링 페이지 수는 레이아웃 엔진이 없으므로 확인할 수 없으며 한글/LibreOffice에서 육안 확인해야 한다. 생성 문서는 별도 OPF 소비자(`test/consumer.py`)로 컨테이너·manifest·spine을 순서대로 따라가 본문과 표 셀을 검증한다. 선택적 python-hwpx 외부 소비자 검사(`ELANOUS_HWP_VERIFY_PYTHON_HWPX=1 bun test packs/elanous-hwp/test/hwp.test.ts`, 사용자 환경에 `python-hwpx` 설치 필요)도 본문과 표를 연다. 실제 한글 앱과의 시각적 호환성과 페이지 수는 검증하지 못했다.

## 검증

`bun test packs/elanous-hwp/test/hwp.test.ts`는 두 표 왕복, 이스케이프한 `\|` 및 역슬래시가 든 표의 read → write 왕복, 글꼴, 양식 치환·원본 불변·명시 페이지 수, 선택 의존성 미설치 오류를 시험한다. 별도 `test/consumer.py`가 생성 파일의 manifest 경로를 상대 위치로 해석해 본문과 표 칸·표 개수를 검사한다. 최초 파일과 왕복 파일의 표 개수도 비교하여 표 행이 별도 표로 분리되는 손실을 검출한다. 라이브러리 독립 검사 결과 재현: 사용자 환경의 `python-hwpx`를 설치하고 위 환경변수로 시험한다. 이전 외부 소비자 검증은 두 표 Markdown을 `write`한 출력에 대해 `uv run --no-project --with python-hwpx python packs/elanous-hwp/test/verify-python-hwpx.py <out.hwpx>`로 별도로 재현할 수 있다.
