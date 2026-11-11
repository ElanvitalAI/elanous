/// Prevents async work from an expired member session from updating a later session.
class SessionEpoch {
  int _value = 0;

  int capture() => _value;
  bool isCurrent(int value) => value == _value;
  void invalidate() => _value++;

  Future<T?> discardStale<T>(int value, Future<T> operation) async {
    final result = await operation;
    return isCurrent(value) ? result : null;
  }

  Future<void> endSession({
    required void Function() clearMemberState,
    required Future<void> Function() cleanup,
  }) async {
    invalidate();
    clearMemberState();
    await cleanup();
  }
}
