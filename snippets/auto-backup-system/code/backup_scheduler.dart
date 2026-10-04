import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:workmanager/workmanager.dart';

import 'cloud_backup_runner.dart';
import 'job_controller.dart';
import 'local_backup_runner.dart';
import 'pos_database.dart';
import 'restore_engine.dart';

/// Unique names are also the cancellation handles. Cancelling the old name
/// before registering the new one is what stops a changed schedule from leaving
/// two cadences running at once.
const String kCloudPeriodicTask = 'posCloudPeriodicBackup';
const String kLocalPeriodicTask = 'posLocalPeriodicBackup';
const String kRestoreImportTask = 'posRestoreImport';

const String kBackupChannelId = 'pos_backup_jobs';

/// Mirrors the settings screen into OS-scheduled work: off means cancel, on
/// means register at the chosen interval, and a Wi-Fi-only preference becomes a
/// network constraint the OS enforces on its own.
Future<void> syncCloudBackupSchedule(BackupPreferences prefs) async {
  if (kIsWeb || !Platform.isAndroid) return;

  await Workmanager().cancelByUniqueName(kCloudPeriodicTask);

  final hours = normalizeIntervalHours(prefs.cloudIntervalHours);
  if (hours <= 0) return;

  await Workmanager().registerPeriodicTask(
    kCloudPeriodicTask,
    kCloudPeriodicTask,
    frequency: Duration(hours: hours),
    initialDelay: durationUntilNextWindow(),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
    constraints: Constraints(
      networkType:
          prefs.unmeteredOnly ? NetworkType.unmetered : NetworkType.connected,
    ),
  );
}

/// Registers the local safety-net backup. It has no network constraint, because
/// it must still run when the device is offline for days.
Future<void> syncLocalBackupSchedule(BackupPreferences prefs) async {
  if (kIsWeb || !Platform.isAndroid) return;

  await Workmanager().cancelByUniqueName(kLocalPeriodicTask);

  final hours = normalizeIntervalHours(prefs.localIntervalHours);
  if (hours <= 0) return;

  await Workmanager().registerPeriodicTask(
    kLocalPeriodicTask,
    kLocalPeriodicTask,
    frequency: Duration(hours: hours),
    initialDelay: durationUntilNextWindow(),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
    constraints: const Constraints(networkType: NetworkType.notRequired),
  );
}

/// Enqueues a full database restore. `keep` means a second tap cannot replace
/// the restore the operator already asked for.
Future<void> enqueueRestoreImport({required String path, required bool replace}) {
  if (kIsWeb || !Platform.isAndroid) return Future<void>.value();
  return Workmanager().registerOneOffTask(
    kRestoreImportTask,
    kRestoreImportTask,
    existingWorkPolicy: ExistingWorkPolicy.keep,
    inputData: <String, dynamic>{'path': path, 'replace': replace},
    constraints: const Constraints(networkType: NetworkType.notRequired),
  );
}

/// The task entry point. The OS starts this in a *fresh isolate*, so it holds
/// no main-isolate state: it opens its own database, builds its own controller,
/// and closes the database before returning — on every path, including failure.
@pragma('vm:entry-point')
void backupCallbackDispatcher() {
  Workmanager().executeTask((taskName, inputData) async {
    WidgetsFlutterBinding.ensureInitialized();

    // A restore may have been requested while the app was open and run after a
    // force-stop. It must not depend on backups being enabled, so it is handled
    // before the feature gate.
    final isRestore = taskName == kRestoreImportTask;
    if (!isRestore && !AppFeatureFlags.autoBackups) {
      return true;
    }

    final db = openPosDatabase();
    final progress = BackupJobController(channelId: kBackupChannelId);
    var dbClosed = false;

    try {
      switch (taskName) {
        case kRestoreImportTask:
          final path = inputData!['path'] as String;
          final replace = inputData['replace'] == true;
          await progress.run('Restoring database', (p) async {
            final engine = RestoreEngine(db);
            if (replace) {
              await engine.replace(
                path,
                releaseDatabase: () async {
                  // In a background isolate there are no UI subscriptions, so
                  // this is only the close. The foreground flow passes the same
                  // shape but invalidates its database provider first, so stream
                  // watchers cancel before the connection is torn down.
                  await db.close().timeout(const Duration(seconds: 8));
                  dbClosed = true;
                },
                progress: p,
              );
            } else {
              await engine.merge(
                path,
                preferIncoming: inputData['preferIncoming'] == true,
                progress: p,
              );
            }
          });
        case kLocalPeriodicTask:
          await progress.run('Local backup', (p) => runLocalBackupIfDue(db, p));
        case kCloudPeriodicTask:
          await progress.run('Cloud backup', (p) => runCloudBackupIfDue(db, p));
      }
    } on BackupCancelledException {
      // A deliberate stop is not a retryable failure; the controller has
      // already told the user. Swallow it so the platform does not re-run it.
    } catch (_) {
      // The controller posted the failure with its message; there is nothing
      // useful to hand back to the OS here.
    } finally {
      if (!dbClosed) {
        await db.close();
      }
    }

    // Acknowledge regardless of outcome: retries belong to the schedule, not to
    // the platform re-running a task that already reported its result.
    return true;
  });
}
