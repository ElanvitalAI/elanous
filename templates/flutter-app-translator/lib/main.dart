import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:elanous_nexus/elanous_nexus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'recording_cleanup.dart';
import 'session_epoch.dart';

const apiOrigin = String.fromEnvironment('NEXUS_API_ORIGIN',
    defaultValue: 'https://api.elanous.ai');
const languages = ['한국어', 'English', '日本語', 'Français'];
const speechLanguageCodes = {
  '한국어': 'ko',
  'English': 'en',
  '日本語': 'ja',
  'Français': 'fr'
};

class NexusHttp implements AuthHttp {
  NexusHttp(this.client, this.origin);
  final http.Client client;
  final String origin;

  Uri _uri(String path) =>
      path.startsWith('https://') || path.startsWith('http://')
          ? Uri.parse(path)
          : Uri.parse('$origin$path');

  Map<String, dynamic> _decode(http.Response response) {
    Object? payload;
    try {
      payload = jsonDecode(response.body);
    } catch (_) {
      payload = null;
    }
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        payload is! Map<String, dynamic>) {
      if (response.statusCode == 401) throw const SessionExpiredException();
      throw StateError('Nexus request failed (${response.statusCode})');
    }
    return payload;
  }

  @override
  Future<Map<String, dynamic>> get(String path, {String? bearer}) async {
    final response = await client.get(_uri(path), headers: {
      if (bearer != null) 'authorization': 'Bearer $bearer',
    });
    return _decode(response);
  }

  @override
  Future<Map<String, dynamic>> post(String path, Map<String, Object?> body,
      {String? bearer, String? idempotencyKey}) async {
    final response = await client.post(_uri(path),
        headers: {
          'content-type': 'application/json',
          if (bearer != null) 'authorization': 'Bearer $bearer',
          if (idempotencyKey != null) 'idempotency-key': idempotencyKey,
        },
        body: jsonEncode(body));
    return _decode(response);
  }

  @override
  Future<void> putBytes(String url, Uint8List body,
      {required String contentType}) async {
    final response = await client.put(_uri(url),
        headers: {'content-type': contentType}, body: body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('Nexus upload failed (${response.statusCode})');
    }
  }
}

class SystemAuthBrowser implements AuthBrowser {
  @override
  Future<Uri> authorize(Uri url) async {
    final result = await FlutterWebAuth2.authenticate(
        url: url.toString(), callbackUrlScheme: 'elanous');
    return Uri.parse(result);
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

class SessionExpiredException implements Exception {
  const SessionExpiredException();
}

void main() => runApp(const TranslatorApp());

class TranslatorApp extends StatefulWidget {
  const TranslatorApp({super.key, this.auth, this.translator});
  final MemberAuth? auth;
  final NexusTranslatorApi? translator;
  @override
  State<TranslatorApp> createState() => _TranslatorAppState();
}

class _TranslatorAppState extends State<TranslatorApp> {
  late final http.Client _client = http.Client();
  late final NexusHttp _http = NexusHttp(_client, apiOrigin);
  late final MemberAuth _auth = widget.auth ??
      MemberAuth(
          http: _http,
          browser: SystemAuthBrowser(),
          vault: const SecureTokenVault(FlutterSecureStorage()),
          randomBytes: (length) {
            final random = Random.secure();
            return List<int>.generate(length, (_) => random.nextInt(256));
          });
  late final NexusTranslatorApi _translator = widget.translator ??
      NexusTranslatorApi(
          auth: _auth,
          http: _http,
          randomBytes: (length) {
            final random = Random.secure();
            return List<int>.generate(length, (_) => random.nextInt(256));
          });
  final _recorder = AudioRecorder();
  final _player = AudioPlayer();
  final _sourceText = TextEditingController();
  MemberSession? _session;
  String? _recordingPath;
  Timer? _expiryTimer;
  String _sourceLanguage = '한국어';
  String _targetLanguage = 'English';
  String _voiceId = '';
  String _translatedText = '';
  String _message = '로그인 후 음성을 번역하고 회원 계정에 기록을 저장할 수 있습니다.';
  List<TranslationRecord> _history = const [];
  bool _busy = true;
  bool _recording = false;
  final _sessionEpoch = SessionEpoch();

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    final generation = _sessionEpoch.capture();
    try {
      final session = await _auth.readSession();
      if (!mounted || !_sessionEpoch.isCurrent(generation)) return;
      setState(() => _session = session);
      _armExpiry(session);
      if (session != null)
        await _loadHistory(generation: generation, expectedSession: session);
    } finally {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _busy = false);
    }
  }

  void _armExpiry(MemberSession? session) {
    _expiryTimer?.cancel();
    if (session == null) return;
    final wait = session.expiresAt.difference(DateTime.now().toUtc());
    _expiryTimer = Timer(wait.isNegative ? Duration.zero : wait, () async {
      await _expireSession();
    });
  }

  Future<void> _login() async {
    setState(() {
      _busy = true;
      _message = '회원 로그인을 여는 중…';
    });
    try {
      final session = await _auth.login();
      if (!mounted) return;
      _sessionEpoch.invalidate();
      final generation = _sessionEpoch.capture();
      setState(() {
        _session = session;
        _message = '회원 계정에 연결했습니다.';
      });
      _armExpiry(session);
      await _loadHistory(generation: generation, expectedSession: session);
    } catch (_) {
      if (mounted) setState(() => _message = '로그인에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _logout({String message = '로그아웃했습니다.'}) async {
    final oldSession = _session;
    _auth.invalidateSession(oldSession);
    final wasRecording = _recording;
    final recordingPath = _recordingPath;
    await _sessionEpoch.endSession(
      clearMemberState: () {
        _expiryTimer?.cancel();
        _sourceText.clear();
        if (mounted)
          setState(() {
            _session = null;
            _history = const [];
            _translatedText = '';
            _voiceId = '';
            _recording = false;
            _recordingPath = null;
            _busy = true;
            _message = '회원 데이터를 정리하는 중…';
          });
      },
      cleanup: () async {
        try {
          await _auth.logout(expectedToken: oldSession?.token);
        } catch (_) {/* local state is already invalidated */}
        if (mounted)
          setState(() {
            _busy = false;
            _message = message;
          });
        unawaited(() async {
          if (wasRecording || recordingPath != null) {
            try {
              final stoppedPath = await _recorder.stop();
              await removeRecordedFile(stoppedPath ?? recordingPath);
              if (stoppedPath != recordingPath)
                await removeRecordedFile(recordingPath);
            } catch (_) {
              await removeRecordedFile(recordingPath);
            }
          }
          try {
            await _player.stop();
          } catch (_) {/* session state is already cleared */}
        }());
      },
    );
    if (mounted)
      setState(() {
        _busy = false;
        _message = message;
      });
  }

  Future<void> _loadHistory(
      {int? generation, MemberSession? expectedSession}) async {
    final requestGeneration = generation ?? _sessionEpoch.capture();
    final requestSession = expectedSession ?? _session;
    if (requestSession == null) return;
    try {
      final history = await _sessionEpoch.discardStale(requestGeneration,
          _translator.listHistory(expectedSession: requestSession));
      if (history == null) return;
      if (mounted && _sessionEpoch.isCurrent(requestGeneration))
        setState(() => _history = history);
    } on SessionExpiredException {
      if (_sessionEpoch.isCurrent(requestGeneration)) await _expireSession();
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(requestGeneration))
        setState(() => _message = '번역 기록을 불러오지 못했습니다.');
    }
  }

  Future<void> _startRecording() async {
    final generation = _sessionEpoch.capture();
    if (_session == null) return;
    String? path;
    try {
      if (!await _recorder.hasPermission()) {
        if (mounted && _sessionEpoch.isCurrent(generation))
          setState(() => _message = '마이크 권한이 필요합니다.');
        return;
      }
      if (!mounted || !_sessionEpoch.isCurrent(generation)) return;
      final dir = await getTemporaryDirectory();
      path =
          '${dir.path}/translator-${DateTime.now().microsecondsSinceEpoch}.wav';
      await _recorder.start(
          const RecordConfig(
              encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1),
          path: path);
      if (!mounted || !_sessionEpoch.isCurrent(generation)) {
        await removeRecordedFile(await _recorder.stop() ?? path);
        return;
      }
      if (mounted)
        setState(() {
          _recording = true;
          _recordingPath = path;
          _message = '녹음 중입니다. 다시 눌러 녹음을 마치세요.';
        });
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '녹음을 시작하지 못했습니다.');
      await removeRecordedFile(path);
    }
  }

  Future<void> _stopRecording() async {
    final generation = _sessionEpoch.capture();
    final expectedSession = _session;
    if (expectedSession == null) return;
    String? path;
    setState(() {
      _recording = false;
      _busy = true;
      _message = '음성을 받아쓰는 중…';
    });
    try {
      path = await _recorder.stop() ?? _recordingPath;
      if (_recordingPath == path) _recordingPath = null;
      if (path == null) throw StateError('recording file missing');
      final file = File(path);
      final bytes = await file.readAsBytes();
      await removeRecordedFile(path);
      if (!mounted || !_sessionEpoch.isCurrent(generation)) return;
      final transcript = await _sessionEpoch.discardStale(
          generation,
          _translator.transcribe(
              bytes, speechLanguageCodes[_sourceLanguage] ?? 'en',
              expectedSession: expectedSession));
      if (transcript == null || !mounted) return;
      _sourceText.text = transcript;
      if (mounted) setState(() => _message = '받아쓰기를 마쳤습니다. 번역을 눌러 계속하세요.');
    } on SessionExpiredException {
      if (_sessionEpoch.isCurrent(generation)) await _expireSession();
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '음성 받아쓰기에 실패했습니다.');
    } finally {
      await removeRecordedFile(path);
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _busy = false);
    }
  }

  Future<void> _translate() async {
    final generation = _sessionEpoch.capture();
    final expectedSession = _session;
    if (expectedSession == null) return;
    final source = _sourceText.text.trim();
    if (source.isEmpty) {
      setState(() => _message = '번역할 문장을 입력하거나 녹음해 주세요.');
      return;
    }
    setState(() {
      _busy = true;
      _message = '번역 중…';
    });
    try {
      final translation = await _sessionEpoch.discardStale(
          generation,
          _translator.translate(source, _sourceLanguage, _targetLanguage,
              expectedSession: expectedSession));
      if (translation == null || !mounted) return;
      setState(() => _translatedText = translation);
      await _translator.saveTranslation(
          sourceText: source,
          translatedText: translation,
          sourceLanguage: _sourceLanguage,
          targetLanguage: _targetLanguage,
          expectedSession: expectedSession);
      if (!_sessionEpoch.isCurrent(generation)) return;
      await _loadHistory(
          generation: generation, expectedSession: expectedSession);
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '번역과 회원 기록 저장을 마쳤습니다.');
    } on SessionExpiredException {
      if (_sessionEpoch.isCurrent(generation)) await _expireSession();
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '번역 또는 기록 저장에 실패했습니다.');
    } finally {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _busy = false);
    }
  }

  Future<void> _speak(String text) async {
    final generation = _sessionEpoch.capture();
    final expectedSession = _session;
    if (expectedSession == null) return;
    if (_voiceId.trim().isEmpty) {
      setState(() => _message = '읽어줄 voice ID를 입력해 주세요.');
      return;
    }
    setState(() {
      _busy = true;
      _message = '음성을 만드는 중…';
    });
    try {
      final result = await _translator.synthesize(text, _voiceId.trim(),
          expectedSession: expectedSession);
      if (!mounted || !_sessionEpoch.isCurrent(generation)) return;
      final base64Audio = result['audioBase64'];
      final mimeType = result['mimeType'];
      if (base64Audio is! String || mimeType is! String)
        throw const FormatException('invalid audio response');
      await _player
          .play(BytesSource(base64Decode(base64Audio), mimeType: mimeType));
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '음성 재생을 시작했습니다.');
    } on SessionExpiredException {
      if (_sessionEpoch.isCurrent(generation)) await _expireSession();
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '음성 재생에 실패했습니다.');
    } finally {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _busy = false);
    }
  }

  Future<void> _saveScrap(String text) async {
    final generation = _sessionEpoch.capture();
    final expectedSession = _session;
    if (expectedSession == null) return;
    setState(() {
      _busy = true;
      _message = '스크랩을 저장하는 중…';
    });
    try {
      final key =
          'flutter-${base64UrlEncode(List<int>.generate(18, (_) => Random.secure().nextInt(256))).replaceAll('=', '')}';
      await _auth.shareText(text,
          source: 'flutter-share',
          idempotencyKey: key,
          expectedSession: expectedSession);
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '회원 스크랩에 저장했습니다.');
    } on SessionExpiredException {
      if (_sessionEpoch.isCurrent(generation)) await _expireSession();
    } catch (_) {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _message = '스크랩 저장에 실패했습니다.');
    } finally {
      if (mounted && _sessionEpoch.isCurrent(generation))
        setState(() => _busy = false);
    }
  }

  Future<void> _expireSession() async {
    await _logout(message: '회원 세션이 만료되었거나 폐기되었습니다. 다시 로그인해 주세요.');
  }

  @override
  void dispose() {
    _expiryTimer?.cancel();
    _sourceText.dispose();
    unawaited(_recorder.dispose().catchError((_) {}));
    unawaited(_player.dispose().catchError((_) {}));
    _client.close();
    super.dispose();
  }

  Widget _languagePicker(
          String label, String value, ValueChanged<String?> onChanged) =>
      DropdownButtonFormField<String>(
          // ignore: deprecated_member_use
          value: value,
          decoration: InputDecoration(labelText: label),
          items: languages
              .map((language) =>
                  DropdownMenuItem(value: language, child: Text(language)))
              .toList(),
          onChanged: _busy ? null : onChanged);

  @override
  Widget build(BuildContext context) => MaterialApp(
      title: '나만의 음성 번역기',
      theme: ThemeData(
          colorSchemeSeed: const Color(0xff315c4e), useMaterial3: true),
      home: Scaffold(
          appBar: AppBar(title: const Text('나만의 음성 번역기'), actions: [
            if (_session != null)
              IconButton(
                  onPressed: _logout,
                  tooltip: '로그아웃',
                  icon: const Icon(Icons.logout)),
          ]),
          body: SafeArea(
              child: _session == null
                  ? Center(
                      child: Padding(
                          padding: const EdgeInsets.all(24),
                          child:
                              Column(mainAxisSize: MainAxisSize.min, children: [
                            const Text('회원 계정에 번역 기록을 저장하세요.',
                                textAlign: TextAlign.center),
                            const SizedBox(height: 16),
                            Text(_message),
                            const SizedBox(height: 16),
                            FilledButton(
                                onPressed: _busy ? null : _login,
                                child:
                                    Text(_busy ? '연결 중…' : 'Elanous 회원으로 로그인')),
                          ])))
                  : ListView(padding: const EdgeInsets.all(20), children: [
                      Text(_message),
                      const SizedBox(height: 12),
                      Row(children: [
                        Expanded(
                            child: _languagePicker(
                                '말한 언어',
                                _sourceLanguage,
                                (value) =>
                                    setState(() => _sourceLanguage = value!))),
                        const SizedBox(width: 12),
                        Expanded(
                            child: _languagePicker(
                                '번역 언어',
                                _targetLanguage,
                                (value) =>
                                    setState(() => _targetLanguage = value!)))
                      ]),
                      const SizedBox(height: 12),
                      TextField(
                          controller: _sourceText,
                          minLines: 3,
                          maxLines: 6,
                          decoration: const InputDecoration(
                              labelText: '번역할 문장',
                              border: OutlineInputBorder())),
                      const SizedBox(height: 8),
                      Wrap(spacing: 8, children: [
                        OutlinedButton.icon(
                            onPressed: _busy
                                ? null
                                : (_recording
                                    ? _stopRecording
                                    : _startRecording),
                            icon: Icon(_recording ? Icons.stop : Icons.mic),
                            label: Text(_recording ? '녹음 완료' : '음성 녹음')),
                        FilledButton.icon(
                            onPressed: _busy || _recording ? null : _translate,
                            icon: const Icon(Icons.translate),
                            label: const Text('번역')),
                      ]),
                      if (_translatedText.isNotEmpty) ...[
                        const SizedBox(height: 18),
                        const Text('번역 결과',
                            style: TextStyle(fontWeight: FontWeight.bold)),
                        SelectableText(_translatedText),
                        Wrap(spacing: 8, children: [
                          OutlinedButton.icon(
                              onPressed:
                                  _busy ? null : () => _speak(_translatedText),
                              icon: const Icon(Icons.volume_up),
                              label: const Text('읽어주기')),
                          OutlinedButton.icon(
                              onPressed: _busy
                                  ? null
                                  : () => _saveScrap(_translatedText),
                              icon: const Icon(Icons.bookmark_add),
                              label: const Text('스크랩 저장')),
                        ]),
                      ],
                      TextField(
                          onChanged: (value) => _voiceId = value,
                          decoration: const InputDecoration(
                              labelText: '기록 재생 voice ID')),
                      const Divider(height: 36),
                      const Text('번역 기록',
                          style: TextStyle(fontWeight: FontWeight.bold)),
                      if (_history.isEmpty)
                        const Padding(
                            padding: EdgeInsets.symmetric(vertical: 12),
                            child: Text('저장된 번역이 없습니다.')),
                      for (final record in _history)
                        Card(
                            child: ListTile(
                                title: Text(record.translatedText),
                                subtitle: Text(
                                    '${record.sourceLanguage} → ${record.targetLanguage}\n${record.sourceText}'),
                                isThreeLine: true,
                                trailing: IconButton(
                                    onPressed: _busy
                                        ? null
                                        : () => _speak(record.translatedText),
                                    icon: const Icon(Icons.volume_up)))),
                    ]))));
}
