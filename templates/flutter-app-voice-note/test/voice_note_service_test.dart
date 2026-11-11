import 'dart:typed_data';

import 'package:elanous_nexus/elanous_nexus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_app_voice_note/voice_note_service.dart';

class _FakeNexus implements AuthHttp {
  final requests =
      <
        ({String path, Map<String, Object?> body, String? bearer, String? key})
      >[];
  final uploads = <({String url, Uint8List bytes, String contentType})>[];
  bool loseNextScrapResponseAfterCommit = false;
  var ticketNumber = 0;
  final committedScraps = <String, Map<String, dynamic>>{};

  @override
  Future<Map<String, dynamic>> get(String path, {String? bearer}) async {
    if (path != '/v1/scraps' || bearer != 'owner-token') {
      throw StateError('unexpected Nexus GET: $path');
    }
    return {
      'scraps': [
        {
          'id': 'scrap-1',
          'kind': 'voice',
          'status': 'absorbed',
          'card': {
            'title': '회의 메모',
            'points': ['결정 사항 기록'],
          },
        },
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, Object?> body, {
    String? bearer,
    String? idempotencyKey,
  }) async {
    requests.add((path: path, body: body, bearer: bearer, key: idempotencyKey));
    if (path == '/v1/apps/0123456789abcdef01234567/storage/uploads') {
      final key = body['key'];
      if (key is! String || !key.startsWith('scraps/')) {
        throw StateError('upload ticket must be scoped to scraps');
      }
      return {
        'url':
            'https://api.elanous.ai/_app-storage/0123456789abcdef01234567/scraps/${key.substring('scraps/'.length)}?token=${++ticketNumber}',
      };
    }
    if (path == '/v1/scraps') {
      final key = idempotencyKey;
      if (key == null) throw StateError('scrap idempotency key is required');
      final stored = committedScraps.putIfAbsent(
        key,
        () => {
          'id': 'scrap-${committedScraps.length + 1}',
          'status': 'absorbed',
          'body': body,
          'card': {
            'title': '회의 메모',
            'points': ['결정 사항 기록'],
          },
        },
      );
      if (loseNextScrapResponseAfterCommit) {
        loseNextScrapResponseAfterCommit = false;
        throw StateError('simulated response lost after Nexus committed');
      }
      return Map<String, dynamic>.from(stored)..remove('body');
    }
    throw StateError('unexpected Nexus POST: $path');
  }

  @override
  Future<void> putBytes(
    String url,
    Uint8List body, {
    required String contentType,
  }) async {
    uploads.add((url: url, bytes: body, contentType: contentType));
  }
}

class _MemoryVault implements TokenVault {
  final values = <String, String>{
    'nexus_owner_token': 'owner-token',
    'nexus_owner_token_expires_at': DateTime.now()
        .toUtc()
        .add(const Duration(hours: 1))
        .toIso8601String(),
    'nexus_owner_app_slug': '0123456789abcdef01234567',
    'nexus_owner_user_slug': 'kaist-demo',
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

void main() {
  test('keeps attachments editable after repeated preflight removals', () {
    final editability = VoiceNoteDraftEditability();

    editability.preflightRejected();
    expect(editability.canEdit, isTrue);
    editability.attachmentRemoved();
    expect(editability.canEdit, isTrue);
    editability.attachmentRemoved();
    expect(editability.canEdit, isTrue);
    editability.submissionStarted();
    expect(editability.canEdit, isFalse);
  });

  test(
    'uploads recording and media then submits the timestamped timeline',
    () async {
      final nexus = _FakeNexus();
      var nonce = 0;
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: _MemoryVault(),
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );

      final summary = await service.submitRecording(
        audio: Uint8List.fromList([1, 2, 3]),
        audioMime: 'audio/wav',
        attachments: [
          VoiceTimelineAttachment(
            kind: 'photo',
            offsetMs: 1250,
            mime: 'image/jpeg',
            bytes: Uint8List.fromList([4, 5]),
          ),
          VoiceTimelineAttachment(
            kind: 'video',
            offsetMs: 3000,
            mime: 'video/quicktime',
            bytes: Uint8List.fromList([6, 7]),
          ),
        ],
      );

      expect(nexus.uploads, hasLength(3));
      expect(nexus.uploads.map((upload) => upload.contentType), [
        'audio/wav',
        'image/jpeg',
        'video/quicktime',
      ]);
      final create = nexus.requests.singleWhere(
        (request) => request.path == '/v1/scraps',
      );
      expect(
        nexus.requests.every((request) => request.bearer == 'owner-token'),
        isTrue,
      );
      expect(create.bearer, 'owner-token');
      expect(create.key, startsWith('voice-note.'));
      expect(create.body['kind'], 'voice');
      expect(create.body['source'], 'flutter-record');
      expect(create.body['raw'], {
        'mediaRef': isA<String>(),
        'mime': 'audio/wav',
        'timeline': [
          {
            't': 0,
            'kind': 'voice',
            'mediaRef': isA<String>(),
            'mime': 'audio/wav',
          },
          {
            't': 1250,
            'kind': 'photo',
            'mediaRef': isA<String>(),
            'mime': 'image/jpeg',
          },
          {
            't': 3000,
            'kind': 'video',
            'mediaRef': isA<String>(),
            'mime': 'video/quicktime',
          },
        ],
      });
      expect(summary.title, '회의 메모');
      expect(summary.points, ['결정 사항 기록']);
    },
  );

  test('rejects invalid timeline entries before uploading any media', () async {
    final nexus = _FakeNexus();
    final auth = MemberAuth(
      http: nexus,
      browser: _UnusedBrowser(),
      vault: _MemoryVault(),
      randomBytes: (length) => List<int>.filled(length, 3),
    );
    final service = VoiceNoteService(
      auth: auth,
      apiOrigin: Uri.parse('https://api.elanous.ai'),
      randomBytes: (length) => List<int>.filled(length, 4),
    );

    await expectLater(
      service.submitRecording(
        audio: Uint8List.fromList([1]),
        audioMime: 'audio/wav',
        attachments: [
          VoiceTimelineAttachment(
            kind: 'photo',
            offsetMs: -1,
            mime: 'image/jpeg',
            bytes: Uint8List.fromList([2]),
          ),
        ],
      ),
      throwsArgumentError,
    );
    expect(nexus.requests, isEmpty);
    expect(nexus.uploads, isEmpty);
  });

  test(
    'preflights every media type and size before creating upload tickets',
    () async {
      final nexus = _FakeNexus();
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: _MemoryVault(),
        randomBytes: (length) => List<int>.filled(length, 7),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) => List<int>.filled(length, 8),
      );

      await expectLater(
        service.submitRecording(
          audio: Uint8List.fromList([1]),
          audioMime: 'audio/wav',
          attachments: [
            VoiceTimelineAttachment(
              kind: 'photo',
              offsetMs: 0,
              mime: 'image/jpeg',
              bytes: Uint8List.fromList([2]),
            ),
            VoiceTimelineAttachment(
              kind: 'video',
              offsetMs: 1,
              mime: 'video/mpeg',
              bytes: Uint8List.fromList([3]),
            ),
          ],
        ),
        throwsArgumentError,
      );
      await expectLater(
        service.submitRecording(
          audio: Uint8List.fromList([1]),
          audioMime: 'audio/wav',
          attachments: [
            VoiceTimelineAttachment(
              kind: 'photo',
              offsetMs: 0,
              mime: 'image/jpeg',
              bytes: Uint8List(voiceNoteMaxMediaBytes + 1),
            ),
          ],
        ),
        throwsArgumentError,
      );
      expect(nexus.requests, isEmpty);
      expect(nexus.uploads, isEmpty);
    },
  );

  test(
    'reuses media keys and scrap body after a committed response is lost',
    () async {
      final nexus = _FakeNexus()..loseNextScrapResponseAfterCommit = true;
      var nonce = 0;
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: _MemoryVault(),
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );
      final draft = service.createDraft(
        audio: Uint8List.fromList([1, 2]),
        audioMime: 'audio/wav',
        attachments: [
          VoiceTimelineAttachment(
            kind: 'photo',
            offsetMs: 250,
            mime: 'image/jpeg',
            bytes: Uint8List.fromList([3, 4]),
          ),
        ],
        ownerUserSlug: 'kaist-demo',
      );

      await expectLater(service.submitDraft(draft), throwsStateError);
      final summary = await service.submitDraft(draft);

      final scrapPosts = nexus.requests
          .where((request) => request.path == '/v1/scraps')
          .toList();
      expect(scrapPosts, hasLength(2));
      expect(scrapPosts[0].key, draft.idempotencyKey);
      expect(scrapPosts[1].key, draft.idempotencyKey);
      expect(scrapPosts[0].body, scrapPosts[1].body);
      expect(nexus.committedScraps, hasLength(1));
      final ticketRequests = nexus.requests
          .where((request) => request.path.endsWith('/storage/uploads'))
          .toList();
      expect(ticketRequests, hasLength(4));
      expect(
        ticketRequests[0].body['key'],
        ticketRequests[2].body['key'],
        reason: 'retries should reuse the audio upload key',
      );
      expect(
        ticketRequests[1].body['key'],
        ticketRequests[3].body['key'],
        reason: 'retries should reuse each attachment upload key',
      );
      expect(nexus.uploads, hasLength(4));
      expect(
        nexus.uploads[0].url,
        isNot(nexus.uploads[2].url),
        reason: 'fresh upload tickets can have different signed URLs',
      );
      expect(summary.id, 'scrap-1');
    },
  );

  test(
    'does not submit a pending draft under a different member session',
    () async {
      final nexus = _FakeNexus();
      final vault = _MemoryVault();
      var nonce = 0;
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: vault,
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) =>
            List<int>.generate(length, (_) => ++nonce % 256),
      );
      final draft = service.createDraft(
        audio: Uint8List.fromList([1]),
        audioMime: 'audio/wav',
        attachments: const [],
        ownerUserSlug: 'kaist-demo',
      );
      vault.values['nexus_owner_user_slug'] = 'different-member';

      await expectLater(service.submitDraft(draft), throwsStateError);
      expect(nexus.requests, isEmpty);
      expect(nexus.uploads, isEmpty);
    },
  );

  test(
    'accepts each supported attachment MIME and the exact media size limit',
    () async {
      const mimes = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/quicktime',
      ];
      for (final mime in mimes) {
        final nexus = _FakeNexus();
        var nonce = 0;
        final auth = MemberAuth(
          http: nexus,
          browser: _UnusedBrowser(),
          vault: _MemoryVault(),
          randomBytes: (length) =>
              List<int>.generate(length, (_) => ++nonce % 256),
        );
        final service = VoiceNoteService(
          auth: auth,
          apiOrigin: Uri.parse('https://api.elanous.ai'),
          randomBytes: (length) =>
              List<int>.generate(length, (_) => ++nonce % 256),
        );
        final kind = mime.startsWith('image/') ? 'photo' : 'video';
        await service.submitRecording(
          audio: Uint8List.fromList([1]),
          audioMime: 'audio/wav',
          attachments: [
            VoiceTimelineAttachment(
              kind: kind,
              offsetMs: 0,
              mime: mime,
              bytes: Uint8List.fromList([2]),
            ),
          ],
        );
        expect(nexus.uploads.map((entry) => entry.contentType), [
          'audio/wav',
          mime,
        ]);
      }

      final nexus = _FakeNexus();
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: _MemoryVault(),
        randomBytes: (length) => List<int>.filled(length, 9),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) => List<int>.filled(length, 10),
      );
      await service.submitRecording(
        audio: Uint8List(voiceNoteMaxMediaBytes),
        audioMime: 'audio/wav',
        attachments: const [],
      );
      expect(nexus.uploads.single.bytes.length, voiceNoteMaxMediaBytes);
    },
  );

  test('rejects oversized audio before creating any upload ticket', () async {
    final nexus = _FakeNexus();
    final auth = MemberAuth(
      http: nexus,
      browser: _UnusedBrowser(),
      vault: _MemoryVault(),
      randomBytes: (length) => List<int>.filled(length, 1),
    );
    final service = VoiceNoteService(
      auth: auth,
      apiOrigin: Uri.parse('https://api.elanous.ai'),
      randomBytes: (length) => List<int>.filled(length, 2),
    );
    await expectLater(
      service.submitRecording(
        audio: Uint8List(voiceNoteMaxMediaBytes + 1),
        audioMime: 'audio/wav',
        attachments: const [],
      ),
      throwsArgumentError,
    );
    expect(nexus.requests, isEmpty);
    expect(nexus.uploads, isEmpty);
  });

  test(
    'rejects drafts above the aggregate memory limit before uploading',
    () async {
      final nexus = _FakeNexus();
      final auth = MemberAuth(
        http: nexus,
        browser: _UnusedBrowser(),
        vault: _MemoryVault(),
        randomBytes: (length) => List<int>.filled(length, 4),
      );
      final service = VoiceNoteService(
        auth: auth,
        apiOrigin: Uri.parse('https://api.elanous.ai'),
        randomBytes: (length) => List<int>.filled(length, 5),
      );

      await expectLater(
        service.submitRecording(
          audio: Uint8List(voiceNoteMaxMediaBytes),
          audioMime: 'audio/wav',
          attachments: [
            VoiceTimelineAttachment(
              kind: 'photo',
              offsetMs: 0,
              mime: 'image/jpeg',
              bytes: Uint8List(voiceNoteMaxMediaBytes),
            ),
            VoiceTimelineAttachment(
              kind: 'photo',
              offsetMs: 1,
              mime: 'image/jpeg',
              bytes: Uint8List.fromList([1]),
            ),
          ],
        ),
        throwsArgumentError,
      );
      expect(nexus.requests, isEmpty);
      expect(nexus.uploads, isEmpty);
    },
  );

  test('lists voice scraps and parses the generated summary card', () async {
    final nexus = _FakeNexus();
    final auth = MemberAuth(
      http: nexus,
      browser: _UnusedBrowser(),
      vault: _MemoryVault(),
      randomBytes: (length) => List<int>.filled(length, 5),
    );
    final service = VoiceNoteService(
      auth: auth,
      apiOrigin: Uri.parse('https://api.elanous.ai'),
      randomBytes: (length) => List<int>.filled(length, 6),
    );

    final recent = await service.listRecent();

    expect(recent, hasLength(1));
    expect(recent.single.status, 'absorbed');
    expect(recent.single.points, ['결정 사항 기록']);
  });
}

class _UnusedBrowser implements AuthBrowser {
  @override
  Future<Uri> authorize(Uri url) =>
      throw StateError('login not used in this test');
}
