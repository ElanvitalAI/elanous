import 'dart:io';

Future<void> removeRecordedFile(String? path) async {
  if (path == null) return;
  try {
    await File(path).delete();
  } on FileSystemException {/* already removed or unavailable */}
}
