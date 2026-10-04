import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Raised when the operator cancels an in-flight backup or restore, or when the
/// platform stops a background task. It is a *control-flow signal*, not a
/// failure, so callers must never report it as one.
class BackupCancelledException implements Exception {
  const BackupCancelledException(this.stage);

  /// The named checkpoint that observed the cancel, for diagnostics only.
  final String stage;

  @override
  String toString() => 'BackupCancelledException(stage: $stage)';
}

/// What a long job is allowed to know about whatever started it: where to post
/// progress, and whether a cancel has been requested. Keeping the job behind
/// this interface is what lets the same restore run under the UI or inside an
/// OS-spawned isolate.
abstract interface class BackupProgress {
  void report(int current, int total, {String? label});
  Future<void> checkCancelled();
}

/// Drives one long job and owns its notification. An instance is created on
/// whichever isolate runs the job — the UI thread for a foreground restore, or
/// a fresh background isolate — so it deliberately holds no shared state.
class BackupJobController implements BackupProgress {
  BackupJobController({
    required this.channelId,
    this.onCancelRequested,
  });

  /// Channel the progress and outcome notifications are posted to.
  final String channelId;

  /// Optional poll for a cancel that originates outside this isolate, e.g. a
  /// platform task the OS has decided to stop.
  final Future<void> Function()? onCancelRequested;

  final FlutterLocalNotificationsPlugin _notifications =
      FlutterLocalNotificationsPlugin();

  /// One live job notification at a time; a second job replaces the first.
  final int _notificationId = 0x0B;

  bool _cancelled = false;
  String _stage = '';

  bool get isCancelled => _cancelled;

  /// Requests cancellation. Idempotent, and safe to call from any isolate that
  /// can reach this instance.
  void cancel() => _cancelled = true;

  @override
  Future<void> checkCancelled() async {
    if (_cancelled) {
      throw BackupCancelledException(_stage);
    }
    // A background isolate may be told to stop by the platform rather than by
    // this controller; give that path a chance to surface here.
    await onCancelRequested?.call();
  }

  @override
  void report(int current, int total, {String? label}) {
    _stage = label ?? _stage;
    // Fire-and-forget: a progress post must never slow the copy down or fail
    // the job if the notification service is briefly unavailable.
    unawaited(_postProgress(current, total, _stage));
  }

  /// Runs [action] under one notification lifecycle. Success, cancellation, and
  /// failure each post their own outcome, so the UI never has to infer which
  /// happened from a missing notification.
  Future<void> run(
    String title,
    Future<void> Function(BackupProgress progress) action,
  ) async {
    await _postProgress(0, 1, title);
    try {
      await action(this);
      await _postDone(title);
    } on BackupCancelledException {
      await _postCancelled(title);
      rethrow;
    } catch (error) {
      await _postError(title, error);
      rethrow;
    }
  }

  // ── Notification plumbing ──────────────────────────────────────────────────

  Future<void> _postProgress(int current, int total, String? label) async {
    final details = AndroidNotificationDetails(
      channelId,
      'Backup jobs',
      channelDescription: 'Progress for local and cloud backups and restores.',
      importance: Importance.low,
      priority: Priority.low,
      onlyAlertOnce: true,
      showProgress: true,
      maxProgress: total,
      progress: current,
      ongoing: true,
    );
    await _notifications.show(
      _notificationId,
      label ?? 'Backup',
      '$current / $total',
      NotificationDetails(android: details),
    );
  }

  Future<void> _postDone(String title) => _notifications.show(
        _notificationId,
        title,
        'Finished successfully',
        NotificationDetails(
          android: AndroidNotificationDetails(channelId, 'Backup jobs'),
        ),
      );

  Future<void> _postCancelled(String title) => _notifications.show(
        _notificationId,
        title,
        'Stopped by the user',
        NotificationDetails(
          android: AndroidNotificationDetails(channelId, 'Backup jobs'),
        ),
      );

  Future<void> _postError(String title, Object error) => _notifications.show(
        _notificationId,
        title,
        'Failed: $error',
        NotificationDetails(
          android: AndroidNotificationDetails(channelId, 'Backup jobs'),
        ),
      );
}
