import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:elanous_nexus/elanous_nexus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app_translator/main.dart' as app;
import 'package:flutter_app_translator/recording_cleanup.dart';
import 'package:flutter_app_translator/session_epoch.dart';

class _SessionVault implements TokenVault {
  final values = <String, String>{
    'nexus_owner_token': 'old-owner-token',
    'nexus_owner_token_expires_at':
        DateTime.now().toUtc().add(const Duration(hours: 1)).toIso8601String(),
    'nexus_owner_app_slug': '0123456789abcdef01234567',
    'nexus_owner_user_slug': 'old-member',
  };

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }

  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

class _SessionHttp implements AuthHttp {
  final delayedTranslation = Completer<Map<String, dynamic>>();
  final requests = <String>[];
  bool holdTranslation = true;

  @override
  Future<Map<String, dynamic>> get(String path, {String? bearer}) async =>
      {'userSlug': 'new-member'};

  @override
  Future<void> putBytes(String url, Uint8List body,
      {required String contentType}) async {}

  @override
  Future<Map<String, dynamic>> post(String path, Map<String, Object?> body,
      {String? bearer, String? idempotencyKey}) async {
    requests.add(path);
    if (path == '/v1/members') {
      return {
        'authorizationUrl':
            'https://accounts.google.com/o/oauth2/v2/auth?state=new-state',
      };
    }
    if (path == '/v1/members/app-slot/exchange') {
      return {
        'sessionToken': 'new-owner-token',
        'tokenType': 'Bearer',
        'expiresAt': DateTime.now()
            .toUtc()
            .add(const Duration(hours: 1))
            .toIso8601String(),
        'appId': 'kaist-0123456789abcdef01234567',
      };
    }
    if (path.endsWith('/__rpc/listTranslations')) return {'rows': []};
    if (path.endsWith('/actions/translate')) {
      if (holdTranslation) return delayedTranslation.future;
      return {'text': 'fresh result'};
    }
    if (path.endsWith('/__rpc/addTranslation')) return {'ok': true};
    throw StateError('unexpected request path: $path');
  }
}

class _SessionBrowser implements AuthBrowser {
  @override
  Future<Uri> authorize(Uri url) async =>
      Uri.parse('elanous://auth/app-login?code=once&state=new-state');
}

void main() {
  test('late work from an invalidated member session is rejected', () async {
    final epoch = SessionEpoch();
    final requestEpoch = epoch.capture();
    final delayed = Completer<String>();
    final cleanupWait = Completer<void>();
    var visibleMember = 'former-member';
    var visibleText = 'old member transcript';
    final pendingResult = epoch.discardStale(requestEpoch, delayed.future);
    final ending = epoch.endSession(
      clearMemberState: () {
        visibleMember = '';
        visibleText = '';
      },
      cleanup: () => cleanupWait.future,
    );
    expect(visibleMember, isEmpty);
    expect(visibleText, isEmpty);
    cleanupWait.complete();
    await ending;
    visibleMember = 'next-member';
    epoch.invalidate();
    delayed.complete('former member transcript');
    expect(await pendingResult, isNull);
    expect(visibleMember, 'next-member');
    expect(visibleText, isEmpty);
  });

  test('session cleanup removes a pending recording file and tolerates no path',
      () async {
    final directory =
        await Directory.systemTemp.createTemp('flutter-recorder-test-');
    final file = File('${directory.path}/pending.wav');
    await file.writeAsBytes([1, 2, 3]);
    await removeRecordedFile(file.path);
    await removeRecordedFile(null);
    expect(await file.exists(), isFalse);
    await directory.delete(recursive: true);
  });

  testWidgets(
      'logout during a request clears old data before next login and discards its result',
      (tester) async {
    final vault = _SessionVault();
    final http = _SessionHttp();
    final auth = MemberAuth(
        http: http,
        browser: _SessionBrowser(),
        vault: vault,
        randomBytes: (length) => List<int>.filled(length, 9));
    final translator = NexusTranslatorApi(
        auth: auth,
        http: http,
        randomBytes: (length) => List<int>.filled(length, 8));

    await tester
        .pumpWidget(app.TranslatorApp(auth: auth, translator: translator));
    await tester.pumpAndSettle();
    expect(find.text('old-member'), findsNothing);
    expect(find.byTooltip('로그아웃'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'former member text');
    await tester.tap(find.text('번역'));
    await tester.pump();
    expect(http.requests,
        contains('/v1/apps/0123456789abcdef01234567/actions/translate'));

    await tester.tap(find.byTooltip('로그아웃'));
    await tester.pumpAndSettle();
    expect(find.text('former member text'), findsNothing);
    expect(find.text('회원 계정에 번역 기록을 저장하세요.'), findsOneWidget);

    await tester.tap(find.text('Elanous 회원으로 로그인'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('로그아웃'), findsOneWidget);
    expect(vault.values['nexus_owner_token'], 'new-owner-token');
    expect(find.text('former member text'), findsNothing);

    http.delayedTranslation.complete({'text': 'former member translation'});
    await tester.pumpAndSettle();
    expect(find.text('former member translation'), findsNothing);
    expect(
        http.requests.where((path) => path.endsWith('/__rpc/addTranslation')),
        isEmpty);
    expect(vault.values['nexus_owner_token'], 'new-owner-token');
  });
}
