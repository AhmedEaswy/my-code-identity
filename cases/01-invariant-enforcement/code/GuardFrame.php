<?php

declare(strict_types=1);

namespace App\Ledger;

use App\Ledger\Exceptions\UnbalancedLedgerException;

use function abs;
use function number_format;
use function round;
use function sprintf;

/**
 * Running totals for one open guard frame.
 *
 * A frame accumulates the *net movement* each class of account saw during the
 * transaction. It never queries the database: the numbers come from rows the
 * guard watched being written, which is why the check costs nothing.
 */
final class GuardFrame
{
    /** Nothing real hides below half a minor unit; rounding leaves the rest. */
    private const TOLERANCE = 0.005;

    public float $cash = 0.0;

    public float $customers = 0.0;

    public float $vendors = 0.0;

    public float $platform = 0.0;

    public function __construct(
        public readonly ?string $reason,
        public readonly bool $exempt,
    ) {}

    /** Fold a nested frame into this one when the inner guard closes. */
    public function absorb(self $inner): void
    {
        $this->cash += $inner->cash;
        $this->customers += $inner->customers;
        $this->vendors += $inner->vendors;
        $this->platform += $inner->platform;
    }

    /**
     * The identity: every unit of real cash is owed to someone — a customer, a
     * vendor, or the platform. If the wallets moved by more or less than the
     * cash did, the books do not reconcile and the transaction must not commit.
     */
    public function assertBalanced(): void
    {
        $gap = round($this->cash - ($this->customers + $this->vendors + $this->platform), 2);

        if (abs($gap) > self::TOLERANCE) {
            throw new UnbalancedLedgerException(sprintf(
                'Ledger event is unbalanced: cash %s, customers %s, vendors %s, platform %s (gap %s).',
                $this->money($this->cash),
                $this->money($this->customers),
                $this->money($this->vendors),
                $this->money($this->platform),
                $this->money($gap),
            ));
        }
    }

    private function money(float $amount): string
    {
        return number_format($amount, 2, '.', '');
    }
}
