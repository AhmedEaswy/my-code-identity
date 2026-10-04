import 'package:drift/drift.dart';

import 'local_database.dart';

part 'analytics_dao.g.dart';

/// Time window for a report, expressed in the same millisecond epoch the
/// database stores. The SQL compares integers directly, so no date parsing
/// happens on the hot path.
class ReportWindow {
  const ReportWindow({required this.from, required this.to});

  final DateTime from;
  final DateTime to;

  int get fromMs => from.millisecondsSinceEpoch;
  int get toMs => to.millisecondsSinceEpoch;
}

enum BucketSize { day, week, month }

class SalesKpis {
  const SalesKpis({
    required this.revenue,
    required this.refundAmount,
    required this.saleCount,
    required this.unitsSold,
    required this.lineDiscount,
    required this.headerDiscount,
    required this.grossMargin,
  });

  final double revenue;
  final double refundAmount;
  final int saleCount;
  final int unitsSold;
  final double lineDiscount;
  final double headerDiscount;
  final double grossMargin;

  double get netRevenue => revenue - refundAmount;
}

class BucketAmount {
  const BucketAmount({
    required this.bucket,
    required this.amount,
    required this.count,
  });

  final String bucket;
  final double amount;
  final int count;
}

class NamedAmount {
  const NamedAmount({
    required this.id,
    required this.name,
    required this.amount,
    this.qty = 0,
    this.orders = 0,
  });

  final int id;
  final String name;
  final double amount;
  final int qty;
  final int orders;
}

class AgingBucket {
  const AgingBucket({
    required this.label,
    required this.outstanding,
    required this.saleCount,
  });

  final String label;
  final double outstanding;
  final int saleCount;
}

/// Read-only reporting.
///
/// The aggregations live in SQL because the tables are small enough that pure
/// Dart folds would be fine on a developer laptop but slow on a phone with a
/// few years of sales. The CTE shape — one pass to reduce lines, then one join
/// to the header — is repeated everywhere so a future schema change touches a
/// single helper, not twenty copies of the totals formula.
@DriftAccessor(
  tables: [
    Sales,
    SaleLines,
    SalePayments,
    Returns,
    ReturnLines,
    Items,
    StockLevels,
    Partners,
    Locations,
    Operators,
  ],
)
class AnalyticsDao extends DatabaseAccessor<LocalDatabase>
    with _$AnalyticsDaoMixin {
  AnalyticsDao(super.db);

  Set<TableInfo> get _readsFrom => {
        sales,
        saleLines,
        salePayments,
        returns,
        returnLines,
        items,
        stockLevels,
        partners,
        locations,
        operators,
      };

  /// The one definition of a sale's grand total, shared by every query.
  ///
  /// Netting out the line and header discounts first and clamping at zero
  /// matters: a discount larger than the lines must not produce a negative
  /// total that then has tax applied to it. Tax is charged on the clamped
  /// amount, which is the figure the customer actually saw.
  static String _grandTotalSql(final String sale, final String reduced) {
    return '''
(CASE WHEN COALESCE($reduced.sub, 0) - COALESCE($reduced.ld, 0) - $sale.discount_value < 0 THEN 0
 ELSE COALESCE($reduced.sub, 0) - COALESCE($reduced.ld, 0) - $sale.discount_value END)
+ ROUND((CASE WHEN COALESCE($reduced.sub, 0) - COALESCE($reduced.ld, 0) - $sale.discount_value < 0 THEN 0
 ELSE COALESCE($reduced.sub, 0) - COALESCE($reduced.ld, 0) - $sale.discount_value END) * $sale.tax_percent / 100.0, 2)
''';
  }

  String _scope({
    final int? locationId,
    final String? pricingMode,
    final String? documentKind,
    final int? operatorId,
    final int? partnerId,
  }) {
    final buffer = StringBuffer();
    if (locationId != null) buffer.write(' AND s.location_id = $locationId');
    if (pricingMode != null && pricingMode.isNotEmpty) {
      buffer.write(" AND s.pricing_mode = '${pricingMode.replaceAll("'", "''")}'");
    }
    if (documentKind != null && documentKind.isNotEmpty) {
      buffer.write(
        " AND s.document_kind = '${documentKind.replaceAll("'", "''")}'",
      );
    }
    if (operatorId != null) buffer.write(' AND s.created_by_user_id = $operatorId');
    if (partnerId != null) buffer.write(' AND s.partner_id = $partnerId');
    return buffer.toString();
  }

  Future<SalesKpis> salesKpis(
    final ReportWindow window, {
    final int? locationId,
    final String? pricingMode,
    final String? documentKind,
    final int? operatorId,
  }) async {
    final scope = _scope(
      locationId: locationId,
      pricingMode: pricingMode,
      documentKind: documentKind,
      operatorId: operatorId,
    );

    final row = await customSelect(
      '''
WITH reduced AS (
  SELECT sale_id,
         SUM(quantity * unit_price) AS sub,
         SUM(discount_per_unit * quantity) AS ld
  FROM sale_lines GROUP BY sale_id
),
totals AS (
  SELECT s.id AS sid,
         ${_grandTotalSql('s', 'reduced')} AS total,
         COALESCE(reduced.ld, 0) AS ld,
         s.discount_value AS hd
  FROM sales s
  INNER JOIN reduced ON reduced.sale_id = s.id
  WHERE s.deleted_at IS NULL AND s.is_draft = 0
    AND s.created_at >= ? AND s.created_at < ?
    $scope
),
units AS (
  SELECT s.id, COALESCE(SUM(sl.quantity), 0) AS u
  FROM sales s
  INNER JOIN sale_lines sl ON sl.sale_id = s.id
  WHERE s.deleted_at IS NULL AND s.is_draft = 0
    AND s.created_at >= ? AND s.created_at < ?
    $scope
  GROUP BY s.id
)
SELECT
  COALESCE(SUM(t.total), 0) AS revenue,
  COALESCE(SUM(t.ld), 0)    AS line_disc,
  COALESCE(SUM(t.hd), 0)    AS hdr_disc,
  COUNT(*)                  AS sale_count,
  COALESCE((SELECT SUM(u) FROM units), 0) AS units
FROM totals t
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).getSingle();

    final refundRow = await customSelect(
      '''
SELECT COALESCE(SUM(rl.amount), 0) AS refunds
FROM return_lines rl
INNER JOIN returns r ON r.id = rl.return_id AND r.deleted_at IS NULL
INNER JOIN sales s ON s.id = r.sale_id AND s.deleted_at IS NULL
WHERE r.created_at >= ? AND r.created_at < ?
  AND s.is_draft = 0
  $scope
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).getSingle();

    final marginRow = await customSelect(
      '''
SELECT COALESCE(SUM(sl.quantity * (sl.unit_price - COALESCE(i.cost_price, 0))), 0) AS margin
FROM sale_lines sl
INNER JOIN sales s ON s.id = sl.sale_id
INNER JOIN items i ON i.id = sl.item_id AND i.deleted_at IS NULL
WHERE s.deleted_at IS NULL AND s.is_draft = 0
  AND s.created_at >= ? AND s.created_at < ?
  AND i.cost_price IS NOT NULL
  $scope
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).getSingle();

    return SalesKpis(
      revenue: row.read<double>('revenue'),
      refundAmount: refundRow.read<double>('refunds'),
      saleCount: row.read<int>('sale_count'),
      unitsSold: row.read<int>('units'),
      lineDiscount: row.read<double>('line_disc'),
      headerDiscount: row.read<double>('hdr_disc'),
      grossMargin: marginRow.read<double>('margin'),
    );
  }

  Future<List<BucketAmount>> salesByBucket(
    final ReportWindow window,
    final BucketSize size, {
    final int? locationId,
    final String? pricingMode,
  }) async {
    final scope = _scope(locationId: locationId, pricingMode: pricingMode);
    final bucket = _bucketExpr('s.created_at', size);

    final rows = await customSelect(
      '''
WITH reduced AS (
  SELECT sale_id,
         SUM(quantity * unit_price) AS sub,
         SUM(discount_per_unit * quantity) AS ld
  FROM sale_lines GROUP BY sale_id
)
SELECT $bucket AS bucket,
       SUM(${_grandTotalSql('s', 'reduced')}) AS amount,
       COUNT(*) AS cnt
FROM sales s
INNER JOIN reduced ON reduced.sale_id = s.id
WHERE s.deleted_at IS NULL AND s.is_draft = 0
  AND s.created_at >= ? AND s.created_at < ?
  $scope
GROUP BY bucket
ORDER BY bucket
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).get();

    return rows
        .map(
          (final r) => BucketAmount(
            bucket: r.read<String>('bucket'),
            amount: r.read<double>('amount'),
            count: r.read<int>('cnt'),
          ),
        )
        .toList();
  }

  Future<List<NamedAmount>> topItems(
    final ReportWindow window, {
    int limit = 30,
    int offset = 0,
    final int? locationId,
  }) async {
    final scope = _scope(locationId: locationId);
    final rows = await customSelect(
      '''
SELECT i.id AS iid, i.name AS iname,
       SUM(sl.quantity * (sl.unit_price - sl.discount_per_unit)) AS rev,
       SUM(sl.quantity) AS qty,
       COUNT(DISTINCT s.id) AS sale_count
FROM sale_lines sl
INNER JOIN sales s ON s.id = sl.sale_id
INNER JOIN items i ON i.id = sl.item_id AND i.deleted_at IS NULL
WHERE s.deleted_at IS NULL AND s.is_draft = 0
  AND s.created_at >= ? AND s.created_at < ?
  $scope
GROUP BY i.id
ORDER BY rev DESC
LIMIT $limit OFFSET $offset
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).get();

    return rows
        .map(
          (final r) => NamedAmount(
            id: r.read<int>('iid'),
            name: r.read<String>('iname'),
            amount: r.read<double>('rev'),
            qty: r.read<int>('qty'),
            orders: r.read<int>('sale_count'),
          ),
        )
        .toList();
  }

  Future<List<NamedAmount>> topPartners(
    final ReportWindow window, {
    int limit = 30,
    int offset = 0,
  }) async {
    final rows = await customSelect(
      '''
WITH reduced AS (
  SELECT sale_id,
         SUM(quantity * unit_price) AS sub,
         SUM(discount_per_unit * quantity) AS ld
  FROM sale_lines GROUP BY sale_id
)
SELECT p.id AS pid, p.name AS pname, p.phone AS pphone,
       SUM(${_grandTotalSql('s', 'reduced')}) AS rev,
       COUNT(*) AS sale_count
FROM sales s
INNER JOIN reduced ON reduced.sale_id = s.id
INNER JOIN partners p ON p.id = s.partner_id AND p.deleted_at IS NULL
WHERE s.deleted_at IS NULL AND s.is_draft = 0
  AND s.created_at >= ? AND s.created_at < ?
GROUP BY p.id
ORDER BY rev DESC
LIMIT $limit OFFSET $offset
''',
      variables: [
        Variable.withInt(window.fromMs),
        Variable.withInt(window.toMs),
      ],
      readsFrom: _readsFrom,
    ).get();

    return rows
        .map(
          (final r) => NamedAmount(
            id: r.read<int>('pid'),
            name: r.read<String>('pname'),
            amount: r.read<double>('rev'),
            orders: r.read<int>('sale_count'),
          ),
        )
        .toList();
  }

  /// Outstanding balances grouped by age.
  ///
  /// A single CTE folds the lines and payments first, then one expression
  /// sorts every unpaid sale into a bucket. Doing the arithmetic in SQLite
  /// keeps the whole ledger out of Dart memory; the alternative — loading the
  /// sales and bucketing in a loop — is what makes a report crawl on a phone.
  Future<List<AgingBucket>> aging(final DateTime asOf) async {
    final asMs = asOf.millisecondsSinceEpoch;
    final rows = await customSelect(
      '''
WITH reduced AS (
  SELECT sale_id,
         SUM(quantity * unit_price) AS sub,
         SUM(discount_per_unit * quantity) AS ld
  FROM sale_lines GROUP BY sale_id
),
paid AS (
  SELECT sale_id, SUM(amount) AS paid FROM sale_payments GROUP BY sale_id
),
open_sales AS (
  SELECT s.id,
         s.created_at,
         ${_grandTotalSql('s', 'reduced')} AS total,
         COALESCE(paid.paid, 0) AS paid
  FROM sales s
  INNER JOIN reduced ON reduced.sale_id = s.id
  LEFT JOIN paid ON paid.sale_id = s.id
  WHERE s.deleted_at IS NULL AND s.is_draft = 0 AND s.is_paid = 0
)
SELECT
  CASE
    WHEN (? - created_at) <= 30 * 86400000 THEN 'b0'
    WHEN (? - created_at) <= 60 * 86400000 THEN 'b1'
    WHEN (? - created_at) <= 90 * 86400000 THEN 'b2'
    ELSE 'b3'
  END AS bucket,
  SUM(total - paid) AS outstanding,
  COUNT(*) AS n
FROM open_sales
WHERE total > paid
GROUP BY bucket
''',
      variables: [
        Variable.withInt(asMs),
        Variable.withInt(asMs),
        Variable.withInt(asMs),
      ],
      readsFrom: _readsFrom,
    ).get();

    String label(final String key) {
      return switch (key) {
        'b0' => '0-30',
        'b1' => '31-60',
        'b2' => '61-90',
        _ => '90+',
      };
    }

    return rows
        .map(
          (final r) => AgingBucket(
            label: label(r.read<String>('bucket')),
            outstanding: r.read<double>('outstanding'),
            saleCount: r.read<int>('n'),
          ),
        )
        .toList();
  }

  /// Stock valuation across locations, with the retail figure falling back to
  /// the item's list price when a stock row carries no override.
  Future<double> stockRetailValue() async {
    final row = await customSelect(
      '''
SELECT COALESCE(SUM(s.quantity * COALESCE(s.price, i.list_price)), 0) AS v
FROM stock_levels s
INNER JOIN items i ON i.id = s.item_id AND i.deleted_at IS NULL
WHERE s.deleted_at IS NULL
''',
      readsFrom: _readsFrom,
    ).getSingle();
    return row.read<double>('v');
  }

  /// SQLite has no date-truncation function that takes a millisecond epoch, so
  /// the column is divided to seconds and handed to strftime with the format
  /// that matches the requested bucket.
  String _bucketExpr(final String column, final BucketSize size) {
    final format = switch (size) {
      BucketSize.day => '%Y-%m-%d',
      BucketSize.week => '%Y-W%W',
      BucketSize.month => '%Y-%m',
    };
    return "strftime('$format', $column / 1000, 'unixepoch')";
  }
}
