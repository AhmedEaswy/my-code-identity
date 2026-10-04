import 'dart:io';

import 'package:drift/drift.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'job_controller.dart';
import 'pos_database.dart';

/// The 16 bytes a SQLite 3 main database file must begin with.
const List<int> _sqliteMagic = <int>[
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

/// Parents before children. A merge copies in this order so a child row never
/// lands before the parent it references. Kept in one place because the copy
/// and the integrity pass must agree on it.
const List<String> kTableMergeOrder = <String>[
  'roles',
  'locations',
  'categories',
  'items',
  'item_categories',
  'stock_levels',
  'accounts',
  'sales',
  'sale_lines',
  'payments',
  'refunds',
  'refund_lines',
  'settings',
];

/// What a merge did, so the UI can say "restored 11 tables, skipped 2" instead
/// of a bare success that hides a shape mismatch.
class RestoreStats {
  const RestoreStats({
    required this.tablesCopied,
    required this.tablesSkipped,
    required this.skippedTables,
  });

  final int tablesCopied;
  final int tablesSkipped;
  final List<String> skippedTables;
}

/// Reads a candidate backup and applies it to the live database. A merge runs
/// beside the app through an attached database; a replace closes the app's
/// connection and swaps the file on disk. Both refuse to touch the live data
/// until the candidate has been read and proven.
class RestoreEngine {
  RestoreEngine(this._db);

  final PosDatabase _db;

  /// Rejects anything that is not a SQLite main database before a connection is
  /// opened on it. A cloud download, a shared file, and a picked document are
  /// all untrusted; the header is the cheapest possible first gate.
  static Future<void> verifyHeader(String path) async {
    final file = File(path);
    if (!await file.exists()) {
      throw const FormatException('backup_missing');
    }
    final raf = await file.open(mode: FileMode.read);
    try {
      final header = await raf.read(_sqliteMagic.length);
      if (header.length != _sqliteMagic.length) {
        throw const FormatException('backup_truncated');
      }
      for (var i = 0; i < _sqliteMagic.length; i++) {
        if (header[i] != _sqliteMagic[i]) {
          throw const FormatException('backup_not_sqlite');
        }
      }
    } finally {
      await raf.close();
    }
  }

  /// Runs SQLite's own consistency checks against [path] while it is attached
  /// as a side database — the rows are audited by SQLite, never loaded into the
  /// Dart heap.
  Future<void> verifyIntegrity(String path) async {
    await _db.customStatement("ATTACH DATABASE '${_quote(path)}' AS incoming");
    try {
      final structure =
          await _db.customSelect('PRAGMA incoming.integrity_check').get();
      if (structure.length != 1 ||
          structure.first.data['integrity_check'] != 'ok') {
        throw const FormatException('backup_corrupt');
      }

      // A file can be internally consistent yet reference rows that are not
      // there. This is the check that protects the app's own foreign keys.
      final orphans =
          await _db.customSelect('PRAGMA incoming.foreign_key_check').get();
      if (orphans.isNotEmpty) {
        throw const FormatException('backup_orphaned_rows');
      }
    } finally {
      await _db.customStatement('DETACH DATABASE incoming');
    }
  }

  /// Merge [path] into the live database. Existing rows are replaced or left
  /// alone according to [preferIncoming]; nothing is ever deleted.
  Future<RestoreStats> merge(
    String path, {
    required bool preferIncoming,
    BackupProgress? progress,
  }) async {
    await verifyHeader(path);
    await verifyIntegrity(path);

    // ATTACH cannot run inside a transaction, so it brackets the copy. And
    // `PRAGMA foreign_keys` is a silent no-op inside BEGIN, so it brackets the
    // transaction rather than living within it: under OR REPLACE, enforcing
    // keys would cascade-delete children copied earlier in the same pass.
    await _db.customStatement("ATTACH DATABASE '${_quote(path)}' AS incoming");
    try {
      await _db.customStatement('PRAGMA foreign_keys = OFF');
      try {
        return await _db.transaction(
          () => _copyTables(preferIncoming: preferIncoming, progress: progress),
        );
      } finally {
        await _db.customStatement('PRAGMA foreign_keys = ON');
      }
    } finally {
      await _db.customStatement('DETACH DATABASE incoming');
    }
  }

  Future<RestoreStats> _copyTables({
    required bool preferIncoming,
    BackupProgress? progress,
  }) async {
    final incomingTables = await _tableNames('incoming');
    final mainTables = await _tableNames('main');

    final copied = <String>[];
    final skipped = <String>[];
    final verb = preferIncoming ? 'OR REPLACE' : 'OR IGNORE';

    for (var i = 0; i < kTableMergeOrder.length; i++) {
      final table = kTableMergeOrder[i];
      await progress?.checkCancelled();
      progress?.report(i, kTableMergeOrder.length, label: table);

      if (!incomingTables.contains(table) || !mainTables.contains(table)) {
        skipped.add(table);
        continue;
      }

      final mainColumns = await _columns('main', table);
      final incomingColumns = await _columns('incoming', table);

      // Compare shapes before writing. A rename, add, or drop between app
      // versions must not be force-fit; report the table and leave it alone.
      if (!_sameSet(mainColumns, incomingColumns)) {
        skipped.add(table);
        continue;
      }

      // Name every column instead of `SELECT *`, so a differing physical column
      // order cannot silently shuffle values into the wrong fields.
      final list = mainColumns.map((c) => '"$c"').join(', ');
      await _db.customStatement(
        'INSERT $verb INTO main."$table" ($list) '
        'SELECT $list FROM incoming."$table"',
      );
      copied.add(table);
    }

    return RestoreStats(
      tablesCopied: copied.length,
      tablesSkipped: skipped.length,
      skippedTables: skipped,
    );
  }

  /// Replace the live database with [path]. The existing file is only touched
  /// after the candidate has been read and proven; the swap itself is a close,
  /// a sidecar cleanup, and a copy — nothing more.
  Future<void> replace(
    String path, {
    required Future<void> Function() releaseDatabase,
    BackupProgress? progress,
  }) async {
    // Verify while the live connection still exists: a replace has no second
    // chance, so everything that can be checked happens before the close.
    await verifyHeader(path);
    await verifyIntegrity(path);

    await progress?.checkCancelled();
    await releaseDatabase();
    await progress?.checkCancelled();

    final dbPath = await liveDatabasePath();

    // Delete the sidecars before copying. In WAL mode `-wal`/`-shm` hold pages
    // that were never checkpointed into the main file; left in place, SQLite
    // could replay the OLD log over the NEW database on next open. The stale
    // `-journal` is the same hazard under the rollback-journal mode.
    for (final suffix in const ['', '-wal', '-shm', '-journal']) {
      final sidecar = File('$dbPath$suffix');
      if (await sidecar.exists()) {
        await sidecar.delete();
      }
    }

    await File(path).copy(dbPath);
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  static Future<String> liveDatabasePath() async {
    final dir = await getApplicationSupportDirectory();
    return p.join(dir.path, 'pos.sqlite');
  }

  Future<Set<String>> _tableNames(String schema) async {
    final rows = await _db.customSelect(
      "SELECT name FROM $schema.sqlite_master "
      "WHERE type = 'table' "
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_drift_%'",
    ).get();
    return rows.map((r) => r.data['name'] as String).toSet();
  }

  Future<Set<String>> _columns(String schema, String table) async {
    final rows =
        await _db.customSelect('PRAGMA $schema.table_info("$table")').get();
    return rows.map((r) => r.data['name'] as String).toSet();
  }

  static bool _sameSet(Set<String> a, Set<String> b) =>
      a.length == b.length && a.containsAll(b);

  /// Escapes a filesystem path for use as a single-quoted SQLite string.
  static String _quote(String path) => path.replaceAll("'", "''");
}
