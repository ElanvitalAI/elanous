import 'package:elanous_nexus/elanous_nexus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const originValue = String.fromEnvironment('NEXUS_APP_ORIGIN');
const nexusApiOrigin = String.fromEnvironment('NEXUS_API_ORIGIN',
    defaultValue: 'https://api.elanous.ai');
const allowLocalAppOrigin =
    bool.fromEnvironment('NEXUS_ALLOW_LOCAL_APP_ORIGIN');
const appSlug = 'lecture-scrap';
const storage = FlutterSecureStorage();
String sessionKey(Uri origin) =>
    'nexus.$appSlug.session.${Uri.encodeComponent(origin.origin)}';
String ownerBearerKey(Uri origin) =>
    'nexus.$appSlug.ownerBearer.${Uri.encodeComponent(origin.origin)}';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const LectureScrapApp());
}

class LectureScrapApp extends StatelessWidget {
  const LectureScrapApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '강의 노트 · 스크랩',
        theme: ThemeData(
            colorSchemeSeed: const Color(0xff3658a5), useMaterial3: true),
        home: const LibraryPage(),
      );
}

class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});
  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final sessionInput = TextEditingController();
  final search = TextEditingController();
  final originInput = TextEditingController(text: originValue);
  NexusAppClient? client;
  List<dynamic> scraps = [];
  List<dynamic> results = [];
  String? error;
  bool busy = false;
  int tab = 0;
  int _restoreEpoch = 0;

  Future<void> _verifyOwnerToken(Uri appOrigin, String token) async {
    final probe = NexusAppClient(
        origin: appOrigin,
        slug: appSlug,
        controlOrigin: Uri.parse(nexusApiOrigin),
        ownerBearerToken: token);
    try {
      final owner = await probe.verifyOwnerSession();
      final userSlug = owner['userSlug'];
      if (userSlug is! String ||
          !isVerifiedOwnerAppOrigin(
            appOrigin,
            appSlug: appSlug,
            userSlug: userSlug,
            allowLocalDevelopment: allowLocalAppOrigin,
          )) {
        throw const FormatException('앱 주소가 서버에서 확인한 소유자 주소와 일치하지 않습니다.');
      }
    } finally {
      probe.close();
    }
  }

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final epoch = ++_restoreEpoch;
    final savedOrigin = await storage.read(key: 'nexus.$appSlug.origin');
    if (!mounted || epoch != _restoreEpoch) return;
    final address = savedOrigin ?? originValue;
    if (address.isEmpty) return;
    originInput.text = address;
    final appOrigin = Uri.parse(address);
    var bearer = await storage.read(key: ownerBearerKey(appOrigin));
    if (!mounted || epoch != _restoreEpoch) return;
    if (bearer != null) {
      try {
        await _verifyOwnerToken(appOrigin, bearer);
        if (!mounted || epoch != _restoreEpoch) return;
      } on NexusApiException catch (failure) {
        if (!mounted || epoch != _restoreEpoch) return;
        if (failure.statusCode != 401) {
          if (mounted)
            setState(
                () => error = '서버 응답 ${failure.statusCode}: ${failure.code}');
          return;
        }
        await storage.delete(key: ownerBearerKey(appOrigin));
        bearer = null;
      } catch (failure) {
        if (!mounted || epoch != _restoreEpoch) return;
        if (mounted) setState(() => error = failure.toString());
        return;
      }
    }
    final cookie =
        bearer == null ? await storage.read(key: sessionKey(appOrigin)) : null;
    if (!mounted || epoch != _restoreEpoch) return;
    setState(() => client = NexusAppClient(
        origin: appOrigin,
        slug: appSlug,
        controlOrigin: Uri.parse(nexusApiOrigin),
        ownerBearerToken: bearer,
        sessionToken: cookie));
    if (bearer != null || cookie != null) await _refresh();
  }

  Future<void> _saveOrigin() => _run(() async {
        final epoch = ++_restoreEpoch;
        final address = Uri.parse(originInput.text.trim());
        final replacement = NexusAppClient(
            origin: address,
            slug: appSlug,
            controlOrigin: Uri.parse(nexusApiOrigin));
        final bearer = await storage.read(key: ownerBearerKey(address));
        final cookie = bearer == null
            ? await storage.read(key: sessionKey(address))
            : null;
        if (bearer != null) await _verifyOwnerToken(address, bearer);
        if (!mounted || epoch != _restoreEpoch) return;
        replacement.ownerBearerToken = bearer;
        replacement.sessionToken = cookie;
        await storage.write(
            key: 'nexus.$appSlug.origin', value: address.origin);
        client?.close();
        setState(() => client = replacement);
        if (bearer != null || cookie != null) await _refresh();
      });

  void _changeOrigin() {
    _restoreEpoch++;
    client?.close();
    setState(() {
      client = null;
      scraps = [];
      results = [];
      error = null;
    });
  }

  Future<void> _run(Future<void> Function() work,
      {bool authenticatedRequest = false}) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await work();
    } on NexusApiException catch (failure) {
      if (authenticatedRequest && failure.statusCode == 401) {
        await storage.delete(key: sessionKey(client!.origin));
        await storage.delete(key: ownerBearerKey(client!.origin));
        client?.ownerBearerToken = null;
        client?.sessionToken = null;
        scraps = [];
        results = [];
      }
      setState(() => error = '서버 응답 ${failure.statusCode}: ${failure.code}');
    } catch (failure) {
      setState(() => error = failure.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _attachSession() => _run(() async {
        final token = sessionInput.text.trim();
        if (token.isEmpty) throw const FormatException('앱 세션 토큰이 비어 있습니다.');
        final probe = NexusAppClient(
            origin: client!.origin,
            slug: appSlug,
            controlOrigin: Uri.parse(nexusApiOrigin),
            ownerBearerToken: token);
        try {
          await probe.verifyOwnerSession();
          scraps = await probe.rpc('listScraps', {'limit': 50});
        } finally {
          probe.close();
        }
        await storage.write(key: ownerBearerKey(client!.origin), value: token);
        await storage.delete(key: sessionKey(client!.origin));
        client!.ownerBearerToken = token;
        client!.sessionToken = null;
        results = [];
        sessionInput.clear();
        setState(() {});
      });

  Future<void> _refresh() => _run(() async {
        scraps = await client!.rpc('listScraps', {'limit': 50});
        setState(() {});
      }, authenticatedRequest: true);

  Future<void> _search() => _run(() async {
        results = await client!.rpc(
            'searchLibrary', {'query': '%${search.text.trim()}%', 'limit': 50});
        setState(() {});
      }, authenticatedRequest: true);

  Future<void> _addNote() async {
    final title = TextEditingController();
    final body = TextEditingController();
    final submitted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
              title: const Text('강의 노트 작성'),
              content: Column(mainAxisSize: MainAxisSize.min, children: [
                TextField(
                    controller: title,
                    decoration: const InputDecoration(labelText: '제목')),
                TextField(
                    controller: body,
                    maxLines: 5,
                    decoration: const InputDecoration(labelText: '내용')),
              ]),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('취소')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('저장')),
              ],
            ));
    if (submitted == true &&
        title.text.trim().isNotEmpty &&
        body.text.trim().isNotEmpty) {
      await _run(() async {
        await client!.rpc('addLectureNote', {
          'id': DateTime.now().microsecondsSinceEpoch.toString(),
          'title': title.text.trim(),
          'body': body.text.trim(),
          'created_at': DateTime.now().toUtc().toIso8601String(),
        });
        if (tab == 1)
          results = await client!.rpc('searchLibrary',
              {'query': '%${search.text.trim()}%', 'limit': 50});
        setState(() {});
      }, authenticatedRequest: true);
    }
    title.dispose();
    body.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (client == null)
      return Scaffold(
          body: SafeArea(
              child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Text('강의 노트 · 스크랩', style: TextStyle(fontSize: 24)),
                      const SizedBox(height: 20),
                      TextField(
                          controller: originInput,
                          decoration: const InputDecoration(
                              labelText: '넥서스 앱 주소',
                              hintText:
                                  'https://lecture-scrap--사용자.elanous.app')),
                      const SizedBox(height: 12),
                      FilledButton(
                          onPressed: busy ? null : _saveOrigin,
                          child: const Text('앱 연결 준비')),
                      if (error != null) Text(error!),
                    ],
                  ))));
    final connected =
        client!.ownerBearerToken != null || client!.sessionToken != null;
    return Scaffold(
      appBar: AppBar(title: const Text('강의 노트 · 스크랩'), actions: [
        IconButton(
            onPressed: busy ? null : _changeOrigin,
            icon: const Icon(Icons.settings),
            tooltip: '앱 주소 변경'),
        if (connected)
          IconButton(
              onPressed: busy ? null : _refresh,
              icon: const Icon(Icons.refresh),
              tooltip: '새로고침'),
      ]),
      body: SafeArea(
          child: Column(children: [
        if (!connected)
          Padding(
              padding: const EdgeInsets.all(16),
              child: Column(children: [
                const Text('발급된 앱 세션으로 연결하세요.'),
                TextField(
                    controller: sessionInput,
                    obscureText: true,
                    decoration:
                        const InputDecoration(labelText: '발급된 앱 세션 토큰')),
                TextButton(
                    onPressed: busy ? null : _attachSession,
                    child: const Text('앱 세션으로 연결')),
              ])),
        if (error != null)
          Padding(
              padding: const EdgeInsets.all(12),
              child: Text(error!,
                  style:
                      TextStyle(color: Theme.of(context).colorScheme.error))),
        if (busy) const LinearProgressIndicator(),
        if (connected)
          Expanded(
              child: tab == 0
                  ? _rows(scraps, '스크랩이 없습니다.')
                  : Column(children: [
                      Padding(
                          padding: const EdgeInsets.all(12),
                          child: Row(children: [
                            Expanded(
                                child: TextField(
                                    controller: search,
                                    decoration: const InputDecoration(
                                        labelText: '강의 자료와 노트 검색'),
                                    onSubmitted: (_) => _search())),
                            IconButton(
                                onPressed: busy ? null : _search,
                                icon: const Icon(Icons.search)),
                          ])),
                      Expanded(child: _rows(results, '검색 결과가 없습니다.')),
                    ])),
      ])),
      floatingActionButton: connected
          ? FloatingActionButton.extended(
              onPressed: busy ? null : _addNote,
              icon: const Icon(Icons.edit_note),
              label: const Text('노트 작성'))
          : null,
      bottomNavigationBar: connected
          ? NavigationBar(
              selectedIndex: tab,
              onDestinationSelected: (value) => setState(() => tab = value),
              destinations: const [
                  NavigationDestination(
                      icon: Icon(Icons.bookmark_outline), label: '스크랩 목록'),
                  NavigationDestination(icon: Icon(Icons.search), label: '검색')
                ])
          : null,
    );
  }

  Widget _rows(List<dynamic> rows, String empty) => rows.isEmpty
      ? Center(child: Text(empty))
      : ListView.builder(
          itemCount: rows.length,
          itemBuilder: (context, index) {
            final row = rows[index] is Map ? rows[index] as Map : const {};
            return ListTile(
                title: Text('${row['title'] ?? ''}'),
                subtitle: Text('${row['excerpt'] ?? row['body'] ?? ''}'),
                onTap: row['url'] == null
                    ? null
                    : () => showDialog<void>(
                        context: context,
                        builder: (context) => AlertDialog(
                                title: Text('${row['title'] ?? ''}'),
                                content: SelectableText('${row['url']}'),
                                actions: [
                                  TextButton(
                                      onPressed: () => Navigator.pop(context),
                                      child: const Text('닫기'))
                                ])));
          });

  @override
  void dispose() {
    client?.close();
    sessionInput.dispose();
    search.dispose();
    originInput.dispose();
    super.dispose();
  }
}
