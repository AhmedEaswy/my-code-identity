<?php

declare(strict_types=1);

namespace Tests\Feature\Ledger;

use App\Ledger\CashLedger;
use App\Ledger\Enums\CashKind;
use App\Ledger\Enums\LedgerOperation;
use App\Ledger\Exceptions\UnbalancedLedgerException;
use App\Ledger\LedgerGuard;
use App\Ledger\Models\CashEntry;
use App\Ledger\Models\LedgerEntry;
use Illuminate\Foundation\Testing\RefreshDatabase;
use RuntimeException;
use Tests\Concerns\BuildsOrderFixture;
use Tests\Support\AssertsLedgerBalanced;
use Tests\TestCase;

/**
 * The guard is a behavioural contract, so the tests describe behaviour:
 * an unbalanced write is refused *and rolled back*, a declared exemption is
 * allowed and labelled, and only the outermost event judges.
 */
final class LedgerGuardTest extends TestCase
{
    use AssertsLedgerBalanced;
    use BuildsOrderFixture;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->buildOrderFixture();
    }

    public function test_a_ledger_row_written_outside_a_guard_is_refused(): void
    {
        $wallet = $this->customer->wallet();

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('money event');

        LedgerEntry::create([
            'wallet_id'       => $wallet->id,
            'operation'       => LedgerOperation::TopUp,
            'direction'       => 'credit',
            'amount'          => 10,
            'balance_before'  => 0,
            'balance_after'   => 10,
            'description_key' => 'Wallet top-up',
        ]);
    }

    /**
     * The whole point: a credit with no cash behind it is money from nowhere.
     * The event refuses to commit it, and the balance it moved rolls back with
     * the row it wrote.
     */
    public function test_an_unbalanced_event_rolls_back_the_row_and_the_balance(): void
    {
        $wallet = $this->customer->wallet();

        try {
            LedgerGuard::transaction(function () use ($wallet): void {
                $balances = $wallet->add(100);

                LedgerEntry::create([
                    'wallet_id'       => $wallet->id,
                    'operation'       => LedgerOperation::TopUp,
                    'direction'       => 'credit',
                    'amount'          => 100,
                    'balance_before'  => $balances['balance_before'],
                    'balance_after'   => $balances['balance_after'],
                    'description_key' => 'Wallet top-up',
                ]);
            });

            $this->fail('An unbalanced event was committed.');
        } catch (UnbalancedLedgerException $e) {
            $this->assertStringContainsString('100', $e->getMessage(), 'The refusal names the gap.');
        }

        $this->assertSame(0, LedgerEntry::count());
        $this->assertSame('0.00', (string) $wallet->fresh()->balance);
    }

    public function test_a_balanced_event_commits_both_sides(): void
    {
        $wallet = $this->customer->wallet();

        $row = LedgerGuard::transaction(function () use ($wallet) {
            $balances = $wallet->add(100);

            $entry = LedgerEntry::create([
                'wallet_id'       => $wallet->id,
                'operation'       => LedgerOperation::TopUp,
                'direction'       => 'credit',
                'amount'          => 100,
                'balance_before'  => $balances['balance_before'],
                'balance_after'   => $balances['balance_after'],
                'description_key' => 'Wallet top-up',
            ]);

            CashLedger::in(CashKind::BankTransfer, 100, entry: $entry);

            return $entry;
        });

        $this->assertNotNull($row->fresh());
        $this->assertSame(1, CashEntry::count());
        $this->assertNull($row->fresh()->meta['unbalanced_reason'] ?? null, 'A balanced event needs no exemption.');
        $this->assertLedgerBalanced();
    }

    /**
     * A declared exemption commits, and its reason is stamped on every row the
     * event writes — so a row that broke the identity on purpose can always be
     * told from one that broke it by accident. The row's own metadata is kept.
     */
    public function test_a_declared_exemption_commits_and_labels_every_row(): void
    {
        $wallet = $this->customer->wallet();

        LedgerGuard::transaction(function () use ($wallet): void {
            $balances = $wallet->add(100);

            LedgerEntry::create([
                'wallet_id'       => $wallet->id,
                'operation'       => LedgerOperation::TopUp,
                'direction'       => 'credit',
                'amount'          => 100,
                'balance_before'  => $balances['balance_before'],
                'balance_after'   => $balances['balance_after'],
                'description_key' => 'Wallet top-up',
                'meta'            => ['source' => 'bank_transfer'],
            ]);

            CashLedger::in(CashKind::Opening, 30, meta: ['reason' => 'backfill_residual']);
        }, unbalancedReason: 'reconciliation');

        $this->assertSame('reconciliation', LedgerEntry::sole()->meta['unbalanced_reason'] ?? null);
        $this->assertSame('bank_transfer', LedgerEntry::sole()->meta['source'] ?? null);
        $this->assertSame('reconciliation', CashEntry::sole()->meta['unbalanced_reason'] ?? null);
    }

    /**
     * Only the outermost event judges, because only it commits. An inner event
     * may leave one side for its caller to complete — which is how a service
     * that writes the customer's row can be called from a path that writes the
     * cash.
     */
    public function test_nested_events_are_summed_and_judged_at_the_outermost(): void
    {
        $wallet = $this->customer->wallet();

        LedgerGuard::transaction(function () use ($wallet): void {
            // Alone, this would be refused: a credit with nothing behind it.
            $entry = LedgerGuard::transaction(function () use ($wallet) {
                $balances = $wallet->add(100);

                return LedgerEntry::create([
                    'wallet_id'       => $wallet->id,
                    'operation'       => LedgerOperation::TopUp,
                    'direction'       => 'credit',
                    'amount'          => 100,
                    'balance_before'  => $balances['balance_before'],
                    'balance_after'   => $balances['balance_after'],
                    'description_key' => 'Wallet top-up',
                ]);
            });

            // The outer event completes it.
            CashLedger::in(CashKind::BankTransfer, 100, entry: $entry);
        });

        $this->assertSame(1, LedgerEntry::count());
        $this->assertSame(1, CashEntry::count());
        $this->assertLedgerBalanced();
    }

    public function test_an_outer_event_that_breaks_its_inner_balance_is_refused_whole(): void
    {
        $wallet = $this->customer->wallet();

        try {
            LedgerGuard::transaction(function () use ($wallet): void {
                LedgerGuard::transaction(function () use ($wallet): void {
                    $balances = $wallet->add(100);

                    $entry = LedgerEntry::create([
                        'wallet_id'       => $wallet->id,
                        'operation'       => LedgerOperation::TopUp,
                        'direction'       => 'credit',
                        'amount'          => 100,
                        'balance_before'  => $balances['balance_before'],
                        'balance_after'   => $balances['balance_after'],
                        'description_key' => 'Wallet top-up',
                    ]);

                    CashLedger::in(CashKind::BankTransfer, 100, entry: $entry);
                });

                // Then the outer event moves cash out against nothing.
                CashLedger::out(CashKind::Settlement, 5);
            });

            $this->fail('The outer event committed with an unmatched movement.');
        } catch (UnbalancedLedgerException) {
            // Expected.
        }

        $this->assertSame(0, LedgerEntry::count(), 'The inner event rolled back with the outer one.');
        $this->assertSame(0, CashEntry::count());
        $this->assertSame('0.00', (string) $wallet->fresh()->balance);
    }

    /** A thrown callback must close the frame, or the next write would slip past. */
    public function test_a_failing_event_is_closed_on_the_way_out(): void
    {
        try {
            LedgerGuard::transaction(fn () => throw new RuntimeException('boom'));
        } catch (RuntimeException) {
            // Expected.
        }

        $this->assertFalse(LedgerGuard::active());
    }

    /**
     * An unbalanced event is a fault in a money path, not something the user
     * did wrong. It must not wear the class that surfaces to a user as a 422.
     */
    public function test_the_refusal_is_a_programming_fault_not_a_user_error(): void
    {
        $this->assertInstanceOf(RuntimeException::class, new UnbalancedLedgerException('gap'));
    }
}
