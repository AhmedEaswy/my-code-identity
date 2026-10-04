<?php

declare(strict_types=1);

namespace App\Mapping;

use Illuminate\Support\Collection;

/**
 * Zoom-tiered grid clustering for a map viewport.
 *
 * The clusterer never decides what a pin *is*; it only knows that every pin
 * has an id, a position, and a kind. It returns either a single `point` or a
 * `cluster` carrying a weighted centroid, a count, and the members that were
 * folded into it.
 *
 * The pipeline is four deliberately separate passes rather than one clever
 * loop, because each pass answers a different question and can be tuned on
 * its own:
 *
 *   grid    — group by a cell sized to the zoom and the item budget
 *   merge   — repair what a grid leaves behind: tiny and overlapping clusters
 *   expand  — turn clusters too small to be worth drawing back into pins
 *   sort    — biggest clusters first, so a caller that trims keeps the
 *             visually important ones
 */
final class GridClusterer
{
    private const int MAX_GROWTH_STEPS = 20;

    private const float MAX_CELL_DEGREES = 90.0;

    public function __construct(
        private readonly int $minClusterCount = 6,
        private readonly int $markerSizePx = 52,
        private readonly float $markerPadding = 1.15,
    ) {}

    /**
     * @param  Collection<int, array{id: int, kind: string, lat: float|int|string, lng: float|int|string, image_url: string}>  $pins
     * @param  array{cluster_radius: float, max_items: int}  $tier
     * @param  array{north: float, south: float, east: float, west: float}|null  $viewport
     * @return list<array<string, mixed>>
     */
    public function cluster(
        Collection $pins,
        float $zoom,
        array $tier,
        string $layer,
        bool $clustersOnly,
        ?array $viewport = null,
    ): array {
        if ($pins->isEmpty()) {
            return [];
        }

        $maxItems = (int) $tier['max_items'];
        $cellSize = ClusterMath::initialCellSize($zoom, (float) $tier['cluster_radius'], $maxItems, $viewport, $pins);
        $results = $this->buildClusters($pins, $cellSize, $zoom, $layer, $clustersOnly);

        // A grid that is too fine can produce more clusters than the budget.
        // Doubling the cell is the cheapest way to shrink the count without
        // recomputing pairwise distances. The cap stops a pathological spread
        // (one pin per hemisphere) from looping forever.
        $steps = 0;
        while (count($results) > $maxItems && $cellSize < self::MAX_CELL_DEGREES && $steps < self::MAX_GROWTH_STEPS) {
            $cellSize *= 2;
            $results = $this->buildClusters($pins, $cellSize, $zoom, $layer, $clustersOnly);
            $steps++;
        }

        $results = $this->mergeBelowMinimum($results, $zoom, $layer);
        $results = $this->mergeUntilWithinBudget($results, $maxItems, $zoom, $layer);
        $results = $this->mergeWithinSeparation($results, $zoom, $layer);
        $results = $this->expandTinyClusters($results, $layer);

        return $this->sortByCount($results);
    }

    /**
     * At high zoom the caller wants raw pins, capped at the budget. Ordering
     * is the caller's job, so this is a straight truncation.
     *
     * @param  Collection<int, array{id: int, kind: string, lat: float|int|string, lng: float|int|string, image_url: string}>  $pins
     * @return list<array<string, mixed>>
     */
    public function asPoints(Collection $pins, int $maxItems, string $layer): array
    {
        return $pins->take($maxItems)->map(fn (array $pin): array => $this->toPoint($pin, $layer))->values()->all();
    }

    /**
     * @param  Collection<int, array<string, mixed>>  $pins
     * @return list<array<string, mixed>>
     */
    private function buildClusters(Collection $pins, float $cellSize, float $zoom, string $layer, bool $clustersOnly): array
    {
        $buckets = [];

        foreach ($pins as $pin) {
            $key = ClusterMath::cellKey((float) $pin['lat'], (float) $pin['lng'], $cellSize);
            $buckets[$key][] = $pin;
        }

        $output = [];

        foreach ($buckets as $key => $members) {
            if (count($members) === 1 && ! $clustersOnly) {
                $output[] = $this->toPoint($members[0], $layer);

                continue;
            }

            $output[] = $this->makeCluster($members, $zoom, $layer, $key);
        }

        return $output;
    }

    /**
     * @param  array<int, array<string, mixed>>  $members
     * @return array<string, mixed>
     */
    private function makeCluster(array $members, float $zoom, string $layer, string $key): array
    {
        [$lat, $lng] = ClusterMath::centroid($members);

        return [
            'type' => 'cluster',
            'layer' => $layer,
            'id' => sprintf('cluster_%s_%s_%s', ClusterMath::zoomKey($zoom), $layer, $key),
            'lat' => $lat,
            'lng' => $lng,
            'count' => count($members),
            'members' => array_values($members),
        ];
    }

    /**
     * @param  array<string, mixed>  $pin
     * @return array<string, mixed>
     */
    private function toPoint(array $pin, string $layer): array
    {
        return [
            'type' => 'point',
            'layer' => $layer,
            'id' => $pin['id'],
            'kind' => $pin['kind'],
            'lat' => (float) $pin['lat'],
            'lng' => (float) $pin['lng'],
            'image_url' => $pin['image_url'],
        ];
    }

    /**
     * A cluster smaller than the minimum is not worth a marker; fold the
     * smallest one into its nearest neighbour and repeat. Each pass removes
     * exactly one cluster, so a bound of 2n guarantees termination even when
     * the nearest-neighbour search keeps returning the same target.
     *
     * @param  array<int, array<string, mixed>>  $clusters
     * @return list<array<string, mixed>>
     */
    private function mergeBelowMinimum(array $clusters, float $zoom, string $layer): array
    {
        $clusters = $this->onlyClusters($clusters);

        for ($pass = 0, $limit = count($clusters) * 2; $pass < $limit; $pass++) {
            $smallest = $this->smallestIndexBelow($clusters, $this->minClusterCount);

            if ($smallest === null) {
                break;
            }

            $nearest = $this->nearestIndex($clusters, $smallest);

            if ($nearest === null) {
                break;
            }

            $clusters[$nearest] = $this->mergeTwo($clusters[$nearest], $clusters[$smallest], $zoom, $layer, "min_{$pass}_{$smallest}");
            unset($clusters[$smallest]);
            $clusters = array_values($clusters);
        }

        return $clusters;
    }

    /**
     * @param  array<int, array<string, mixed>>  $clusters
     * @return list<array<string, mixed>>
     */
    private function mergeUntilWithinBudget(array $clusters, int $maxItems, float $zoom, string $layer): array
    {
        $clusters = $this->onlyClusters($clusters);

        for ($pass = 0, $limit = max(0, count($clusters) - $maxItems) + 10; $pass < $limit && count($clusters) > $maxItems; $pass++) {
            $pair = $this->closestPair($clusters);

            if ($pair === null) {
                break;
            }

            [$first, $second] = $pair;
            $clusters[$first] = $this->mergeTwo($clusters[$first], $clusters[$second], $zoom, $layer, "cap_{$pass}_{$first}_{$second}");
            unset($clusters[$second]);
            $clusters = array_values($clusters);
        }

        return array_slice($clusters, 0, $maxItems);
    }

    /**
     * Merge any two clusters whose centroids are closer than one marker width.
     * The nearest pair is recomputed after every merge, and once that pair is
     * far enough apart every other pair is too, so the first clear pair ends
     * the pass.
     *
     * @param  array<int, array<string, mixed>>  $clusters
     * @return list<array<string, mixed>>
     */
    private function mergeWithinSeparation(array $clusters, float $zoom, string $layer): array
    {
        $clusters = $this->onlyClusters($clusters);

        if (count($clusters) < 2) {
            return $clusters;
        }

        $minSeparation = ClusterMath::minSeparationDegrees($zoom, $this->markerSizePx, $this->markerPadding);

        for ($pass = 0, $limit = count($clusters) * 2; $pass < $limit; $pass++) {
            $pair = $this->closestPair($clusters);

            if ($pair === null) {
                break;
            }

            [$first, $second] = $pair;

            if (ClusterMath::distance($clusters[$first], $clusters[$second]) >= $minSeparation) {
                break;
            }

            $clusters[$first] = $this->mergeTwo($clusters[$first], $clusters[$second], $zoom, $layer, "sep_{$pass}_{$first}_{$second}");
            unset($clusters[$second]);
            $clusters = array_values($clusters);
        }

        return $clusters;
    }

    /**
     * A cluster of one or two is visually a pin that lost its label, so it is
     * expanded back into individual pins. This costs render work, so it runs
     * last — and it may push the count back over budget on purpose: the
     * budget bounds the grid, expansion restores truthfulness.
     *
     * @param  array<int, array<string, mixed>>  $results
     * @return list<array<string, mixed>>
     */
    private function expandTinyClusters(array $results, string $layer): array
    {
        $output = [];

        foreach ($results as $item) {
            if ($item['type'] !== 'cluster') {
                $output[] = $item;

                continue;
            }

            if ((int) $item['count'] >= $this->minClusterCount) {
                // Members are internal bookkeeping; strip them so the payload
                // the browser receives stays small.
                unset($item['members']);
                $output[] = $item;

                continue;
            }

            foreach ($item['members'] ?? [] as $member) {
                $output[] = $this->toPoint($member, $layer);
            }
        }

        return $output;
    }

    /**
     * @param  array<int, array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    private function onlyClusters(array $items): array
    {
        return array_values(array_filter($items, fn (array $item): bool => $item['type'] === 'cluster'));
    }

    /**
     * @param  array<int, array<string, mixed>>  $clusters
     */
    private function smallestIndexBelow(array $clusters, int $minimum): ?int
    {
        $index = null;
        $count = PHP_INT_MAX;

        foreach ($clusters as $i => $cluster) {
            if ($cluster['count'] < $minimum && $cluster['count'] < $count) {
                $count = $cluster['count'];
                $index = $i;
            }
        }

        return $index;
    }

    /**
     * @param  array<int, array<string, mixed>>  $clusters
     */
    private function nearestIndex(array $clusters, int $from): ?int
    {
        $index = null;
        $best = PHP_FLOAT_MAX;

        foreach ($clusters as $i => $cluster) {
            if ($i === $from) {
                continue;
            }

            $distance = ClusterMath::distance($clusters[$from], $cluster);

            if ($distance < $best) {
                $best = $distance;
                $index = $i;
            }
        }

        return $index;
    }

    /**
     * O(n^2), but n has already been reduced to near the budget by the grid
     * pass, so this is the price of the exact nearest pair. A spatial index
     * pays off only for budgets far above a thumbnail.
     *
     * @param  array<int, array<string, mixed>>  $clusters
     * @return array{0: int, 1: int}|null
     */
    private function closestPair(array $clusters): ?array
    {
        $pair = null;
        $best = PHP_FLOAT_MAX;
        $count = count($clusters);

        for ($i = 0; $i < $count - 1; $i++) {
            for ($j = $i + 1; $j < $count; $j++) {
                $distance = ClusterMath::distance($clusters[$i], $clusters[$j]);

                if ($distance < $best) {
                    $best = $distance;
                    $pair = [$i, $j];
                }
            }
        }

        return $pair;
    }

    /**
     * @param  array<string, mixed>  $first
     * @param  array<string, mixed>  $second
     * @return array<string, mixed>
     */
    private function mergeTwo(array $first, array $second, float $zoom, string $layer, string $key): array
    {
        $firstCount = (int) $first['count'];
        $secondCount = (int) $second['count'];
        $total = $firstCount + $secondCount;

        // Weight by member count so the merged centroid still reflects where
        // the pins actually are; a plain midpoint would drift toward the
        // smaller cluster.
        return [
            'type' => 'cluster',
            'layer' => $layer,
            'id' => sprintf('cluster_%s_%s_%s', ClusterMath::zoomKey($zoom), $layer, $key),
            'lat' => round((((float) $first['lat'] * $firstCount) + ((float) $second['lat'] * $secondCount)) / $total, 8),
            'lng' => round((((float) $first['lng'] * $firstCount) + ((float) $second['lng'] * $secondCount)) / $total, 8),
            'count' => $total,
            'members' => array_merge($first['members'] ?? [], $second['members'] ?? []),
        ];
    }

    /**
     * @param  array<int, array<string, mixed>>  $results
     * @return list<array<string, mixed>>
     */
    private function sortByCount(array $results): array
    {
        usort($results, function (array $a, array $b): int {
            $left = $a['type'] === 'cluster' ? (int) $a['count'] : 0;
            $right = $b['type'] === 'cluster' ? (int) $b['count'] : 0;

            return $right <=> $left;
        });

        return $results;
    }
}
