import 'dart:convert';
import 'dart:typed_data';

import 'package:elanous_nexus/elanous_nexus.dart';

// Source: #36306 accepts at most 128 items in the optional scrap timeline, including its voice entry.
const _maxTimelineEntries = 128;
// Source: the Nexus signed-upload flow uses short-lived upload tickets.
const _uploadTicketTtlMs = 60000;
// Source: src/nexus/apps/app-upload.ts defaults app media uploads to 10 MiB.
const voiceNoteMaxMediaBytes = 10 * 1024 * 1024;
// Source: Voice-note drafts are buffered before upload; bound their aggregate in-memory media.
const voiceNoteMaxDraftBytes = 20 * 1024 * 1024;
const _audioMimes = {'audio/wav'};
const _attachmentMimes = {
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
};

bool isSupportedVoiceAttachmentMime(String mime) =>
    _attachmentMimes.contains(mime.toLowerCase());

class VoiceTimelineAttachment {
  const VoiceTimelineAttachment({
    required this.kind,
    required this.offsetMs,
    required this.mime,
    required this.bytes,
  });

  final String kind;
  final int offsetMs;
  final String mime;
  final Uint8List bytes;
}

class VoiceNoteSummary {
  const VoiceNoteSummary({
    required this.id,
    required this.status,
    required this.title,
    required this.points,
    this.failure,
  });

  final String id;
  final String status;
  final String title;
  final List<String> points;
  final String? failure;

  factory VoiceNoteSummary.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final status = json['status'];
    final card = json['card'];
    if (id is! String || id.isEmpty || status is! String) {
      throw const FormatException('Nexus returned an invalid scrap receipt');
    }
    final points = card is Map && card['points'] is List
        ? (card['points'] as List).whereType<String>().toList(growable: false)
        : const <String>[];
    final title = card is Map && card['title'] is String
        ? card['title'] as String
        : '요약을 준비하고 있습니다.';
    final failureValue = json['failure'];
    final failure = failureValue is Map && failureValue['reason'] is String
        ? failureValue['reason'] as String
        : null;
    return VoiceNoteSummary(
      id: id,
      status: status,
      title: title,
      points: points,
      failure: failure,
    );
  }
}

class VoiceNoteDraft {
  const VoiceNoteDraft({
    required this.audio,
    required this.audioMime,
    required this.attachments,
    required this.idempotencyKey,
    required this.audioKey,
    required this.attachmentKeys,
    required this.ownerUserSlug,
  });

  final Uint8List audio;
  final String audioMime;
  final List<VoiceTimelineAttachment> attachments;
  final String idempotencyKey;
  final String audioKey;
  final List<String> attachmentKeys;
  final String ownerUserSlug;
}

/// Tracks whether the local attachment set can still be edited and resubmitted.
class VoiceNoteDraftEditability {
  bool _canEdit = false;

  bool get canEdit => _canEdit;

  void draftCreated() => _canEdit = true;
  void submissionStarted() => _canEdit = false;
  void preflightRejected() => _canEdit = true;
  void attachmentRemoved() => _canEdit = true;
  void clear() => _canEdit = false;
}

/// Uses the #36301 member session SDK and the member-scoped /v1/scraps contract.
class VoiceNoteService {
  VoiceNoteService({
    required this.auth,
    required this.apiOrigin,
    required this.randomBytes,
  });

  final MemberAuth auth;
  final Uri apiOrigin;
  final List<int> Function(int length) randomBytes;

  String createIdempotencyKey() =>
      'voice-note.${randomBytes(18).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';

  VoiceNoteDraft createDraft({
    required Uint8List audio,
    required String audioMime,
    required List<VoiceTimelineAttachment> attachments,
    required String ownerUserSlug,
  }) => VoiceNoteDraft(
    audio: audio,
    audioMime: audioMime,
    attachments: List.unmodifiable(attachments),
    idempotencyKey: createIdempotencyKey(),
    audioKey: 'scraps/${_newId()}',
    attachmentKeys: List.unmodifiable(
      List<String>.generate(attachments.length, (_) => 'scraps/${_newId()}'),
    ),
    ownerUserSlug: ownerUserSlug,
  );

  Future<VoiceNoteSummary> submitDraft(VoiceNoteDraft draft) async {
    if (draft.attachmentKeys.length != draft.attachments.length) {
      throw ArgumentError.value(
        draft,
        'draft',
        'media keys do not match attachments',
      );
    }
    return _submit(
      audio: draft.audio,
      audioMime: draft.audioMime,
      attachments: draft.attachments,
      idempotencyKey: draft.idempotencyKey,
      audioKey: draft.audioKey,
      attachmentKeys: draft.attachmentKeys,
      ownerUserSlug: draft.ownerUserSlug,
    );
  }

  String _newId() => base64UrlEncode(randomBytes(18)).replaceAll('=', '');

  Future<MemberSession> _verifySession(MemberSession expected) async {
    final current = await auth.readSession();
    if (current == null ||
        current.token != expected.token ||
        current.appSlug != expected.appSlug ||
        current.userSlug != expected.userSlug) {
      throw StateError('Member session changed before the scrap request');
    }
    return current;
  }

  Future<String> _upload(
    MemberSession session, {
    required Uint8List bytes,
    required String mime,
    required String key,
  }) async {
    final ticket = await auth.http.post(
      '/v1/apps/${session.appSlug}/storage/uploads',
      {'key': key, 'expiresInMs': _uploadTicketTtlMs, 'role': 'owner'},
      bearer: session.token,
    );
    await _verifySession(session);
    final uploadUrl = ticket['url'];
    final parsed = uploadUrl is String ? Uri.tryParse(uploadUrl) : null;
    if (parsed == null ||
        parsed.scheme != 'https' ||
        parsed.origin != apiOrigin.origin ||
        !parsed.path.startsWith('/_app-storage/${session.appSlug}/scraps/')) {
      throw const FormatException('Nexus returned an invalid media upload URL');
    }
    await auth.http.putBytes(parsed.toString(), bytes, contentType: mime);
    await _verifySession(session);
    return key;
  }

  Future<VoiceNoteSummary> submitRecording({
    required Uint8List audio,
    required String audioMime,
    required List<VoiceTimelineAttachment> attachments,
    String? idempotencyKey,
  }) => _submit(
    audio: audio,
    audioMime: audioMime,
    attachments: attachments,
    idempotencyKey: idempotencyKey ?? createIdempotencyKey(),
    audioKey: 'scraps/${_newId()}',
    attachmentKeys: List.generate(
      attachments.length,
      (_) => 'scraps/${_newId()}',
    ),
    ownerUserSlug: null,
  );

  Future<VoiceNoteSummary> _submit({
    required Uint8List audio,
    required String audioMime,
    required List<VoiceTimelineAttachment> attachments,
    required String idempotencyKey,
    required String audioKey,
    required List<String> attachmentKeys,
    required String? ownerUserSlug,
  }) async {
    if (audio.isEmpty || audio.lengthInBytes > voiceNoteMaxMediaBytes) {
      throw ArgumentError.value(
        audio,
        'audio',
        'must be non-empty and at most 10 MiB',
      );
    }
    if (!_audioMimes.contains(audioMime.toLowerCase())) {
      throw ArgumentError.value(audioMime, 'audioMime', 'must be audio');
    }
    if (attachments.length + 1 > _maxTimelineEntries) {
      throw ArgumentError.value(
        attachments,
        'attachments',
        'timeline exceeds the Nexus limit',
      );
    }
    for (final attachment in attachments) {
      final expectedMimePrefix = attachment.kind == 'photo'
          ? 'image/'
          : 'video/';
      if (attachment.offsetMs < 0 ||
          (attachment.kind != 'photo' && attachment.kind != 'video') ||
          !_attachmentMimes.contains(attachment.mime.toLowerCase()) ||
          !attachment.mime.toLowerCase().startsWith(expectedMimePrefix) ||
          attachment.bytes.isEmpty ||
          attachment.bytes.lengthInBytes > voiceNoteMaxMediaBytes) {
        throw ArgumentError.value(
          attachment,
          'attachments',
          'invalid timeline attachment',
        );
      }
    }
    final totalMediaBytes = attachments.fold<int>(
      audio.lengthInBytes,
      (total, attachment) => total + attachment.bytes.lengthInBytes,
    );
    if (totalMediaBytes > voiceNoteMaxDraftBytes) {
      throw ArgumentError.value(
        totalMediaBytes,
        'media',
        'draft exceeds the aggregate media limit',
      );
    }
    final session = await auth.readSession();
    if (session == null)
      throw StateError('Sign in before creating a voice note');
    if (ownerUserSlug != null && session.userSlug != ownerUserSlug) {
      throw StateError(
        'Sign in as the member who created this voice note draft',
      );
    }

    final audioRef = await _upload(
      session,
      bytes: audio,
      mime: audioMime,
      key: audioKey,
    );
    final timeline = <Map<String, Object>>[];
    for (var index = 0; index < attachments.length; index++) {
      final attachment = attachments[index];
      final mediaRef = await _upload(
        session,
        bytes: attachment.bytes,
        mime: attachment.mime,
        key: attachmentKeys[index],
      );
      timeline.add({
        't': attachment.offsetMs,
        'kind': attachment.kind,
        'mediaRef': mediaRef,
        'mime': attachment.mime,
      });
    }

    final raw = <String, Object>{'mediaRef': audioRef, 'mime': audioMime};
    if (timeline.isNotEmpty) {
      raw['timeline'] = [
        {'t': 0, 'kind': 'voice', 'mediaRef': audioRef, 'mime': audioMime},
        ...timeline,
      ];
    }
    await _verifySession(session);
    final result = await auth.http.post(
      '/v1/scraps',
      {'kind': 'voice', 'source': 'flutter-record', 'raw': raw},
      bearer: session.token,
      idempotencyKey: idempotencyKey,
    );
    await _verifySession(session);
    return VoiceNoteSummary.fromJson(result);
  }

  Future<List<VoiceNoteSummary>> listRecent() async {
    final session = await auth.readSession();
    if (session == null) return const [];
    final result = await auth.http.get('/v1/scraps', bearer: session.token);
    await _verifySession(session);
    final scraps = result['scraps'];
    if (scraps is! List) {
      throw const FormatException('Nexus returned an invalid scrap list');
    }
    return scraps
        .whereType<Map<String, dynamic>>()
        .where((scrap) => scrap['kind'] == 'voice')
        .map(VoiceNoteSummary.fromJson)
        .toList(growable: false);
  }
}
