<?php

declare(strict_types=1);

namespace App\Billing;

use Carbon\CarbonImmutable;
use InvalidArgumentException;

/**
 * The span of time a subscription actually covers: when it opens, when it
 * closes, and the cadence that produced the close.
 *
 * Every "how much time is left?" question in the billing code reads this
 * object rather than doing date arithmetic inline, so the day-count rule lives
 * in one place and every caller gets the same answer. The window only depends
 * on the cadence for *length*; the exact close comes from the calendar, which
 * is why a monthly window is not always thirty days.
 */
final readonly class CoverageWindow
{
    public function __construct(
        public CarbonImmutable $start,
        public CarbonImmutable $end,
        public BillingCycle $cycle,
    ) {
        if ($this->start->greaterThanOrEqualTo($this->end)) {
            throw new InvalidArgumentException('A coverage window must close after it opens.');
        }
    }

    /** A window that opens at $start and runs one full cycle from there. */
    public static function openingAt(CarbonImmutable $start, BillingCycle $cycle): self
    {
        return new self($start, $start->addMonths($cycle->months()), $cycle);
    }

    /** The window that follows this one, with no gap and no overlap. */
    public function next(): self
    {
        return self::openingAt($this->end, $this->cycle);
    }

    public function coveredDays(): int
    {
        return max(1, (int) $this->start->diffInDays($this->end));
    }

    public function remainingDays(?CarbonImmutable $at = null): int
    {
        $at ??= CarbonImmutable::now();

        if ($at->greaterThanOrEqualTo($this->end)) {
            return 0;
        }

        return max(0, (int) $at->diffInDays($this->end, false));
    }

    public function isOpen(?CarbonImmutable $at = null): bool
    {
        $at ??= CarbonImmutable::now();

        return $at->greaterThanOrEqualTo($this->start)
            && $at->lessThan($this->end);
    }

    public function hasClosed(?CarbonImmutable $at = null): bool
    {
        $at ??= CarbonImmutable::now();

        return $at->greaterThanOrEqualTo($this->end);
    }

    /** @return array{starts_at: string, ends_at: string, cycle: string} */
    public function toArray(): array
    {
        return [
            'starts_at' => $this->start->toIso8601String(),
            'ends_at'   => $this->end->toIso8601String(),
            'cycle'     => $this->cycle->value,
        ];
    }
}
