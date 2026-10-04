<?php

declare(strict_types=1);

namespace App\Availability;

use Carbon\CarbonImmutable;

use function array_map;

/**
 * Turns a day's working fragments into a bookable slot grid, and answers the
 * one question the grid cannot: "may this exact range be booked?"
 *
 * The grid is a *display* convenience. It quantises the day into fixed steps so
 * a customer can pick a start time, and it tags every step with a state. The
 * rule that actually permits a booking is `rangeIsBookable()`, which checks a
 * continuous range against the schedule and the real bookings directly. Keeping
 * the two separate means the grid may round a time to the nearest step without
 * ever having the authority to approve a booking the range check would refuse.
 *
 * All times are local wall-clock for one service location. Absolute instants
 * (not offsets) are compared, so a DST transition is just a longer or shorter
 * day and not a special case in the merge.
 */
final class AvailabilityEngine
{
    public const STATE_AVAILABLE = 'available';

    public const STATE_BOOKED = 'booked';

    public const STATE_UNAVAILABLE = 'unavailable';

    public const STATE_SELECTED = 'selected';

    /** Providers publish their day on a fixed grid, in minutes. */
    private const GRID_STEP = 10;

    private const DEFAULT_LEAD_HOURS = 2;

    private const DEFAULT_HORIZON_MONTHS = 12;

    /**
     * Every slot for one day, on one grid, tagged with its state.
     *
     * Policy keys (all optional):
     *   schedule           list<array{start: string, end: string}> the day's working fragments
     *   booked             list<array{start: string, end: string}> confirmed bookings, local times
     *   held               list<array{start: string, duration: int}> ranges already picked this booking
     *   home_service       bool   whether the provider travels to the customer
     *   travel_minutes     int    transit buffer appended after each booking (home service only)
     *   lead_hours         int    minimum notice before a slot may be booked
     *   horizon_months     int    furthest ahead a slot may be booked
     *   now                CarbonImmutable  injected clock (tests)
     *
     * @param array<string, mixed> $policy
     *
     * @return list<array{start_time: string, starts_at: string, date: string, state: string}>
     */
    public function dayGrid(string $date, int $serviceMinutes, array $policy = []): array
    {
        $settings = $this->settings($policy);
        $blocks = ScheduleWindow::mergeForDay($settings['schedule'], $date);

        if ($blocks === []) {
            return [];
        }

        $busy = $this->busyIntervals($date, $settings['booked'], $settings['travel_minutes']);
        $held = $this->heldIntervals($date, $settings['held']);

        $floor = $settings['now']->addHours($settings['lead_hours']);
        $ceiling = $settings['now']->addMonths($settings['horizon_months']);

        $slots = [];

        foreach ($blocks as $block) {
            // Start on the block's own opening minute and step by a fixed
            // interval. A slot is emitted even when it will not fit; that tail
            // is what the customer sees greyed out at the edge of the day.
            for ($start = $block->start; $start->lessThan($block->end); $start = $start->addMinutes(self::GRID_STEP)) {
                $end = $start->addMinutes($serviceMinutes);

                $slots[] = [
                    'start_time' => $start->format('H:i'),
                    'starts_at' => $start->toIso8601String(),
                    'date' => $start->format('Y-m-d'),
                    'state' => $this->stateFor($start, $end, $block, $busy, $held, $floor, $ceiling),
                ];
            }
        }

        return $slots;
    }

    /**
     * The authoritative check, independent of the 10-minute grid. A request may
     * begin at any minute; the whole [start, start + serviceMinutes) range must
     * fit inside one continuous working block and clear every busy interval and
     * every range already held for this booking.
     *
     * @param array<string, mixed> $policy same keys as dayGrid(), plus
     *                                     ignore_booked_index to skip the row being rescheduled
     */
    public function rangeIsBookable(string $date, string $startTime, int $serviceMinutes, array $policy = []): bool
    {
        $settings = $this->settings($policy);
        $start = CarbonImmutable::parse("{$date} {$startTime}");
        $end = $start->addMinutes($serviceMinutes);

        $floor = $settings['now']->addHours($settings['lead_hours']);
        $ceiling = $settings['now']->addMonths($settings['horizon_months']);

        if ($start->lessThan($floor) || $start->greaterThan($ceiling)) {
            return false;
        }

        $fits = false;

        foreach (ScheduleWindow::mergeForDay($settings['schedule'], $date) as $block) {
            if ($block->contains($start, $end)) {
                $fits = true;

                break;
            }
        }

        if (! $fits) {
            return false;
        }

        $busy = $this->busyIntervals($date, $settings['booked'], $settings['travel_minutes']);

        if ($this->overlapsAny($start, $end, $busy, $settings['ignore_booked_index'])) {
            return false;
        }

        foreach ($this->heldIntervals($date, $settings['held']) as $range) {
            if ($this->overlaps($start, $end, $range['start'], $range['end'])) {
                return false;
            }
        }

        return true;
    }

    private function stateFor(
        CarbonImmutable $start,
        CarbonImmutable $end,
        ScheduleWindow $block,
        array $busy,
        array $held,
        CarbonImmutable $floor,
        CarbonImmutable $ceiling,
    ): string {
        // The service would spill past the close of this working block.
        if (! $block->contains($start, $end)) {
            return self::STATE_UNAVAILABLE;
        }

        if ($this->overlapsAny($start, $end, $busy)) {
            return self::STATE_BOOKED;
        }

        // A range the customer already holds is not free to pick again, and a
        // new booking may not overlap it.
        foreach ($held as $range) {
            if ($start->greaterThanOrEqualTo($range['start']) && $start->lessThan($range['end'])) {
                return self::STATE_SELECTED;
            }

            if ($this->overlaps($start, $end, $range['start'], $range['end'])) {
                return self::STATE_UNAVAILABLE;
            }
        }

        if ($start->lessThan($floor) || $start->greaterThan($ceiling)) {
            return self::STATE_UNAVAILABLE;
        }

        return self::STATE_AVAILABLE;
    }

    /**
     * Confirmed bookings as absolute busy intervals. On a home-service call a
     * transit buffer is appended after the booking — the provider cannot begin
     * the next job until they have travelled — but never before the first one,
     * which is why the buffer is asymmetric.
     *
     * @param list<array{start: string, end: string}> $booked
     *
     * @return list<array{start: CarbonImmutable, end: CarbonImmutable}>
     */
    private function busyIntervals(string $date, array $booked, int $travelMinutes): array
    {
        return array_map(function (array $block) use ($date, $travelMinutes): array {
            $start = CarbonImmutable::parse("{$date} {$block['start']}");
            $end = CarbonImmutable::parse("{$date} {$block['end']}");

            if ($end->lessThanOrEqualTo($start)) {
                $end = $end->addDay();
            }

            return [
                'start' => $start,
                'end' => $travelMinutes > 0 ? $end->addMinutes($travelMinutes) : $end,
            ];
        }, $booked);
    }

    /**
     * @param list<array{start: string, duration: int}> $held
     *
     * @return list<array{start: CarbonImmutable, end: CarbonImmutable}>
     */
    private function heldIntervals(string $date, array $held): array
    {
        return array_map(function (array $range) use ($date): array {
            $start = CarbonImmutable::parse("{$date} {$range['start']}");

            return ['start' => $start, 'end' => $start->addMinutes((int) $range['duration'])];
        }, $held);
    }

    /**
     * @param list<array{start: CarbonImmutable, end: CarbonImmutable}> $intervals
     */
    private function overlapsAny(
        CarbonImmutable $start,
        CarbonImmutable $end,
        array $intervals,
        ?int $skipIndex = null,
    ): bool {
        foreach ($intervals as $index => $interval) {
            if ($index === $skipIndex) {
                continue;
            }

            if ($this->overlaps($start, $end, $interval['start'], $interval['end'])) {
                return true;
            }
        }

        return false;
    }

    private function overlaps(
        CarbonImmutable $start,
        CarbonImmutable $end,
        CarbonImmutable $otherStart,
        CarbonImmutable $otherEnd,
    ): bool {
        // Half-open ranges: a booking that ends exactly when the next begins
        // does not overlap, which is what lets back-to-back jobs coexist.
        return $start->lessThan($otherEnd) && $otherStart->lessThan($end);
    }

    /**
     * @param array<string, mixed> $policy
     *
     * @return array<string, mixed>
     */
    private function settings(array $policy): array
    {
        $homeService = (bool) ($policy['home_service'] ?? false);

        return [
            'schedule' => $policy['schedule'] ?? [],
            'booked' => $policy['booked'] ?? [],
            'held' => $policy['held'] ?? [],
            'travel_minutes' => $homeService ? (int) ($policy['travel_minutes'] ?? 0) : 0,
            'lead_hours' => (int) ($policy['lead_hours'] ?? self::DEFAULT_LEAD_HOURS),
            'horizon_months' => (int) ($policy['horizon_months'] ?? self::DEFAULT_HORIZON_MONTHS),
            'now' => $policy['now'] ?? CarbonImmutable::now(),
            'ignore_booked_index' => $policy['ignore_booked_index'] ?? null,
        ];
    }
}
