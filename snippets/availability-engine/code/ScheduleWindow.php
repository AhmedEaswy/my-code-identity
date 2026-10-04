<?php

declare(strict_types=1);

namespace App\Availability;

use Carbon\CarbonImmutable;
use InvalidArgumentException;

use function count;

/**
 * One continuous, gap-free stretch of working time on a single calendar day.
 *
 * A roster is rarely stored as one row per day. It is stored as fragments — a
 * morning block, an afternoon block, a late block — and a booking is allowed to
 * begin in one fragment and end in the next. Before any slot grid can be laid
 * down, those fragments have to be welded into the longest possible continuous
 * blocks, or a perfectly legal booking across the seam is refused.
 *
 * Midnight is where this gets sharp. A closing time is stored as "00:00", which
 * parses as the *start* of the day it is written on rather than the end of the
 * shift. A late shift recorded as 20:00 → 00:00 therefore has to be lifted onto
 * the following calendar day before blocks can be ordered and merged.
 */
final readonly class ScheduleWindow
{
    private const MIDNIGHT = '00:00';

    public function __construct(
        public CarbonImmutable $start,
        public CarbonImmutable $end,
    ) {
        if ($this->start->greaterThanOrEqualTo($this->end)) {
            throw new InvalidArgumentException('A schedule window must close after it opens.');
        }
    }

    /**
     * Weld a day's fragments into ordered, non-overlapping blocks.
     *
     * Touching fragments join (13:00 ends, 13:00 begins), because the seam
     * between them is bookable. An overlap extends the current block rather
     * than starting a new one.
     *
     * @param iterable<int, array{start: string, end: string}> $fragments
     *
     * @return list<self>
     */
    public static function mergeForDay(iterable $fragments, string $date): array
    {
        $windows = [];

        foreach ($fragments as $fragment) {
            $windows[] = self::fromClockTimes($date, $fragment['start'], $fragment['end']);
        }

        usort($windows, static fn (self $a, self $b): int => $a->start <=> $b->start);

        $merged = [];

        foreach ($windows as $window) {
            $last = $merged[count($merged) - 1] ?? null;

            if ($last !== null && $window->start->lessThanOrEqualTo($last->end)) {
                // Touching or overlapping: keep the later close.
                if ($window->end->greaterThan($last->end)) {
                    $merged[count($merged) - 1] = $last->stretchedTo($window->end);
                }

                continue;
            }

            $merged[] = $window;
        }

        return $merged;
    }

    public function stretchedTo(CarbonImmutable $newEnd): self
    {
        return new self($this->start, $newEnd);
    }

    /** True when [start, end) sits wholly inside this window. */
    public function contains(CarbonImmutable $start, CarbonImmutable $end): bool
    {
        return $start->greaterThanOrEqualTo($this->start)
            && $end->lessThanOrEqualTo($this->end);
    }

    public function overlaps(CarbonImmutable $start, CarbonImmutable $end): bool
    {
        return $start->lessThan($this->end) && $this->start->lessThan($end);
    }

    private static function fromClockTimes(string $date, string $start, string $end): self
    {
        $opens = CarbonImmutable::parse("{$date} {$start}");
        $closes = CarbonImmutable::parse("{$date} {$end}");

        // "00:00" is a close, not an open, and a clock time that runs backwards
        // (22:00 → 06:00) is a shift across midnight too. Both lift a day. Work
        // in absolute instants so a day that gains or loses a DST hour still
        // compares correctly.
        if ($end === self::MIDNIGHT || $closes->lessThan($opens)) {
            $closes = $closes->addDay();
        }

        return new self($opens, $closes);
    }
}
