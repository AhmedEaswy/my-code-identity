<?php

declare(strict_types=1);

namespace App\Ledger;

use App\Ledger\Enums\LedgerOperation;
use App\Ledger\Models\CashEntry;
use App\Ledger\Models\Customer;
use App\Ledger\Models\LedgerCheck;
use App\Ledger\Models\LedgerEntry;
use App\Ledger\Models\Order;
use App\Ledger\Models\Platform;
use App\Ledger\Models\Vendor;
use App\Ledger\Models\Wallet;
use Illuminate\Support\Collection;

use function abs;
use function count;
use function number_format;
use function round;
use function sprintf;

/**
 * The reading of the ledger invariants against the whole datastore.
 *
 * The guard in {@see LedgerGuard} stops a mistake as it is written. This is the
 * other half: a job that reads what actually *occurred* and checks the same
 * identity from the outside, so faults that slipped through an exemption, a
 * backfill, or an old release are found instead of assumed away.
 *
 * A run is a snapshot as well as a verdict — it writes down the totals it read
 * and every finding, with timing, so two runs can be compared.
 *
 * (Abridged: this sample shows the identity, the platform's balance chain, the
 * unearned-part check, and the per-order four-sided check. The full job adds a
 * cash/ledger "twin" check and a zero-row check.)
 */
final class LedgerAudit
{
    private const TOLERANCE = 0.005;

    /** @var list<array<string, mixed>> */
    private array $findings = [];

    public function run(string $trigger = 'manual', ?string $since = null): LedgerCheck
    {
        $started = hrtime(true);
        $this->findings = [];

        ['cash' => $cash, 'customers' => $customers, 'vendors' => $vendors, 'platform' => $platform, 'gap' => $gap] = $this->identity();

        $platformWallet = Platform::current()->wallet()->fresh();
        $earned = round((float) $platformWallet->earned_balance, 2);

        if (abs($gap) > self::TOLERANCE) {
            $this->finding('identity', sprintf(
                'The wallets add up to %s while the cash ledger holds %s (gap %s).',
                $this->money($customers + $vendors + $platform),
                $this->money($cash),
                $this->money($gap),
            ), ['gap' => $gap, 'cash' => $cash, 'customers' => $customers, 'vendors' => $vendors, 'platform' => $platform]);
        }

        $platformRows = LedgerEntry::query()->where('wallet_id', $platformWallet->id)->orderBy('id')->get();

        $this->platformChain($platformRows, $platformWallet);
        $this->unearned($platformRows, $platform, $earned);
        $this->orders($since);

        return LedgerCheck::create([
            'ran_at'           => now(),
            'trigger'          => $trigger,
            'ok'               => $this->findings === [],
            'cash_total'       => $cash,
            'customers_total'  => $customers,
            'vendors_total'    => $vendors,
            'platform_balance' => $platform,
            'platform_earned'  => $earned,
            'gap'              => $gap,
            'findings'         => $this->findings,
            'findings_count'   => count($this->findings),
            'duration_ms'      => (int) ((hrtime(true) - $started) / 1_000_000),
        ]);
    }

    /**
     * The four totals and the gap between them, signed the way an operator
     * reads it: positive when the wallets claim more than the cash ledger holds,
     * which is the case that means cash does not cover what is owed.
     *
     * @return array{cash: float, customers: float, vendors: float, platform: float, gap: float}
     */
    public function identity(): array
    {
        $cash = CashEntry::expectedBalance();
        $customers = round((float) Wallet::query()->where('owner_type', Customer::class)->sum('balance'), 2);
        $vendors = round((float) Wallet::query()->where('owner_type', Vendor::class)->sum('balance'), 2);
        $platform = round((float) Platform::current()->wallet()->fresh()->balance, 2);

        return [
            'cash'      => $cash,
            'customers' => $customers,
            'vendors'   => $vendors,
            'platform'  => $platform,
            'gap'       => round(($customers + $vendors + $platform) - $cash, 2),
        ];
    }

    /**
     * Every row on the platform wallet must move the balance by its amount in
     * its direction (a commission becoming earned moves none), each row must
     * open where the last one closed, and the last must close where the wallet
     * stands. The same is checked for the earned side over the rows that carry
     * it.
     *
     * @param Collection<int, LedgerEntry> $rows
     */
    private function platformChain(Collection $rows, Wallet $wallet): void
    {
        $running = null;
        $runningEarned = null;

        foreach ($rows as $row) {
            $amount = round((float) $row->amount, 2);
            $signed = $row->direction === 'credit' ? $amount : -$amount;
            $movement = round((float) $row->balance_after - (float) $row->balance_before, 2);
            $expected = $row->operation === LedgerOperation::CommissionEarned ? 0.0 : $signed;

            if (abs($movement - $expected) > self::TOLERANCE) {
                $this->finding('platform_chain', sprintf(
                    'Row %d (%s) moves the balance by %s for an amount of %s.',
                    $row->id, $row->operation->value, $this->money($movement), $this->money($amount),
                ), ['row_id' => $row->id]);
            }

            if ($running !== null && abs($running - (float) $row->balance_before) > self::TOLERANCE) {
                $this->finding('platform_chain', sprintf(
                    'Row %d opens at %s where the row before it closed at %s.',
                    $row->id, $this->money((float) $row->balance_before), $this->money($running),
                ), ['row_id' => $row->id]);
            }

            $running = (float) $row->balance_after;

            if ($row->earned_before === null) {
                continue;
            }

            $earnedMovement = round((float) $row->earned_after - (float) $row->earned_before, 2);

            if (abs($earnedMovement - $signed) > self::TOLERANCE) {
                $this->finding('platform_chain', sprintf(
                    'Row %d (%s) moves the earned balance by %s for an amount of %s.',
                    $row->id, $row->operation->value, $this->money($earnedMovement), $this->money($amount),
                ), ['row_id' => $row->id]);
            }

            if ($runningEarned !== null && abs($runningEarned - (float) $row->earned_before) > self::TOLERANCE) {
                $this->finding('platform_chain', sprintf(
                    'Row %d opens at an earned balance of %s where the row before it closed at %s.',
                    $row->id, $this->money((float) $row->earned_before), $this->money($runningEarned),
                ), ['row_id' => $row->id]);
            }

            $runningEarned = (float) $row->earned_after;
        }

        if ($running !== null && abs($running - (float) $wallet->balance) > self::TOLERANCE) {
            $this->finding('platform_chain', sprintf(
                'The last row closes at %s but the wallet holds %s.',
                $this->money($running), $this->money((float) $wallet->balance),
            ));
        }
    }

    /**
     * The earned part may never exceed the balance, and the difference must be
     * exactly the commission taken and neither reversed nor earned since.
     *
     * @param Collection<int, LedgerEntry> $rows
     */
    private function unearned(Collection $rows, float $balance, float $earned): void
    {
        if ($earned > $balance + self::TOLERANCE) {
            $this->finding('unearned', sprintf(
                'The platform shows %s earned but holds only %s.',
                $this->money($earned), $this->money($balance),
            ));
        }

        $open = round(
            $this->sum($rows, LedgerOperation::Commission)
            - $this->sum($rows, LedgerOperation::CommissionReversed)
            - $this->sum($rows, LedgerOperation::CommissionEarned),
            2,
        );

        $unearned = round($balance - $earned, 2);

        if (abs($unearned - $open) > self::TOLERANCE) {
            $this->finding('unearned', sprintf(
                'The unearned part is %s while the commissions still open add up to %s.',
                $this->money($unearned), $this->money($open),
            ), ['unearned' => $unearned, 'open_commission' => $open]);
        }
    }

    /**
     * Per order that was ever paid: the cash it brought in, less what went back
     * by bank, must equal what moved between the customer, the vendor, and the
     * platform. Chunked so a large ledger does not load at once.
     */
    private function orders(?string $since): void
    {
        Order::query()
            ->whereNotNull('confirmed_at')
            ->when($since, fn ($query) => $query->whereDate('created_at', '>=', $since))
            ->select(['id'])
            ->chunkById(500, function (Collection $orders): void {
                $ids = $orders->pluck('id');

                $rows = LedgerEntry::query()
                    ->join('wallets', 'wallets.id', '=', 'ledger_entries.wallet_id')
                    ->whereIn('ledger_entries.order_id', $ids)
                    ->get(['ledger_entries.order_id', 'wallets.owner_type', 'ledger_entries.balance_before', 'ledger_entries.balance_after'])
                    ->groupBy('order_id');

                $cash = CashEntry::query()
                    ->whereIn('order_id', $ids)
                    ->get(['order_id', 'direction', 'amount'])
                    ->groupBy('order_id');

                foreach ($ids as $id) {
                    $sides = $this->sides($rows->get($id, collect()), $cash->get($id, collect()));

                    if (abs($sides['gap']) > self::TOLERANCE) {
                        $this->finding('order', sprintf(
                            'Order %d moved %s in cash against %s for the customer, %s for the vendor and %s for the platform (gap %s).',
                            $id, $this->money($sides['cash']), $this->money($sides['customer']), $this->money($sides['vendor']), $this->money($sides['platform']), $this->money($sides['gap']),
                        ), ['order_id' => $id, ...$sides]);
                    }
                }
            });
    }

    /**
     * @param Collection<int, LedgerEntry> $rows the order's entries, each with its wallet's owner type
     * @param Collection<int, CashEntry>   $cash the order's cash movements
     *
     * @return array{cash: float, customer: float, vendor: float, platform: float, gap: float}
     */
    private function sides(Collection $rows, Collection $cash): array
    {
        $movementOf = fn (string $owner): float => round($rows
            ->where('owner_type', $owner)
            ->sum(fn (LedgerEntry $row) => (float) $row->balance_after - (float) $row->balance_before), 2);

        $orderCash = round($cash->sum(fn (CashEntry $entry) => $entry->signedAmount()), 2);
        $customer = $movementOf(Customer::class);
        $vendor = $movementOf(Vendor::class);
        $platform = $movementOf(Platform::class);

        return [
            'cash'     => $orderCash,
            'customer' => $customer,
            'vendor'   => $vendor,
            'platform' => $platform,
            'gap'      => round(($customer + $vendor + $platform) - $orderCash, 2),
        ];
    }

    /** @param Collection<int, LedgerEntry> $rows */
    private function sum(Collection $rows, LedgerOperation $type): float
    {
        return (float) $rows
            ->filter(fn (LedgerEntry $row) => $row->operation === $type)
            ->sum(fn (LedgerEntry $row) => (float) $row->amount);
    }

    /** @param array<string, mixed> $details */
    private function finding(string $check, string $message, array $details = []): void
    {
        $this->findings[] = ['check' => $check, 'message' => $message, ...$details];
    }

    private function money(float $amount): string
    {
        return number_format($amount, 2, '.', '');
    }
}
