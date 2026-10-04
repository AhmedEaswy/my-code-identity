import 'package:drift/drift.dart';

import 'local_database.dart';

part 'sales_dao.g.dart';

/// Reads and writes around a sale.
///
/// Every method that changes more than one row runs inside `transaction(...)`.
/// The DAO owns the stock side effect of a sale line, so the line and the
/// quantity it consumes can never be written by two different code paths and
/// drift apart.
@DriftAccessor(
  tables: [Sales, SaleLines, SalePayments, StockLevels, Items, Partners, Returns, ReturnLines],
)
class SalesDao extends DatabaseAccessor<LocalDatabase> with _$SalesDaoMixin {
  SalesDao(super.db);

  Stream<List<Sale>> watchOpenSales() {
    return (select(sales)
          ..where((final t) => t.deletedAt.isNull() & t.isDraft.equals(false))
          ..orderBy([(final t) => OrderingTerm.desc(t.createdAt)]))
        .watch();
  }

  Future<Sale> getById(final int id) {
    return (select(sales)..where((final t) => t.id.equals(id))).getSingle();
  }

  Stream<List<SaleLine>> watchLines(final int saleId) {
    return (select(saleLines)..where((final t) => t.saleId.equals(saleId))).watch();
  }

  Stream<List<SalePayment>> watchPayments(final int saleId) {
    return (select(salePayments)
          ..where((final t) => t.saleId.equals(saleId))
          ..orderBy([(final t) => OrderingTerm.desc(t.createdAt)]))
        .watch();
  }

  /// Creates a header and its lines, then reconciles the paid total, as one
  /// transaction. If any line cannot find stock, the whole sale is discarded —
  /// there is no half-written sale pointing at rows that were never deducted.
  Future<int> createSaleWithLines({
    required final SalesCompanion sale,
    required final List<SaleLinesCompanion> lines,
  }) {
    return transaction(() async {
      final saleId = await into(sales).insert(sale);
      final locationId = sale.locationId.present ? sale.locationId.value : null;
      await _appendLines(saleId: saleId, locationId: locationId, lines: lines);
      await _syncPaidTotalIfUnset(saleId);
      return saleId;
    });
  }

  /// Inserts each line, resolving its stock row, then moves the stock.
  ///
  /// The stock lookup happens before the insert so a line whose item has no
  /// stock at all can still be saved (services, custom items), while a line
  /// that resolves to a stock row is rejected if there is not enough on hand.
  Future<void> _appendLines({
    required final int saleId,
    required final int? locationId,
    required final List<SaleLinesCompanion> lines,
  }) async {
    for (final line in lines) {
      final itemId = line.itemId.value;
      final quantity = line.quantity.value;

      final item = await (select(items)..where((final t) => t.id.equals(itemId)))
          .getSingle();

      var stock = await _resolveStockForLine(itemId: itemId, locationId: locationId);

      // Prefer the stock row the UI picked, but only if it still belongs to
      // this item and is live — otherwise fall back to the resolved one.
      if (line.stockId.present && line.stockId.value != null) {
        final picked = await (select(stockLevels)
              ..where(
                (final t) =>
                    t.id.equals(line.stockId.value!) &
                    t.deletedAt.isNull() &
                    t.itemId.equals(itemId),
              ))
            .getSingleOrNull();
        if (picked != null) stock = picked;
      }

      final available = stock == null ? 0 : stock.quantity;
      final resolved = stock;
      if (resolved != null && available < quantity) {
        throw StateError(
          'Not enough stock for "${item.name}". '
          'Available $available, requested $quantity.',
        );
      }

      await into(saleLines).insert(
        SaleLinesCompanion.insert(
          saleId: saleId,
          itemId: itemId,
          stockId: Value(resolved?.id),
          quantity: quantity,
          unitPrice: line.unitPrice.value,
          discountPerUnit: line.discountPerUnit,
          changePercent: line.changePercent,
          changeIsPositive: line.changeIsPositive,
        ),
      );

      if (resolved != null) {
        final live = resolved;
        await (update(stockLevels)..where((final t) => t.id.equals(live.id)))
            .write(
          StockLevelsCompanion(
            quantity: Value(live.quantity - quantity),
            soldQuantity: Value(live.soldQuantity + quantity),
            updatedAt: Value(DateTime.now()),
          ),
        );
      }
    }
  }

  /// Removes a set of lines and returns their stock. Refuses to remove a line
  /// that has already been returned against — otherwise a return could later
  /// point at a line that no longer exists.
  Future<void> removeLines(final int saleId, final Set<int> lineIds) {
    return transaction(() async {
      for (final id in lineIds) {
        final refunded = await _returnedQuantity(id);
        if (refunded > 0) {
          throw StateError('Cannot remove a line that already has a return.');
        }
        final line = await (select(saleLines)..where((final t) => t.id.equals(id)))
            .getSingleOrNull();
        if (line == null) continue;
        await _restoreStockForLine(line);
        await (delete(saleLines)..where((final t) => t.id.equals(id))).go();
      }
      await _syncPaidTotalIfUnset(saleId);
    });
  }

  /// Records a payment, refusing anything that would push the paid total past
  /// the sale's grand total. Without this guard a mis-tap on a numeric keypad
  /// quietly turns a sale into a credit.
  Future<int> addPayment(final SalePaymentsCompanion entry) async {
    return transaction(() async {
      final saleId = entry.saleId.value;
      final amount = entry.amount.value;
      if (amount <= 0) {
        throw StateError('A payment must be greater than zero.');
      }

      final sale = await getById(saleId);
      final total = await _grandTotal(sale);
      final paid = await _paidTotal(saleId);
      final remaining = total - paid;

      if (amount > remaining) {
        throw StateError('Payment exceeds the remaining balance of $remaining.');
      }

      final paymentId = await into(salePayments).insert(entry);
      final newPaid = paid + amount;
      await (update(sales)..where((final t) => t.id.equals(saleId))).write(
        SalesCompanion(
          paidAmount: Value(newPaid),
          isPaid: Value(newPaid >= total),
        ),
      );
      return paymentId;
    });
  }

  /// Books a return: validates quantities against what is left, restores stock,
  /// and stores one aggregate amount per line so reports can sum returns
  /// without re-deriving the original price.
  Future<int> createReturn({
    required final int saleId,
    required final List<ReturnLinesCompanion> lines,
  }) {
    return transaction(() async {
      final returnId = await into(returns).insert(
        ReturnsCompanion.insert(saleId: saleId),
      );
      for (final line in lines) {
        final saleLine = await (select(saleLines)
              ..where((final t) => t.id.equals(line.saleLineId.value)))
            .getSingle();
        final alreadyReturned = await _returnedQuantity(saleLine.id);
        if (alreadyReturned + line.quantity.value > saleLine.quantity) {
          throw StateError(
            'Return exceeds the sold quantity for line ${saleLine.id}.',
          );
        }

        await into(returnLines).insert(
          ReturnLinesCompanion.insert(
            returnId: returnId,
            saleLineId: saleLine.id,
            quantity: line.quantity.value,
            amount: line.amount.value,
          ),
        );
        await _restoreStockForLine(saleLine);
      }
      return returnId;
    });
  }

  Future<void> softDelete(final int id) {
    return (update(sales)..where((final t) => t.id.equals(id))).write(
      SalesCompanion(deletedAt: Value(DateTime.now())),
    );
  }

  /// Puts the line's quantity back on the shelf and reverses its sold count,
  /// clamping at zero so a double restore cannot make stock negative.
  Future<void> _restoreStockForLine(final SaleLine line) async {
    if (line.stockId == null) return;
    final stock = await (select(stockLevels)
          ..where((final t) => t.id.equals(line.stockId!)))
        .getSingleOrNull();
    if (stock == null) return;
    final live = stock;

    final sold = live.soldQuantity - line.quantity;
    await (update(stockLevels)..where((final t) => t.id.equals(live.id))).write(
      StockLevelsCompanion(
        quantity: Value(live.quantity + line.quantity),
        soldQuantity: Value(sold < 0 ? 0 : sold),
        updatedAt: Value(DateTime.now()),
      ),
    );
  }

  /// Stock preference, in order: the sale's location, then the item's marked
  /// default, then the fullest live row. The final fallback keeps a catalog
  /// with one ambiguous stock row usable instead of forcing the operator to
  /// clean it up mid-sale.
  Future<StockLevel?> _resolveStockForLine({
    required final int itemId,
    required final int? locationId,
  }) async {
    if (locationId != null) {
      final inLocation = await (select(stockLevels)
            ..where(
              (final t) =>
                  t.deletedAt.isNull() &
                  t.itemId.equals(itemId) &
                  t.locationId.equals(locationId),
            )
            ..orderBy([(final t) => OrderingTerm.desc(t.quantity)]))
          .get();
      if (inLocation.isNotEmpty) return inLocation.first;
    }

    final markedDefault = await (select(stockLevels)
          ..where(
            (final t) =>
                t.deletedAt.isNull() &
                t.itemId.equals(itemId) &
                t.isDefault.equals(true),
          )
          ..orderBy([(final t) => OrderingTerm.desc(t.quantity)]))
        .get();
    if (markedDefault.isNotEmpty) return markedDefault.first;

    final fallback = await (select(stockLevels)
          ..where((final t) => t.deletedAt.isNull() & t.itemId.equals(itemId))
          ..orderBy([
            (final t) => OrderingTerm.desc(t.quantity),
            (final t) => OrderingTerm.desc(t.updatedAt),
          ]))
        .get();
    return fallback.isEmpty ? null : fallback.first;
  }

  Future<int> _returnedQuantity(final int saleLineId) async {
    final row = await customSelect(
      '''
SELECT COALESCE(SUM(rl.quantity), 0) AS q
FROM return_lines rl
INNER JOIN returns r ON r.id = rl.return_id AND r.deleted_at IS NULL
WHERE rl.sale_line_id = ?
''',
      variables: [Variable.withInt(saleLineId)],
      readsFrom: {returnLines, returns},
    ).getSingle();
    return row.read<int>('q');
  }

  Future<void> _syncPaidTotalIfUnset(final int saleId) async {
    final sale = await getById(saleId);
    if (sale.isPaid && sale.paidAmount == 0) {
      final total = await _grandTotal(sale);
      await (update(sales)..where((final t) => t.id.equals(saleId))).write(
        SalesCompanion(paidAmount: Value(total)),
      );
    }
  }

  Future<double> _paidTotal(final int saleId) async {
    final rows = await (select(salePayments)
          ..where((final t) => t.saleId.equals(saleId)))
        .get();
    return rows.fold<double>(0, (final sum, final p) => sum + p.amount);
  }

  Future<double> _grandTotal(final Sale sale) async {
    final lines = await (select(saleLines)
          ..where((final t) => t.saleId.equals(sale.id)))
        .get();
    final subtotal = lines.fold<double>(
      0,
      (final sum, final l) => sum + l.quantity * l.unitPrice,
    );
    final lineDiscount = lines.fold<double>(
      0,
      (final sum, final l) => sum + l.quantity * l.discountPerUnit,
    );
    final net = subtotal - lineDiscount - sale.discountValue;
    final clamped = net < 0 ? 0.0 : net;
    return clamped + (clamped * sale.taxPercent / 100);
  }
}
