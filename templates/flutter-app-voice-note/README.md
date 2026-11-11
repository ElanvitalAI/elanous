# 음성 노트 Flutter 템플릿

녹음 중 사진과 동영상을 타임라인에 추가하고, 녹음·첨부 파일을 회원 앱 저장소에 올린 뒤
회원 세션으로 `POST /v1/scraps`에 제출합니다. 스크랩 응답의 요약 카드와 최근 음성 노트를
화면에 표시합니다.

## 실행

저장소 루트에서:

```sh
cd templates/flutter-app-voice-note
flutter pub get
flutter analyze
flutter test
flutter run
```

앱은 `elanous_nexus` Dart SDK의 회원 로그인·보안 세션을 사용합니다. 앱에는 provider/API
자격 증명을 넣지 않습니다. 녹음과 첨부 미디어는 앱 전용 `scraps/` 저장소 키로 업로드되고,
스크랩 요청에는 owner 토큰만 전달됩니다. 소유자 ID는 요청 본문에 넣지 않습니다.
Android/iOS 프로젝트에는 마이크·사진 보관함 설명과 `elanous://` 로그인 콜백 등록이 포함됩니다.
배포 전에 Android `applicationId`와 iOS bundle identifier를 앱별 값으로 바꾸세요.
Android release 배포 전에는 앱 전용 JKS/keystore와 다음 환경변수를 설정하세요:
`ELANOUS_ANDROID_KEYSTORE_PATH`, `ELANOUS_ANDROID_KEYSTORE_PASSWORD`,
`ELANOUS_ANDROID_KEY_ALIAS`, `ELANOUS_ANDROID_KEY_PASSWORD`. Release task는 설정이 빠졌거나
keystore가 없으면 명확한 오류로 중단됩니다. 템플릿은 debug 키로 release APK를 서명하지 않습니다.

타임라인은 녹음 시작 이후 사진·동영상 선택 시각을 밀리초로 기록합니다. `POST /v1/scraps`의
`raw.timeline`은 녹음 항목과 미디어 참조를 담으며, 비어 있으면 필드를 생략해 기존 voice scrap
계약을 유지합니다. 각 파일은 10 MiB 이하이고 초안 전체는 20 MiB 이하로 제한해 모바일 메모리 사용을
묶습니다. 상한을 넘는 첨부는 제거한 뒤 다시 제출할 수 있습니다.

`out/index.html`은 정적 앱 호스트의 진입점입니다. Flutter 화면은 Android/iOS 앱으로 실행합니다.
