<?php

declare(strict_types=1);

namespace App\Billing;

use InvalidArgumentException;

/**
 * The cadence a plan is sold on.
 *
 * Deliberately tiny: the cadence decides how many months a renewal adds and
 * which price column a plan exposes, and nothing else should ever branch on
 * the raw string. Keeping it an enum means an unknown value fails at the edge
 * instead of turning into a surprise at renewal time.
 */
enum BillingCycle: string
{
    case Monthly = 'monthly';
    case Yearly  = 'yearly';

    public function months(): int
    {
        return $this === self::Yearly ? 12 : 1;
    }

    public function isYearly(): bool
    {
        return $this === self::Yearly;
    }

    public function label(): string
    {
        return match ($this) {
            self::Monthly => 'Monthly',
            self::Yearly  => 'Yearly',
        };
    }

    public static function fromKey(string $value): self
    {
        return self::tryFrom($value) ?? throw new InvalidArgumentException(
            "Unsupported billing cycle '{$value}'; expected one of: "
            . implode(', ', array_map(fn (self $case): string => $case->value, self::cases())) . '.'
        );
    }
}
