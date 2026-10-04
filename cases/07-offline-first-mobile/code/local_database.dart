import 'dart:io';

import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics_dao.dart';
import 'sales_dao.dart';

part 'local_database.g.dart';

// ── Schema ─────────────────────────────────────────────────────────────────
//
// These table classes describe the *current* shape of the database, i.e. the
// shape a fresh install gets. Every column that only exists after a later
// migration must be declared here, and every column a migration removed must
// not be. The upgrade path below has to land on exactly this shape.

class Operators extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get name => text()();
  TextColumn get email => text().unique()();
  BoolColumn get isActive => boolean().withDefault(const Constant(true))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Partners extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get name => text()();
  TextColumn get phone => text()();
  TextColumn get address => text().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Locations extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get name => text()();
  BoolColumn get isActive => boolean().withDefault(const Constant(true))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Groups extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get name => text()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Tags extends Table {
  IntColumn get id => integer().autoIncrement()();
  TextColumn get name => text()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Subgroups extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get groupId => integer().references(Groups, #id)();
  TextColumn get name => text()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class ItemSubgroups extends Table {
  IntColumn get itemId => integer().references(Items, #id)();
  IntColumn get subgroupId => integer().references(Subgroups, #id)();

  @override
  Set<Column> get primaryKey => {itemId, subgroupId};
}

class Items extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get groupId =>
      integer().nullable().references(Groups, #id, onDelete: KeyAction.setNull)();
  IntColumn get tagId =>
      integer().nullable().references(Tags, #id, onDelete: KeyAction.setNull)();
  TextColumn get name => text()();
  TextColumn get description => text().nullable()();
  TextColumn get imagePath => text().nullable()();
  RealColumn get listPrice => real().withDefault(const Constant(0))();
  RealColumn get costPrice => real().nullable()();
  RealColumn get wholesalePrice => real().nullable()();
  RealColumn get costChangePercent => real().nullable()();
  RealColumn get retailChangePercent => real().nullable()();
  RealColumn get wholesaleChangePercent => real().nullable()();
  BoolColumn get isActive => boolean().withDefault(const Constant(true))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class StockLevels extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get itemId => integer().references(Items, #id)();
  IntColumn get locationId =>
      integer().nullable().references(Locations, #id, onDelete: KeyAction.setNull)();
  IntColumn get quantity => integer().withDefault(const Constant(0))();
  IntColumn get soldQuantity => integer().withDefault(const Constant(0))();
  BoolColumn get isDefault => boolean().withDefault(const Constant(false))();
  RealColumn get price => real().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class Sales extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get locationId =>
      integer().nullable().references(Locations, #id, onDelete: KeyAction.setNull)();
  IntColumn get partnerId =>
      integer().nullable().references(Partners, #id, onDelete: KeyAction.setNull)();
  IntColumn get createdByUserId => integer().nullable()();
  TextColumn get customerName => text().nullable()();
  TextColumn get phone => text().nullable()();
  TextColumn get addressSnapshot => text().nullable()();
  RealColumn get discountValue => real().withDefault(const Constant(0))();
  TextColumn get discountKind => text().nullable()();
  RealColumn get taxPercent => real().withDefault(const Constant(0))();
  TextColumn get pricingMode => text().withDefault(const Constant('retail'))();
  BoolColumn get isPaid => boolean().withDefault(const Constant(false))();
  RealColumn get paidAmount => real().withDefault(const Constant(0))();
  TextColumn get paymentMethod => text().nullable()();
  TextColumn get notes => text().nullable()();
  TextColumn get documentKind => text().withDefault(const Constant('receipt'))();
  BoolColumn get isDraft => boolean().withDefault(const Constant(false))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class SaleLines extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get saleId => integer().references(Sales, #id)();
  IntColumn get itemId => integer().references(Items, #id)();
  IntColumn get stockId => integer().nullable()();
  IntColumn get quantity => integer()();
  RealColumn get unitPrice => real()();
  RealColumn get discountPerUnit => real().withDefault(const Constant(0))();
  RealColumn get changePercent => real().withDefault(const Constant(0))();
  BoolColumn get changeIsPositive => boolean().withDefault(const Constant(true))();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();
}

class SalePayments extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get saleId => integer().references(Sales, #id)();
  RealColumn get amount => real()();
  TextColumn get notes => text().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}

class Returns extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get saleId => integer().references(Sales, #id)();
  IntColumn get createdByUserId => integer().nullable()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
  DateTimeColumn get deletedAt => dateTime().nullable()();
}

class ReturnLines extends Table {
  IntColumn get id => integer().autoIncrement()();
  IntColumn get returnId => integer().references(Returns, #id)();
  IntColumn get saleLineId => integer().references(SaleLines, #id)();
  IntColumn get quantity => integer()();
  RealColumn get amount => real()();
  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();
}

@DriftDatabase(
  tables: [
    Operators,
    Partners,
    Locations,
    Groups,
    Tags,
    Subgroups,
    ItemSubgroups,
    Items,
    StockLevels,
    Sales,
    SaleLines,
    SalePayments,
    Returns,
    ReturnLines,
  ],
  daos: [SalesDao, AnalyticsDao],
)
class LocalDatabase extends _$LocalDatabase {
  LocalDatabase.connect(QueryExecutor executor) : super(executor);

  /// Opens (or creates) the SQLite file directly. Handy for tooling and tests.
  LocalDatabase.openFile(String path) : super(NativeDatabase(File(path)));

  @override
  int get schemaVersion => 24;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (final m) async {
          await m.createAll();
          await _seedBaseData();
        },
        onUpgrade: (final m, final from, final to) async {
          // Each step is guarded by the *starting* version, never by the
          // current one, so a device that skipped releases still replays every
          // step in order. A step must be safe to run on a database that is
          // already half-upgraded — that is why the helpers swallow the
          // "already exists" / "no such column" errors instead of trusting
          // that the schema on disk matches what the version number claims.
          if (from < 2) {
            await _rebuildSalesWithoutNotNull();
          }
          if (from < 3) {
            await _addColumnSafe(m, stockLevels, stockLevels.soldQuantity);
          }
          if (from < 4) {
            await _addColumnSafe(m, items, items.imagePath);
          }
          if (from < 5) {
            await _createPerformanceIndexes();
          }
          if (from < 6) {
            await m.createTable(groups);
            await m.createTable(tags);
            await m.createTable(subgroups);
            await m.createTable(itemSubgroups);
            await _addColumnSafe(m, items, items.tagId);
            await _backfillGroupsFromLegacyItems();
            // An index that still names category_id blocks DROP COLUMN, so it
            // has to go first — the error SQLite raises otherwise reads like a
            // missing-column fault, not an index dependency.
            await customStatement('DROP INDEX IF EXISTS idx_items_category');
            await _dropColumnSafe('items', 'category_id');
            await customStatement(
              'CREATE INDEX IF NOT EXISTS idx_items_group ON items (group_id)',
            );
          }
          if (from < 7) {
            await m.createTable(returns);
            await m.createTable(returnLines);
          }
          if (from < 8) {
            await m.createTable(partners);
            await _addColumnSafe(m, sales, sales.partnerId);
            await _backfillPartnersFromSales();
          }
          if (from < 9) {
            await _splitChangePercentByPricingMode(m);
          }
          if (from < 10) {
            await _normalizeLegacySecondsToMillis();
          }
          if (from < 11) {
            // The line discount used to be stored as a line total; from 11 it
            // is per unit, so every stored total is divided by its quantity.
            await customStatement('''
UPDATE sale_lines
SET discount_per_unit = discount_per_unit / quantity
WHERE quantity > 0 AND discount_per_unit != 0
''');
          }
          if (from < 12) {
            await _addColumnSafe(m, sales, sales.addressSnapshot);
            await _backfillAddressSnapshot();
          }
          if (from < 13) {
            await _replaceWholesaleFlagWithPricingMode(m);
          }
          if (from < 14) {
            await _addColumnSafe(m, saleLines, saleLines.changePercent);
            await _addColumnSafe(m, saleLines, saleLines.changeIsPositive);
            await _backfillLineChangePercentsFromPrices();
          }
        },
        beforeOpen: (final details) async {
          await customStatement('PRAGMA foreign_keys = ON');
          if (details.wasCreated) {
            await customStatement('PRAGMA journal_mode = WAL');
          }
        },
      );

  /// Adds a column, treating a re-run as a no-op.
  ///
  /// Drift's generated migration already knows how to add a column; the only
  /// thing this wrapper adds is forgiveness. A device that crashed between
  /// "add column" and "record the new version" would otherwise be unable to
  /// start, because the retry would hit "duplicate column name".
  Future<void> _addColumnSafe(
    final Migrator m,
    final TableInfo<Table, dynamic> table,
    final GeneratedColumn column,
  ) async {
    try {
      await m.addColumn(table, column);
    } catch (e) {
      if (e.toString().contains('duplicate column')) return;
      rethrow;
    }
  }

  Future<void> _dropColumnSafe(final String table, final String column) async {
    try {
      await customStatement('ALTER TABLE $table DROP COLUMN $column');
    } catch (e) {
      if (e.toString().contains('no such column')) return;
      rethrow;
    }
  }

  /// SQLite cannot relax a NOT NULL constraint with ALTER TABLE, so the table
  /// is recreated. Foreign keys are switched off for the swap: a temporary
  /// name must not be allowed to orphan the child rows that point at it.
  Future<void> _rebuildSalesWithoutNotNull() async {
    await customStatement('PRAGMA foreign_keys = OFF');
    await customStatement('''
CREATE TABLE sales_new (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NULL REFERENCES locations (id) ON DELETE SET NULL,
  phone TEXT NULL,
  customer_name TEXT NULL,
  discount_value REAL NOT NULL DEFAULT 0,
  tax_percent REAL NOT NULL DEFAULT 0,
  is_wholesale INTEGER NOT NULL DEFAULT 0,
  is_paid INTEGER NOT NULL DEFAULT 0,
  paid_amount REAL NOT NULL DEFAULT 0,
  notes TEXT NULL,
  document_kind TEXT NOT NULL DEFAULT 'receipt',
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NULL
)
''');
    await customStatement('''
INSERT INTO sales_new (
  id, location_id, phone, customer_name, discount_value, tax_percent,
  is_wholesale, is_paid, paid_amount, notes, document_kind, is_draft,
  created_at, updated_at, deleted_at
)
SELECT
  id, location_id, phone, customer_name, discount_value, tax_percent,
  is_wholesale, is_paid, paid_amount, notes, document_kind, is_draft,
  created_at, updated_at, deleted_at
FROM sales
''');
    await customStatement('DROP TABLE IF EXISTS sales');
    await customStatement('ALTER TABLE sales_new RENAME TO sales');
    await customStatement('PRAGMA foreign_keys = ON');
  }

  /// Writes the single-column `change_percent` into one column per pricing
  /// mode, then removes the old column. The copy is done before the drop so
  /// the values survive even if the process dies mid-step.
  Future<void> _splitChangePercentByPricingMode(final Migrator m) async {
    await _addColumnSafe(m, items, items.costChangePercent);
    await _addColumnSafe(m, items, items.retailChangePercent);
    await _addColumnSafe(m, items, items.wholesaleChangePercent);
    await customStatement('''
UPDATE items
SET cost_change_percent = change_percent,
    retail_change_percent = change_percent,
    wholesale_change_percent = change_percent
WHERE change_percent IS NOT NULL
''');
    await _dropColumnSafe('items', 'change_percent');
  }

  /// Older builds stored timestamps as unix seconds; everything now filters by
  /// milliseconds. The bounds keep the conversion from touching a value that is
  /// already in milliseconds (a seconds-era date only lands between 2000 and
  /// 2100, which is far below the millisecond cutoff).
  Future<void> _normalizeLegacySecondsToMillis() async {
    const columns = <String, List<String>>{
      'operators': ['created_at', 'updated_at', 'deleted_at'],
      'partners': ['created_at', 'updated_at', 'deleted_at'],
      'locations': ['created_at', 'updated_at', 'deleted_at'],
      'groups': ['created_at', 'updated_at', 'deleted_at'],
      'tags': ['created_at', 'updated_at', 'deleted_at'],
      'subgroups': ['created_at', 'updated_at', 'deleted_at'],
      'items': ['created_at', 'updated_at', 'deleted_at'],
      'stock_levels': ['created_at', 'updated_at', 'deleted_at'],
      'sales': ['created_at', 'updated_at', 'deleted_at'],
      'sale_lines': ['created_at', 'updated_at'],
      'sale_payments': ['created_at', 'updated_at'],
      'returns': ['created_at', 'updated_at', 'deleted_at'],
      'return_lines': ['created_at', 'updated_at'],
    };

    for (final entry in columns.entries) {
      for (final column in entry.value) {
        await customStatement('''
UPDATE ${entry.key}
SET $column = $column * 1000
WHERE $column IS NOT NULL
  AND $column < 100000000000
  AND $column BETWEEN 946684800 AND 4102444800
''');
      }
    }
  }

  /// Deduplicates sale headers into partner rows by phone, then points each
  /// sale at the partner it created. `INSERT OR IGNORE` makes the pass runnable
  /// twice without producing duplicate partners.
  Future<void> _backfillPartnersFromSales() async {
    final rows = await customSelect('''
SELECT TRIM(phone) AS p,
       MAX(COALESCE(NULLIF(TRIM(customer_name), ''), 'Walk-in')) AS n
FROM sales
WHERE deleted_at IS NULL
  AND phone IS NOT NULL
  AND TRIM(phone) != ''
GROUP BY TRIM(phone)
''').get();

    final now = DateTime.now();
    for (final row in rows) {
      await into(partners).insert(
        PartnersCompanion.insert(
          phone: row.read<String>('p'),
          name: row.read<String>('n'),
          createdAt: Value(now),
          updatedAt: Value(now),
        ),
        mode: InsertMode.insertOrIgnore,
      );
    }

    await customStatement('''
UPDATE sales
SET partner_id = (
  SELECT p.id FROM partners p
  WHERE p.phone = TRIM(sales.phone) AND p.deleted_at IS NULL
  LIMIT 1
)
WHERE deleted_at IS NULL
  AND phone IS NOT NULL
  AND TRIM(phone) != ''
''');
  }

  /// Legacy products carried a flat `category_id`. The new model makes that a
  /// group holding a single "General" subgroup, so the join table can be
  /// populated without inventing a hierarchy the operator never chose.
  Future<void> _backfillGroupsFromLegacyItems() async {
    final distinct = await customSelect('''
SELECT DISTINCT category_id AS cid FROM items
WHERE category_id IS NOT NULL AND deleted_at IS NULL
''').get();

    final now = DateTime.now();
    for (final row in distinct) {
      await into(subgroups).insert(
        SubgroupsCompanion.insert(
          groupId: row.read<int>('cid'),
          name: 'General',
          createdAt: Value(now),
        ),
      );
    }

    final products = await customSelect('''
SELECT id AS pid, category_id AS cid FROM items
WHERE category_id IS NOT NULL AND deleted_at IS NULL
''').get();

    for (final row in products) {
      final id = row.read<int>('pid');
      final category = row.read<int>('cid');
      final subgroup = await customSelect(
        '''
SELECT id FROM subgroups
WHERE group_id = ? AND name = 'General' AND deleted_at IS NULL
LIMIT 1
''',
        variables: [Variable.withInt(category)],
      ).getSingleOrNull();
      if (subgroup == null) continue;
      await customStatement(
        'INSERT OR IGNORE INTO item_subgroups (item_id, subgroup_id) '
        'VALUES ($id, ${subgroup.read<int>('id')})',
      );
    }
  }

  /// Copies the partner's current address onto each sale so the receipt keeps
  /// the address the customer had *at sale time*, not whatever it becomes
  /// later.
  Future<void> _backfillAddressSnapshot() async {
    await customStatement('''
UPDATE sales
SET address_snapshot = (
  SELECT p.address FROM partners p
  WHERE p.id = sales.partner_id AND p.deleted_at IS NULL
  LIMIT 1
)
WHERE address_snapshot IS NULL AND partner_id IS NOT NULL
''');
  }

  /// The old pricing switch was a boolean (`is_wholesale`); the new model uses
  /// a named mode so more than two price tiers can exist. The flag is read
  /// into the string, then dropped.
  Future<void> _replaceWholesaleFlagWithPricingMode(final Migrator m) async {
    await _addColumnSafe(m, sales, sales.pricingMode);
    await customStatement('''
UPDATE sales
SET pricing_mode = CASE WHEN is_wholesale != 0 THEN 'wholesale' ELSE 'retail' END
''');
    await _dropColumnSafe('sales', 'is_wholesale');
  }

  /// Reconstructs each line's change-percent from the unit price it was sold
  /// at against the item's base price for that pricing mode. Rows whose base
  /// price is unknown are left at zero rather than guessed at.
  Future<void> _backfillLineChangePercentsFromPrices() async {
    final lines = await select(saleLines).get();
    for (final line in lines) {
      final item = await (select(items)
            ..where((final t) => t.id.equals(line.itemId)))
          .getSingleOrNull();
      if (item == null) continue;

      final base = item.listPrice <= 0 ? 0.0 : item.listPrice;
      if (base <= 0) continue;

      final implied = ((line.unitPrice / base) * 100 - 100).clamp(-10000.0, 10000.0);
      final positive = implied >= 0;
      await (update(saleLines)..where((final t) => t.id.equals(line.id))).write(
        SaleLinesCompanion(
          changePercent: Value(implied.abs()),
          changeIsPositive: Value(positive),
        ),
      );
    }
  }

  Future<void> _createPerformanceIndexes() async {
    const statements = <String>[
      'CREATE INDEX IF NOT EXISTS idx_items_active_deleted ON items (is_active, deleted_at)',
      'CREATE INDEX IF NOT EXISTS idx_items_category ON items (category_id)',
      'CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_levels (item_id)',
      'CREATE INDEX IF NOT EXISTS idx_stock_location ON stock_levels (location_id)',
      'CREATE INDEX IF NOT EXISTS idx_sales_deleted ON sales (deleted_at)',
      'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales (created_at)',
      'CREATE INDEX IF NOT EXISTS idx_sales_paid ON sales (is_paid)',
      'CREATE INDEX IF NOT EXISTS idx_sale_lines_sale ON sale_lines (sale_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_sale_created ON sale_payments (sale_id, created_at)',
    ];
    for (final statement in statements) {
      await customStatement(statement);
    }
  }

  Future<void> _seedBaseData() async {
    final now = DateTime.now();
    await into(locations).insert(
      LocationsCompanion.insert(name: 'Main', createdAt: Value(now)),
      mode: InsertMode.insertOrIgnore,
    );
    for (final name in const ['Uncategorised', 'General Goods', 'Consumables']) {
      await into(groups).insert(
        GroupsCompanion.insert(name: name, createdAt: Value(now)),
        mode: InsertMode.insertOrIgnore,
      );
    }
  }
}

/// The one database instance for the app.
///
/// The path comes from an overridable provider because only the bootstrap code
/// knows where the platform keeps documents — mobile and desktop disagree, and
/// tests point it at an in-memory executor instead of a file.
final databaseProvider = Provider<LocalDatabase>((final ref) {
  final database = LocalDatabase.openFile(ref.watch(databasePathProvider));
  ref.onDispose(database.close);
  return database;
});

final databasePathProvider = Provider<String>((final ref) {
  throw UnimplementedError(
    'Override databasePathProvider at bootstrap with the app documents path.',
  );
});
