<?php

declare(strict_types=1);

namespace App\Billing;

use App\Models\Plan;
use App\Models\Subscription;
use Carbon\CarbonImmutable;

/**
 * The money math for moving between plans.
 *
 * A change is not "charge the new price". Part of what the customer already
 * paid for is still unused, and that credit has to be given a value before the
 * new price is compared against it. This object resolves one such change into
 * the few numbers the caller needs: the time left on the old plan, what that
 * time is worth, what the new plan costs, and whether the customer owes money
 * or is owed some.
 *
 * The window is always the *old* subscription's, because the credit being
 * valued is time already bought — not the time about to be bought.
 */
final readonly class Proration
{
    public function __construct(
        public int $remainingDays,
        public int $coveredDays,
        public float $unusedCredit,
        public float $priceDifference,
        public float $amountDue,
        public float $refundDue,
    ) {}

    public static function forChange(
        Subscription $current,
        Plan $source,
        Plan $target,
        BillingCycle $targetCycle,
        ?CarbonImmutable $at = null,
    ): self {
        $at ??= CarbonImmutable::now();

        $window = new CoverageWindow(
            CarbonImmutable::parse($current->starts_at),
            CarbonImmutable::parse($current->ends_at),
            $current->billing_cycle,
        );

        $coveredDays = $window->coveredDays();
        $remainingDays = $window->remainingDays($at);
        $targetPrice = $target->priceFor($targetCycle);

        // The source is valued in the cycle it was actually sold on. Comparing
        // it against the target's cycle would silently misprice a yearly plan
        // being moved to monthly, or the other way round.
        $sourcePrice = $source->priceFor($current->billing_cycle);

        if ($remainingDays <= 0) {
            // Nothing left to credit: the change is simply a fresh purchase.
            return new self(0, $coveredDays, 0.0, $targetPrice, $targetPrice, 0.0);
        }

        $dailyRate = $sourcePrice / $coveredDays;
        $unusedCredit = round($dailyRate * $remainingDays, 2);
        $difference = round($targetPrice - $sourcePrice, 2);

        // Moving onto the free tier: there is nothing to charge, so every
        // unused cent goes back rather than evaporating.
        if ($target->is_free) {
            return new self($remainingDays, $coveredDays, $unusedCredit, -$sourcePrice, 0.0, $unusedCredit);
        }

        // The credit outruns the new plan entirely. Carrying a negative charge
        // is harder to audit than issuing the surplus, so it is refunded.
        if ($unusedCredit > $targetPrice) {
            return new self(
                $remainingDays,
                $coveredDays,
                $unusedCredit,
                $difference,
                0.0,
                round($unusedCredit - $targetPrice, 2),
            );
        }

        return new self(
            $remainingDays,
            $coveredDays,
            $unusedCredit,
            $difference,
            round(max(0.0, $targetPrice - $unusedCredit), 2),
            0.0,
        );
    }

    public function refundsCustomer(): bool
    {
        return $this->refundDue > 0.0;
    }

    public function collectsNothing(): bool
    {
        return $this->amountDue <= 0.0;
    }
}
