<?php

declare(strict_types=1);

namespace App\Ledger;

use App\Ledger\Enums\CashKind;
use App\Ledger\Enums\LedgerOperation;
use App\Ledger\Exceptions\UnknownRewardException;
use App\Ledger\Models\Customer;
use App\Ledger\Models\LedgerEntry;
use App\Ledger\Models\Order;
use App\Ledger\Models\Platform;
use App\Ledger\Models\Wallet;
use Illuminate\Support\Collection;

use function round;

/**
 * The single writer of rows on the platform's own wallet.
 *
 * It is called from *inside* a path's money event, after the path has written
 * the customer's and the vendor's rows, so the platform wallet is always the
 * last one locked — order, then vendor, then customer, then platform — and the
 * lock is held only briefly.
 *
 * Every amount is read off what the path actually wrote, or off the rows
 * already on the wallet. Nothing is recomputed from a parallel formula. That
 * matters: a commission that later becomes earned must equal the commission
 * that was taken, even if the pricing rules change in between.
 */
final class PlatformJournal
{
    /**
     * Confirmation. The fee is earned immediately; the commission waits until
     * the service is delivered; the platform's share of a discount is a cost
     * from the start; and whatever the gateway captured arrives as real cash.
     */
    public function recordPayment(Order $order, ?float $gatewayAmount = null): void
    {
        if ($this->skips($order)) {
            return;
        }

        $this->post($order, LedgerOperation::ServiceFee, 'credit', (float) $order->service_fee, movesEarned: true, key: 'Service fee on order #:id');
        $this->post($order, LedgerOperation::Commission, 'credit', (float) $order->commission, movesEarned: false, key: 'Commission on order #:id');
        $this->post($order, LedgerOperation::DiscountCost, 'debit', (float) $order->platform_discount_share, movesEarned: true, key: 'Discount cost on order #:id');

        CashLedger::in(
            CashKind::GatewayCapture,
            (float) $order->paid_amount,
            order: $order,
            reference: $order->checkout_id,
            meta: $gatewayAmount === null ? [] : ['gateway_amount' => round($gatewayAmount, 2)],
        );
    }

    /**
     * Completion. The commission still open on the order becomes earned — a
     * credit that moves no balance, because the money arrived at confirmation.
     * Only the earned side moves.
     */
    public function recordCompletion(Order $order): void
    {
        if ($this->skips($order)) {
            return;
        }

        $this->post(
            $order,
            LedgerOperation::CommissionEarned,
            'credit',
            $this->unsettledCommission($order),
            movesEarned: true,
            movesBalance: false,
            key: 'Commission on order #:id became earned',
        );
    }

    /**
     * A reward is not money from nowhere: the platform funds it row for row, on
     * the same event, and records which reward it was.
     *
     * @param 'loyalty'|'referral'|'welcome' $kind
     */
    public function postIncentive(LedgerEntry $customerRow, string $kind): void
    {
        if (! LedgerGuard::writesPlatformSide()) {
            return;
        }

        [$key, $params] = match ($kind) {
            'loyalty'  => ['Funded the loyalty reward for order #:id', ['id' => $customerRow->order_id]],
            'referral' => ['Funded the referral reward for :name', ['name' => $customerRow->description_params['name'] ?? '']],
            'welcome'  => ['Funded the welcome reward for code :code', ['code' => $customerRow->description_params['code'] ?? '']],
            default    => throw new UnknownRewardException("Unknown reward kind '{$kind}'."),
        };

        $this->write(
            LedgerOperation::Reward,
            'debit',
            (float) $customerRow->amount,
            movesEarned: true,
            movesBalance: true,
            key: $key,
            params: $params,
            orderId: $customerRow->order_id,
            meta: ['reward_kind' => $kind, 'customer_entry_id' => $customerRow->id],
        );
    }

    /**
     * A courtesy credit is money the platform never received: the customer's
     * balance rises against nothing in the bank, and the difference is the
     * platform's cost.
     */
    public function postCourtesyCredit(LedgerEntry $customerRow, Customer $customer): void
    {
        if (! LedgerGuard::writesPlatformSide()) {
            return;
        }

        $this->write(
            LedgerOperation::CourtesyCredit,
            'debit',
            (float) $customerRow->amount,
            movesEarned: true,
            movesBalance: true,
            key: 'Courtesy credit to :name',
            params: ['name' => $this->nameOf($customer)],
            orderId: null,
            meta: ['customer_entry_id' => $customerRow->id],
        );
    }

    /**
     * What was taken as commission on this order and neither reversed nor
     * earned since — read off the rows, so it can never disagree with them.
     */
    public function unsettledCommission(Order $order): float
    {
        $rows = $this->rowsOf($order);

        return round(
            $this->sum($rows, LedgerOperation::Commission)
            - $this->sum($rows, LedgerOperation::CommissionReversed)
            - $this->sum($rows, LedgerOperation::CommissionEarned),
            2,
        );
    }

    /** What the platform bore of a discount and has not recovered. */
    public function openDiscountCost(Order $order): float
    {
        $rows = $this->rowsOf($order);

        return round(
            $this->sum($rows, LedgerOperation::DiscountCost)
            - $this->sum($rows, LedgerOperation::DiscountRecovered),
            2,
        );
    }

    public function wallet(): Wallet
    {
        return Platform::current()->wallet();
    }

    private function skips(Order $order): bool
    {
        return $order->isExternal() || ! LedgerGuard::writesPlatformSide();
    }

    private function post(Order $order, LedgerOperation $type, string $direction, float $amount, bool $movesEarned, string $key, bool $movesBalance = true): ?LedgerEntry
    {
        return $this->write($type, $direction, $amount, $movesEarned, $movesBalance, $key, ['id' => $order->id], $order->id, []);
    }

    /**
     * The row itself: the wallet locked, the balances moved in the stated
     * direction (negative allowed on both, since the platform may owe more
     * than it has earned), and the entry written with both pairs of figures.
     * Nothing is written for a zero amount.
     *
     * @param array<string, mixed> $params
     * @param array<string, mixed> $meta
     */
    private function write(LedgerOperation $type, string $direction, float $amount, bool $movesEarned, bool $movesBalance, string $key, array $params, ?int $orderId, array $meta): ?LedgerEntry
    {
        $amount = round($amount, 2);

        if ($amount <= 0) {
            return null;
        }

        $wallet = $this->wallet()->lockForWrite();

        if ($movesBalance) {
            $balances = $direction === 'credit'
                ? $wallet->add($amount)
                : $wallet->deduct($amount, allowNegative: true);
        } else {
            $balances = ['balance_before' => (float) $wallet->balance, 'balance_after' => (float) $wallet->balance];
        }

        $earned = null;

        if ($movesEarned) {
            $earned = $direction === 'credit'
                ? $wallet->addEarned($amount)
                : $wallet->deductEarned($amount, allowNegative: true);
        }

        return LedgerEntry::create([
            'wallet_id'          => $wallet->id,
            'operation'          => $type,
            'direction'          => $direction,
            'amount'             => $amount,
            'balance_before'     => $balances['balance_before'],
            'balance_after'      => $balances['balance_after'],
            'earned_before'      => $earned['earned_balance_before'] ?? null,
            'earned_after'       => $earned['earned_balance_after'] ?? null,
            'description_key'    => $key,
            'description_params' => $params,
            'order_id'           => $orderId,
            'meta'               => $meta === [] ? null : $meta,
        ]);
    }

    /** @return Collection<int, LedgerEntry> */
    private function rowsOf(Order $order): Collection
    {
        return LedgerEntry::query()
            ->where('order_id', $order->id)
            ->where('wallet_id', $this->wallet()->id)
            ->get(['operation', 'direction', 'amount']);
    }

    /** @param Collection<int, LedgerEntry> $rows */
    private function sum(Collection $rows, LedgerOperation $type): float
    {
        return (float) $rows
            ->filter(fn (LedgerEntry $row) => $row->operation === $type)
            ->sum(fn (LedgerEntry $row) => (float) $row->amount);
    }

    private function nameOf(Customer $customer): string
    {
        return trim(($customer->first_name ?? '') . ' ' . ($customer->last_name ?? ''))
            ?: (string) ($customer->phone ?? $customer->email ?? $customer->id);
    }
}
