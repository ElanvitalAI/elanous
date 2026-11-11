# Flutter translator app

This is a native Android/iOS client template. It uses the translator app-slot manifest from `templates/next-app-translator/app.yaml`; it does not declare or imply a Flutter web/static-export deployment. The member app slot must be provisioned from that translator contract before the client can call its RPCs and actions.

The reusable Nexus client lives at `sdk/dart/elanous_nexus`; the template references it with a relative path. Create the app under `apps/translator` in this repository so that path stays valid, then copy the template files:

```sh
mkdir -p apps
flutter create --platforms=android,ios apps/translator
cp templates/flutter-app-translator/pubspec.yaml apps/translator/
cp -R templates/flutter-app-translator/lib apps/translator/
cd apps/translator
flutter pub get
flutter run --dart-define=NEXUS_API_ORIGIN=https://api.elanous.ai
```

For a project outside this repository, also check out `sdk/dart/elanous_nexus` at the location resolved by `../../sdk/dart/elanous_nexus` from the app directory, or change the path dependency to the SDK checkout path.

The sign-in callback is exactly `elanous://auth/app-login`; register that URI with the member API allowlist.

Merge this callback activity into the generated `android/app/src/main/AndroidManifest.xml` `<application>` and add the microphone permission under `<manifest>`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
<application>
  <activity android:name="com.linusu.flutter_web_auth_2.CallbackActivity"
      android:exported="true" android:taskAffinity="">
    <intent-filter android:label="flutter_web_auth_2">
      <action android:name="android.intent.action.VIEW" />
      <category android:name="android.intent.category.DEFAULT" />
      <category android:name="android.intent.category.BROWSABLE" />
      <data android:scheme="elanous" />
    </intent-filter>
  </activity>
</application>
```

In generated `ios/Runner/Info.plist`, add the `elanous` scheme under `CFBundleURLTypes` and `NSMicrophoneUsageDescription` with a user-facing reason. Keep the generated iOS project files intact. Android minimum SDK is 23; iOS minimum deployment target is 12.

The client sends microphone WAV bytes to the member app's `transcribe` action, translates through `translate`, stores/listens to owner-scoped history through `addTranslation`/`listTranslations`, and plays generated speech through `readAloud`. Scrap save uses `/v1/scraps` with source `flutter-share`, a bearer session, and an idempotency key. It never sends a member ID. The bearer and its expiry stay in platform secure storage; callback codes, PKCE verifier, or tokens are never logged.
