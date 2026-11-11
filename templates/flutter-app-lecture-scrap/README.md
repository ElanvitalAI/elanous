# 강의 노트 · 스크랩 (Flutter)

`app.yaml`은 `templates/next-app-lecture-scrap/app.yaml`과 같은 계약이다. 앱은
`listScraps`, `searchLibrary`, `addLectureNote` 이름을 그대로 호출한다. 공급자 자격은
APK에 넣지 않는다. 앱 세션은 Android 보안 저장소에 보관한다.

## Android APK

저장소 루트에서:

```sh
cd templates/flutter-app-lecture-scrap
flutter pub get
flutter build apk --debug
```

결과는 `build/app/outputs/flutter-apk/app-debug.apk` 한 개다. 실행 후
`https://lecture-scrap--<user>.elanous.app` 주소와 발급된 앱 세션 토큰을 입력한다.
owner 토큰은 회원 API가 확인한 `appSlug`와 `userSlug`에 해당하는 이 주소로만
전달한다. 로컬 개발 호스트는 기본 거부되며, 개발자가 직접 실행할 때만
`--dart-define=NEXUS_ALLOW_LOCAL_APP_ORIGIN=true`로 허용할 수 있다.
`owner: nexus-session` 역할은 share-link 초대 경로로 발급되지 않는다.
노트 저장의 실물 왕복은 넥서스 모바일 owner 세션 교환 경로가 준비된 뒤
확인해야 한다. SDK는 owner 앱 세션을 `Authorization: Bearer`로 같은 RPC 경로에 보내고,
기존 초대 세션 쿠키 경로도 별도로 유지한다.
`out/index.html`은 넥서스 정적 호스트가 요구하는 최소 진입 파일이며,
Flutter 화면과 기능을 대신하지 않는다.

Android release APK/AAB는 `ELANOUS_ANDROID_KEYSTORE`,
`ELANOUS_ANDROID_KEYSTORE_PASSWORD`, `ELANOUS_ANDROID_KEY_ALIAS`,
`ELANOUS_ANDROID_KEY_PASSWORD`가 모두 설정된 경우에만 서명한다. 디버그 키는
release 빌드에 사용하지 않는다.
