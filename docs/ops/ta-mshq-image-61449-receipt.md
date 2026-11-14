# OP61449/61482 · 0.3.24 TA 이미지 갱신 후 단일 실발사 관측 · RES

상태: 격리 Linux Pod 읽기 전용 관측 영수증. 단일 실발사·빈 장치 설치·실회원·데모 정상완료를 주장하지 않는다.
범위: 요구된 `uname`, `bun --version`, `elanous --version`, `git rev-parse HEAD`와, 설치 런타임 commit / checkout source commit 분리를 위한 읽기 전용 조회.
하지 않은 것: 환경 변수·설정·자격 값의 읽기/출력, 화면 수집, 네트워크 서비스, 다른 호스트 작업, 원본 PR(#37298/#37065) 변경, 자동 병합.
PR: host 검증을 기다린다. 이 문서는 그 검증을 대신하지 않는다.

관측 시각: 미확정(이 Pod에서 시계를 별도 명령으로 읽지 않음).

## 명령 기록

실행된 행만 그 프로세스의 exit와 stdout이다. `elanous --version` 행은 프로세스가 기동되지 않았다.

| 명령 | exit | stdout | stderr |
| --- | --- | --- | --- |
| `uname` | 0 | `Linux` | (비어 있음) |
| `bun --version` | 0 | `1.4.2` | (비어 있음) |
| `elanous --version` | 미실행 | 미확정 | 격리 경계가 명령 `elanous`를 실행 전에 거부. 프로세스 exit 없음 |
| `git rev-parse HEAD` | 0 | `3f846a43450e9e1e492ce6fa973a610dbbe4bc63` | (비어 있음) |

`elanous --version` 거부 문구(가드 stderr, 값 없음): `인식하지 못한 명령 elanous`.

## 설치 런타임과 checkout source 분리

둘은 같은 커밋이 아니다. 설치본 `--version` 프로세스는 실행하지 못했다. 아래 설치 런타임 칸은 그 프로세스가 읽는 파일을 읽기 전용으로 연 결과이고, `--version` stdout이 아니다.

| 구분 | 관측 | 근거 명령 | exit | stdout |
| --- | --- | --- | --- | --- |
| 설치 런타임 위치 | PATH의 `elanous`는 래퍼 | `type elanous` | 0 | `elanous is /home/ubuntu/.local/share/elanous/bin/elanous` |
| 설치 런타임 실경로 | `current` → `versions/0.3.17-dev.0` | `readlink -f /home/ubuntu/.local/share/elanous/current` | 0 | `/home/ubuntu/.local/share/elanous/versions/0.3.17-dev.0` |
| 설치 런타임 package version | `0.3.17-dev.0` | `jq -r .version /home/ubuntu/.local/share/elanous/current/node_modules/elanous/package.json` | 0 | `0.3.17-dev.0` |
| 설치 런타임 packed commit | `2b233c5f7783777604929844c07e35a355d5383e` | `jq -c . /home/ubuntu/.local/share/elanous/current/node_modules/elanous/src/version/packed-revision.json` | 0 | `{"commit":"2b233c5f7783777604929844c07e35a355d5383e"}` |
| 설치 런타임 `--version` 프로세스 | 미실행 | 래퍼가 exec하는 `bun <설치본 elanous.mjs> --version` | 미실행 | 격리 경계가 worktree 밖 경로 실행을 거부. stdout 미확정 |
| checkout source HEAD | `3f846a43450e9e1e492ce6fa973a610dbbe4bc63` | `git rev-parse HEAD` | 0 | `3f846a43450e9e1e492ce6fa973a610dbbe4bc63` |
| checkout source CLI | `0.3.22 3f846a43450e9e1e492ce6fa973a610dbbe4bc63` | `bun bin/elanous.mjs --version` | 0 | `0.3.22 3f846a43450e9e1e492ce6fa973a610dbbe4bc63` |

checkout `package.json`의 `version` 필드는 `0.3.22`다(`git show HEAD:package.json`로 확인, exit 0). 이것은 설치 런타임 `0.3.17-dev.0`과 다르다.

설치 래퍼 파일(`/home/ubuntu/.local/share/elanous/bin/elanous`, `head` exit 0)은 bun 실행 파일과 설치본 `elanous.mjs`를 exec한다. 그 파일 본문에 버전 문자열이나 커밋은 없다. 자격·환경 변수 값은 이 문서에 적지 않는다.

## 미확정

- 이 Pod의 PATH `elanous --version` stdout/exit. 명령이 기동되지 않았다.
- 설치본 `0.3.17-dev.0` / commit `2b233c5f7783777604929844c07e35a355d5383e`가 그 프로세스의 `--version` 한 줄과 같은지. 파일은 읽었고 프로세스는 실행하지 못했다.
- 0.3.24 TA 이미지 갱신이 이 Pod의 설치 런타임에 반영됐는지. 관측된 설치 버전은 `0.3.17-dev.0`이고, 0.3.24라는 문자열은 이 관측에서 나오지 않았다.
- 단일 실발사, 빈 장치 설치, 실회원, 데모 정상완료, host 검증, PR 병합 가능 여부.

## 재현

worktree: `/home/ubuntu/.elanous/worktrees/opt-1ff66233/elanous-source.worktrees/self-impl-docs-ops-ta-mshq-image-61449-receipt-md-4c18e6da-rd1de43`

```
uname
bun --version
elanous --version
git rev-parse HEAD
bun bin/elanous.mjs --version
type elanous
readlink -f /home/ubuntu/.local/share/elanous/current
jq -r .version /home/ubuntu/.local/share/elanous/current/node_modules/elanous/package.json
jq -c . /home/ubuntu/.local/share/elanous/current/node_modules/elanous/src/version/packed-revision.json
```

존재 확인: `test -f docs/ops/ta-mshq-image-61449-receipt.md`
