<?php

declare(strict_types=1);

namespace App\Mapping;

use Illuminate\Support\Collection;

/**
 * The geometry the grid clusterer runs on: web-mercator-flavoured cell
 * sizing, weighted centroids, and the dateline/pole cases a naive "divide the
 * world into squares" approach gets wrong.
 *
 * Everything here works in raw degrees, not metres. That is a deliberate
 * simplification — the tradeoff is called out in the snippet README.
 */
final class ClusterMath
{
    private const int TILE_SIZE_PX = 256;

    private const int MAX_ZOOM = 21;

    private const float MIN_SPAN = 0.000_01;

    private const float MIN_CELL = 0.000_01;

    /**
     * Cell size for a zoom level, scaled by the tier's radius multiplier. At
     * zoom z the world is 256 * 2^z pixels wide, so one degree is
     * 256 * 2^z / 360 pixels; multiplying the degree size by the radius
     * widens the cell without touching the zoom arithmetic.
     */
    public static function cellSize(float $zoom, float $radiusMultiplier): float
    {
        $degrees = 360.0 / (self::TILE_SIZE_PX * (2 ** self::clampZoom($zoom)));

        return max($degrees * $radiusMultiplier, self::MIN_CELL);
    }

    /**
     * Pick the starting cell so the grid cannot, by itself, exceed the item
     * budget on the first pass. When the caller supplies a viewport we size
     * against it; otherwise we fall back to the pins' own bounding box.
     *
     * @param  array{north: float, south: float, east: float, west: float}|null  $viewport
     * @param  Collection<int, array<string, mixed>>  $pins
     */
    public static function initialCellSize(
        float $zoom,
        float $radiusMultiplier,
        int $maxItems,
        ?array $viewport,
        Collection $pins,
    ): float {
        $base = self::cellSize($zoom, $radiusMultiplier);
        $divisions = max(1, (int) ceil(sqrt($maxItems)));

        if ($viewport !== null) {
            $span = max(
                self::MIN_SPAN,
                $viewport['north'] - $viewport['south'],
                self::longitudeSpan($viewport['west'], $viewport['east']),
            );

            return max($base, $span / $divisions);
        }

        $latitudes = $pins->map(fn (array $pin): float => (float) $pin['lat']);
        $longitudes = $pins->map(fn (array $pin): float => (float) $pin['lng']);
        $span = max(
            self::MIN_SPAN,
            $latitudes->max() - $latitudes->min(),
            $longitudes->max() - $longitudes->min(),
        );

        return max($base, $span / $divisions);
    }

    /**
     * How far apart two cluster markers must be before they stop touching on
     * screen: one marker wide, padded a little, converted from pixels to
     * degrees at this zoom.
     */
    public static function minSeparationDegrees(float $zoom, int $markerSizePx, float $padding): float
    {
        $degreesPerPixel = 360.0 / (self::TILE_SIZE_PX * (2 ** self::clampZoom($zoom)));

        return $degreesPerPixel * $markerSizePx * $padding;
    }

    /**
     * A grid cell key. floor() (not round) is what keeps pins that sit either
     * side of a boundary in adjacent buckets instead of swapping as the
     * viewport scrolls a pixel.
     */
    public static function cellKey(float $lat, float $lng, float $cellSize): string
    {
        $row = (int) floor($lat / $cellSize);
        $col = (int) floor($lng / $cellSize);

        return "{$row}_{$col}";
    }

    /**
     * @param  array<string, mixed>  $first
     * @param  array<string, mixed>  $second
     */
    public static function distance(array $first, array $second): float
    {
        $latDelta = (float) $first['lat'] - (float) $second['lat'];
        $lngDelta = (float) $first['lng'] - (float) $second['lng'];

        return sqrt(($latDelta * $latDelta) + ($lngDelta * $lngDelta));
    }

    /**
     * @param  array<int, array<string, mixed>>  $members
     * @return array{0: float, 1: float}
     */
    public static function centroid(array $members): array
    {
        $lat = 0.0;
        $lng = 0.0;

        foreach ($members as $member) {
            $lat += (float) $member['lat'];
            $lng += (float) $member['lng'];
        }

        $count = max(1, count($members));

        return [round($lat / $count, 8), round($lng / $count, 8)];
    }

    /**
     * Width of a longitude interval that may wrap the antimeridian. A
     * viewport with west > east crosses +/-180 and must be measured the short
     * way around, or the grid gets sized for the whole planet.
     */
    public static function longitudeSpan(float $west, float $east): float
    {
        if ($west <= $east) {
            return $east - $west;
        }

        return (180.0 - $west) + ($east + 180.0);
    }

    public static function zoomKey(float $zoom): string
    {
        return str_replace('.', '_', rtrim(rtrim(sprintf('%.4f', $zoom), '0'), '.'));
    }

    private static function clampZoom(float $zoom): int
    {
        return (int) max(0, min(self::MAX_ZOOM, $zoom));
    }
}
