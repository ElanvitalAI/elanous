import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:elanous_nexus/elanous_nexus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'voice_note_service.dart';

const apiOrigin = String.fromEnvironment(
  'NEXUS_API_ORIGIN',
  defaultValue: 'https://api.elanous.ai',
);
const recordingMime = 'audio/wav';
const _maxUploadBytes = voiceNoteMaxMediaBytes;

class SessionExpiredException implements Exception {
  const SessionExpiredException();
}

class NexusHttpException implements Exception {
  const NexusHttpException(this.statusCode, this.message);
  final int statusCode;
  final String message;
}

class NexusHttp implements AuthHttp {
  NexusHttp(this.client, this.origin);
  final http.Client client;
  final Uri origin;

  Uri _uri(String path) =>
      path.startsWith('https://') || path.startsWith('http://')
      ? Uri.parse(path)
      : origin.resolve(path);

  Map<String, dynamic> _decode(http.Response response) {
    Object? payload;
    try {
      payload = jsonDecode(response.body);
    } on FormatException {
      payload = null;
    }
    if (response.statusCode == 401) throw const SessionExpiredException();
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        payload is! Map<String, dynamic>) {
      throw NexusHttpException(response.statusCode, response.body);
    }
    return payload;
  }

  @override
  Future<Map<String, dynamic>> get(String path, {String? bearer}) async {
    final response = await client.get(
      _uri(path),
      headers: {if (bearer != null) 'authorization': 'Bearer $bearer'},
    );
    return _decode(response);
  }

  @override
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, Object?> body, {
    String? bearer,
    String? idempotencyKey,
  }) async {
    final response = await client.post(
      _uri(path),
      headers: {
        'content-type': 'application/json',
        if (bearer != null) 'authorization': 'Bearer $bearer',
        if (idempotencyKey != null) 'idempotency-key': idempotencyKey,
      },
      body: jsonEncode(body),
    );
    return _decode(response);
  }

  @override
  Future<void> putBytes(
    String url,
    Uint8List body, {
    required String contentType,
  }) async {
    final target = Uri.parse(url);
    if (target.scheme != 'https' || target.origin != origin.origin) {
      throw const FormatException('Nexus returned a non-API upload origin');
    }
    final response = await client.put(
      target,
      headers: {'content-type': contentType},
      body: body,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw NexusHttpException(response.statusCode, response.body);
    }
  }
}

class SecureTokenVault implements TokenVault {
  const SecureTokenVault(this.storage);
  final FlutterSecureStorage storage;
  @override
  Future<void> delete(String key) => storage.delete(key: key);
  @override
  Future<String?> read(String key) => storage.read(key: key);
  @override
  Future<void> write(String key, String value) =>
      storage.write(key: key, value: value);
}

class SystemAuthBrowser implements AuthBrowser {
  @override
  Future<Uri> authorize(Uri url) async => Uri.parse(
    await FlutterWebAuth2.authenticate(
      url: url.toString(),
      callbackUrlScheme: 'elanous',
    ),
  );
}

class VoiceNoteApp extends StatefulWidget {
  const VoiceNoteApp({super.key});

  @override
  State<VoiceNoteApp> createState() => _VoiceNoteAppState();
}

class _PendingAttachment {
  const _PendingAttachment({
    required this.file,
    required this.kind,
    required this.offsetMs,
    required this.mime,
  });

  final XFile file;
  final String kind;
  final int offsetMs;
  final String mime;
}

class _VoiceNoteAppState extends State<VoiceNoteApp> {
  final _storage = const FlutterSecureStorage();
  final _recorder = AudioRecorder();
  final _picker = ImagePicker();
  final _recordingClock = Stopwatch();
  final _draftEditability = VoiceNoteDraftEditability();
  late final _httpClient = http.Client();
  late final _http = NexusHttp(_httpClient, Uri.parse(apiOrigin));
  late final _auth = MemberAuth(
    http: _http,
    browser: SystemAuthBrowser(),
    vault: SecureTokenVault(_storage),
    randomBytes: _secureRandomBytes,
  );
  late final _service = VoiceNoteService(
    auth: _auth,
    apiOrigin: Uri.parse(apiOrigin),
    randomBytes: _secureRandomBytes,
  );

  MemberSession? _session;
  String? _recordingPath;
  VoiceNoteDraft? _pendingDraft;
  VoiceNoteSummary? _latest;
  List<VoiceNoteSummary> _recent = const [];
  final List<_PendingAttachment> _attachments = [];
  bool _busy = true;
  bool _recording = false;
  String _message = '회원 로그인 후 음성 노트를 만들 수 있습니다.';
  int _sessionEpoch = 0;

  List<int> _secureRandomBytes(int length) {
    final random = Random.secure();
    return List<int>.generate(length, (_) => random.nextInt(256));
  }

  bool get _canRetryPendingDraft =>
      _pendingDraft == null ||
      _pendingDraft!.ownerUserSlug == _session?.userSlug;

  @override
  void initState() {
    super.initState();
    unawaited(_restoreSession());
  }

  Future<void> _restoreSession() async {
    final epoch = ++_sessionEpoch;
    try {
      final session = await _auth.readSession();
      if (!mounted || epoch != _sessionEpoch) return;
      setState(() => _session = session);
      if (session != null) await _loadRecent(epoch, session);
    } catch (_) {
      if (mounted && epoch == _sessionEpoch) {
        setState(() => _message = '저장된 회원 세션을 확인하지 못했습니다. 다시 로그인해 주세요.');
      }
    } finally {
      if (mounted && epoch == _sessionEpoch) setState(() => _busy = false);
    }
  }

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _message = '회원 로그인을 여는 중…';
    });
    try {
      final session = await _auth.login();
      if (!mounted) return;
      final epoch = ++_sessionEpoch;
      setState(() {
        _session = session;
        _message =
            _pendingDraft != null &&
                _pendingDraft!.ownerUserSlug != session.userSlug
            ? '대기 중인 녹음은 다른 회원 계정에서 만들어졌습니다. 원래 회원으로 로그인해 저장하세요.'
            : '회원 계정에 연결했습니다.';
      });
      await _loadRecent(epoch, session);
    } catch (error) {
      if (mounted) setState(() => _message = '로그인 실패: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _logout() async {
    final oldSession = _session;
    _auth.invalidateSession(oldSession);
    ++_sessionEpoch;
    final wasRecording = _recording;
    final path = _recordingPath;
    setState(() {
      _session = null;
      _recording = false;
      _recordingPath = null;
      _pendingDraft = null;
      _attachments.clear();
      _recent = const [];
      _latest = null;
      _message = '로그아웃했습니다.';
    });
    await _auth.logout(expectedToken: oldSession?.token);
    if (wasRecording) {
      try {
        await _recorder.stop();
      } catch (_) {}
    }
    await _removeFile(path);
  }

  Future<void> _expireSessionPreservingDraft() async {
    final oldSession = _session;
    _auth.invalidateSession(oldSession);
    ++_sessionEpoch;
    setState(() {
      _session = null;
      _recording = false;
      _recent = const [];
      _latest = null;
      _busy = false;
      _message = '회원 세션이 만료됐습니다. 다시 로그인하면 대기 중인 녹음을 이어서 저장할 수 있습니다.';
    });
    await _auth.logout(expectedToken: oldSession?.token);
    try {
      await _recorder.stop();
    } catch (_) {}
  }

  Future<void> _loadRecent(int epoch, MemberSession expected) async {
    try {
      final rows = await _service.listRecent();
      if (!mounted ||
          epoch != _sessionEpoch ||
          _session?.token != expected.token) {
        return;
      }
      setState(() => _recent = rows);
    } on SessionExpiredException {
      if (mounted && epoch == _sessionEpoch)
        await _expireSessionPreservingDraft();
    } catch (_) {
      if (mounted && epoch == _sessionEpoch) {
        setState(() => _message = '최근 음성 노트를 불러오지 못했습니다.');
      }
    }
  }

  Future<void> _startRecording() async {
    final startingSession = _session;
    if (startingSession == null || _busy || _recording) return;
    final epoch = _sessionEpoch;
    setState(() {
      _busy = true;
      _message = '녹음 권한과 장치를 확인하는 중…';
    });
    try {
      if (!await _recorder.hasPermission()) {
        if (mounted && epoch == _sessionEpoch) {
          setState(() => _message = '마이크 권한이 필요합니다.');
        }
        return;
      }
      if (!mounted ||
          epoch != _sessionEpoch ||
          _session?.token != startingSession.token)
        return;
      final directory = await getTemporaryDirectory();
      final path =
          '${directory.path}/voice-note-${DateTime.now().microsecondsSinceEpoch}.wav';
      if (!mounted ||
          epoch != _sessionEpoch ||
          _session?.token != startingSession.token)
        return;
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.wav,
          sampleRate: 16000,
          numChannels: 1,
        ),
        path: path,
      );
      if (!mounted ||
          epoch != _sessionEpoch ||
          _session?.token != startingSession.token) {
        try {
          await _recorder.stop();
        } catch (_) {}
        await _removeFile(path);
        return;
      }
      _recordingClock
        ..reset()
        ..start();
      setState(() {
        _recording = true;
        _recordingPath = path;
        _attachments.clear();
        _message = '녹음 중입니다. 사진이나 동영상을 추가할 수 있습니다.';
      });
    } catch (error) {
      if (mounted && epoch == _sessionEpoch) {
        setState(() => _message = '녹음을 시작하지 못했습니다: $error');
      }
    } finally {
      if (mounted && epoch == _sessionEpoch) setState(() => _busy = false);
    }
  }

  String _attachmentMime(XFile file, String kind) {
    final supplied = file.mimeType?.toLowerCase();
    if (supplied != null &&
        isSupportedVoiceAttachmentMime(supplied) &&
        supplied.startsWith(kind == 'photo' ? 'image/' : 'video/')) {
      return supplied;
    }
    final name = file.name.toLowerCase();
    if (kind == 'photo') {
      if (name.endsWith('.png')) return 'image/png';
      if (name.endsWith('.webp')) return 'image/webp';
      if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    } else {
      if (name.endsWith('.mov')) return 'video/quicktime';
      if (name.endsWith('.mp4')) return 'video/mp4';
    }
    throw FormatException('지원하지 않는 ${kind == 'photo' ? '사진' : '동영상'} 형식입니다.');
  }

  Future<void> _attach(String kind) async {
    if (!_recording || _busy) return;
    try {
      final file = kind == 'photo'
          ? await _picker.pickImage(source: ImageSource.gallery)
          : await _picker.pickVideo(source: ImageSource.gallery);
      if (file == null || !mounted || !_recording) return;
      setState(() {
        _attachments.add(
          _PendingAttachment(
            file: file,
            kind: kind,
            offsetMs: _recordingClock.elapsedMilliseconds,
            mime: _attachmentMime(file, kind),
          ),
        );
        _message = '${kind == 'photo' ? '사진' : '동영상'}을 타임라인에 추가했습니다.';
      });
    } catch (error) {
      if (mounted) setState(() => _message = '미디어를 추가하지 못했습니다: $error');
    }
  }

  Future<void> _finishRecording() async {
    final expected = _session;
    if (expected == null || (_recordingPath == null && _pendingDraft == null))
      return;
    if (_pendingDraft != null &&
        _pendingDraft!.ownerUserSlug != expected.userSlug) {
      setState(() => _message = '대기 중인 녹음은 만든 회원 계정으로만 저장할 수 있습니다.');
      return;
    }
    final epoch = _sessionEpoch;
    final recordingPath = _recordingPath;
    final wasRecording = _recording;
    var submitted = false;
    setState(() {
      _recording = false;
      _busy = true;
      _message = '녹음과 첨부 미디어를 요약하는 중…';
    });
    try {
      if (_pendingDraft == null) {
        _recordingClock.stop();
        final stoppedPath = wasRecording
            ? await _recorder.stop() ?? recordingPath
            : recordingPath;
        if (stoppedPath == null) throw StateError('녹음 파일을 찾을 수 없습니다.');
        final audioFile = File(stoppedPath);
        final audioLength = await audioFile.length();
        if (audioLength == 0 || audioLength > _maxUploadBytes) {
          throw StateError('녹음 파일 크기가 허용 범위(10 MiB)를 벗어났습니다.');
        }
        var totalDraftBytes = audioLength;
        final attachmentLengths = <int>[];
        for (final entry in _attachments) {
          final file = File(entry.file.path);
          int length;
          try {
            length = await file.length();
          } catch (error) {
            _draftEditability.preflightRejected();
            throw StateError('${entry.file.name} 첨부 파일을 읽지 못했습니다: $error');
          }
          if (length == 0 || length > _maxUploadBytes) {
            _draftEditability.preflightRejected();
            throw StateError(
              '${entry.file.name} 파일 크기가 허용 범위(10 MiB)를 벗어났습니다.',
            );
          }
          if (totalDraftBytes + length > voiceNoteMaxDraftBytes) {
            _draftEditability.preflightRejected();
            throw StateError(
              '음성 노트의 전체 미디어가 메모리 상한(20 MiB)을 넘었습니다. 첨부를 줄여 주세요.',
            );
          }
          totalDraftBytes += length;
          attachmentLengths.add(length);
        }
        final audio = await _readFileExactly(audioFile, audioLength);
        final attachments = <VoiceTimelineAttachment>[];
        for (var index = 0; index < _attachments.length; index++) {
          final entry = _attachments[index];
          final file = File(entry.file.path);
          Uint8List fileBytes;
          try {
            fileBytes = await _readFileExactly(file, attachmentLengths[index]);
          } catch (error) {
            _draftEditability.preflightRejected();
            throw StateError('${entry.file.name} 첨부 파일을 읽지 못했습니다: $error');
          }
          attachments.add(
            VoiceTimelineAttachment(
              kind: entry.kind,
              offsetMs: entry.offsetMs,
              mime: entry.mime,
              bytes: fileBytes,
            ),
          );
        }
        _pendingDraft = _service.createDraft(
          audio: audio,
          audioMime: recordingMime,
          attachments: attachments,
          ownerUserSlug: expected.userSlug,
        );
        _draftEditability.draftCreated();
      }
      _draftEditability.submissionStarted();
      final result = await _service.submitDraft(_pendingDraft!);
      submitted = true;
      if (!mounted || epoch != _sessionEpoch) return;
      setState(() {
        _latest = result;
        _message = result.status == 'absorbed'
            ? '요약 음성 노트를 저장했습니다.'
            : '음성 노트 상태: ${result.status}';
        _attachments.clear();
        _recordingPath = null;
        _pendingDraft = null;
        _draftEditability.clear();
      });
      await _loadRecent(epoch, expected);
    } on SessionExpiredException {
      if (mounted && epoch == _sessionEpoch)
        await _expireSessionPreservingDraft();
    } catch (error) {
      if (mounted && epoch == _sessionEpoch) {
        setState(() {
          if (error is ArgumentError) _draftEditability.preflightRejected();
          _message = '음성 노트를 저장하지 못했습니다. 녹음은 보존했습니다. 다시 시도할 수 있습니다: $error';
        });
      }
    } finally {
      if (submitted) await _removeFile(recordingPath);
      if (mounted && epoch == _sessionEpoch) setState(() => _busy = false);
    }
  }

  Future<void> _discardPending() async {
    final path = _recordingPath;
    setState(() {
      _recordingPath = null;
      _pendingDraft = null;
      _draftEditability.clear();
      _attachments.clear();
      _message = '대기 중인 녹음을 삭제했습니다.';
    });
    await _removeFile(path);
  }

  Future<void> _removeAttachment(int index) async {
    if (_busy || (!_recording && !_draftEditability.canEdit)) return;
    final draft = _pendingDraft;
    if (index < 0 || index >= _attachments.length) return;
    final nextAttachments = List<_PendingAttachment>.of(_attachments)
      ..removeAt(index);
    setState(() {
      _busy = true;
      _message = '첨부를 제거하고 대기 중인 녹음을 갱신하는 중…';
    });
    try {
      VoiceNoteDraft? nextDraft;
      if (draft != null) {
        final remaining = <VoiceTimelineAttachment>[];
        for (final entry in nextAttachments) {
          remaining.add(
            VoiceTimelineAttachment(
              kind: entry.kind,
              offsetMs: entry.offsetMs,
              mime: entry.mime,
              bytes: await File(entry.file.path).readAsBytes(),
            ),
          );
        }
        nextDraft = _service.createDraft(
          audio: draft.audio,
          audioMime: draft.audioMime,
          attachments: remaining,
          ownerUserSlug: draft.ownerUserSlug,
        );
      }
      if (!mounted) return;
      setState(() {
        _attachments
          ..clear()
          ..addAll(nextAttachments);
        if (draft != null) _pendingDraft = nextDraft;
        _draftEditability.attachmentRemoved();
        _message = '첨부 미디어를 타임라인에서 제거했습니다.';
      });
    } catch (error) {
      if (mounted) {
        setState(() => _message = '첨부를 제거하지 못했습니다. 기존 초안은 유지했습니다: $error');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _removeFile(String? path) async {
    if (path == null) return;
    try {
      await File(path).delete();
    } on FileSystemException {
      // A picker or recorder may already have removed its temporary file.
    }
  }

  @override
  void dispose() {
    unawaited(_recorder.dispose().catchError((_) {}));
    _httpClient.close();
    super.dispose();
  }

  Widget _summaryCard(VoiceNoteSummary summary) => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(summary.title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final point in summary.points)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text('• $point'),
            ),
          if (summary.failure != null) Text('처리 안내: ${summary.failure}'),
          if (summary.points.isEmpty && summary.failure == null)
            const Text('요약 결과를 기다리고 있습니다.'),
        ],
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: '음성 노트',
    theme: ThemeData(
      colorSchemeSeed: const Color(0xff3658a5),
      useMaterial3: true,
    ),
    home: Scaffold(
      appBar: AppBar(
        title: const Text('음성 노트'),
        actions: [
          if (_session != null)
            IconButton(
              onPressed: _busy ? null : _logout,
              tooltip: '로그아웃',
              icon: const Icon(Icons.logout),
            ),
        ],
      ),
      body: SafeArea(
        child: _busy && _session == null
            ? const Center(child: CircularProgressIndicator())
            : _session == null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(_message, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _busy ? null : _login,
                        child: const Text('Elanous 회원으로 로그인'),
                      ),
                    ],
                  ),
                ),
              )
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Text(_message),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _busy || !_canRetryPendingDraft
                        ? null
                        : (_recording
                              ? _finishRecording
                              : (_pendingDraft != null || _recordingPath != null
                                    ? _finishRecording
                                    : _startRecording)),
                    icon: Icon(_recording ? Icons.stop : Icons.mic),
                    label: Text(
                      _recording
                          ? '녹음 마치고 요약하기'
                          : (_pendingDraft != null || _recordingPath != null
                                ? '녹음 저장 다시 시도'
                                : '녹음 시작'),
                    ),
                  ),
                  if (!_canRetryPendingDraft)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text('이 대기 초안은 만든 회원 계정으로 로그인해야 저장할 수 있습니다.'),
                    ),
                  if (!_recording && _recordingPath != null)
                    TextButton(
                      onPressed: _busy ? null : _discardPending,
                      child: const Text('대기 중인 녹음 삭제'),
                    ),
                  if (_recording) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      children: [
                        OutlinedButton.icon(
                          onPressed: () => _attach('photo'),
                          icon: const Icon(Icons.photo),
                          label: const Text('사진 추가'),
                        ),
                        OutlinedButton.icon(
                          onPressed: () => _attach('video'),
                          icon: const Icon(Icons.video_library),
                          label: const Text('동영상 추가'),
                        ),
                      ],
                    ),
                  ],
                  for (var index = 0; index < _attachments.length; index++)
                    ListTile(
                      leading: Icon(
                        _attachments[index].kind == 'photo'
                            ? Icons.image_outlined
                            : Icons.movie_outlined,
                      ),
                      title: Text(_attachments[index].file.name),
                      subtitle: Text(
                        '${_attachments[index].kind} · ${_attachments[index].offsetMs} ms · ${_attachments[index].mime}',
                      ),
                      trailing: IconButton(
                        tooltip: '첨부 제거',
                        onPressed:
                            _busy || (!_recording && !_draftEditability.canEdit)
                            ? null
                            : () => _removeAttachment(index),
                        icon: const Icon(Icons.close),
                      ),
                    ),
                  if (_latest != null) ...[
                    const SizedBox(height: 12),
                    _summaryCard(_latest!),
                  ],
                  const Divider(height: 32),
                  Text(
                    '최근 음성 노트',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (_recent.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 16),
                      child: Text('저장된 음성 노트가 없습니다.'),
                    ),
                  for (final summary in _recent) _summaryCard(summary),
                ],
              ),
      ),
    ),
  );
}

void main() => runApp(const VoiceNoteApp());

Future<Uint8List> _readFileExactly(File file, int expectedLength) async {
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in file.openRead(0, expectedLength + 1)) {
    bytes.add(chunk);
    if (bytes.length > expectedLength) {
      throw StateError('file grew after its size preflight');
    }
  }
  final result = bytes.takeBytes();
  if (result.lengthInBytes != expectedLength) {
    throw StateError('file changed after its size preflight');
  }
  return result;
}
