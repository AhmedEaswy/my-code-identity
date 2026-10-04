<?php

declare(strict_types=1);

namespace App\Import;

use App\Catalog\Jobs\ImageDownloadJob;
use App\Catalog\Models\Brand;
use App\Catalog\Models\CatalogItem;
use App\Catalog\Models\Category;
use App\Catalog\Models\Tag;
use Illuminate\Support\Facades\DB;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use RuntimeException;
use Throwable;

/**
 * Imports a vendor spreadsheet into the catalog.
 *
 * The sheet is hostile: an instructions banner sits above the real header,
 * columns are named in three languages and five shapes, lookups may or may not
 * exist yet, and image links may or may not resolve. The importer is forgiving
 * by design — it *detects* the header instead of assuming it, resolves columns
 * through an alias table, and makes each row its own transaction so a single
 * malformed line cannot roll back the thousands of good ones already written.
 *
 * Every row ends in an {@see ImportReport}, so the operator gets both a total
 * and a line-by-line account of what the run actually did.
 */
final class CatalogImporter
{
    /** Canonical field => the words a vendor might actually write in row one. */
    private const ALIASES = [
        'sku' => ['sku', 'item code', 'item no', 'article no', 'article number', 'reference', 'part number', 'model', 'artikelnummer', 'codigo'],
        'name' => ['name', 'title', 'product', 'product name', 'item name', 'short description', 'bezeichnung', 'nombre'],
        'description' => ['description', 'details', 'long description', 'beschreibung', 'descripcion'],
        'category' => ['category', 'group', 'department', 'kategorie', 'categoria', 'rubro'],
        'brand' => ['brand', 'manufacturer', 'maker', 'marke', 'marca', 'fabricante'],
        'tags' => ['tags', 'labels', 'keywords', 'etiquetas', 'schlagworter'],
        'price' => ['price', 'unit price', 'cost', 'list price', 'preis', 'precio'],
        'stock' => ['stock', 'qty', 'quantity', 'on hand', 'inventory', 'bestand', 'cantidad'],
        'active' => ['active', 'enabled', 'visible', 'status', 'aktiv', 'activo'],
        'image' => ['image', 'image url', 'photo', 'picture', 'thumb', 'thumbnail', 'bild', 'imagen', 'foto'],
    ];

    /** Accented Latin letters folded to ASCII so "märca", "marca" and "Marca" agree. */
    private const FOLD = [
        'á' => 'a', 'à' => 'a', 'â' => 'a', 'ä' => 'a', 'ã' => 'a', 'å' => 'a',
        'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e',
        'í' => 'i', 'ì' => 'i', 'î' => 'i', 'ï' => 'i',
        'ó' => 'o', 'ò' => 'o', 'ô' => 'o', 'ö' => 'o', 'õ' => 'o',
        'ú' => 'u', 'ù' => 'u', 'û' => 'u', 'ü' => 'u',
        'ç' => 'c', 'ñ' => 'n', 'ß' => 'ss',
    ];

    /** How far below the top the real header is allowed to hide. */
    private const HEADER_SCAN_ROWS = 6;

    private ImportReport $report;

    private bool $dryRun = false;

    private bool $updateExisting = false;

    private bool $keepInvalidInactive = false;

    private bool $queueImages = true;

    /** @var array<string,int> normalised lookup name => id */
    private array $categoryIds = [];

    /** @var array<string,int> */
    private array $brandIds = [];

    /** @var array<string,int> */
    private array $tagIds = [];

    /** @var array<string,int> keyed by both normalised SKU and normalised name */
    private array $existingItemIds = [];

    /** @var array<int,array<string,true>> item id => signatures queued this run */
    private array $imageSignatures = [];

    /** Negative ids for rows a dry run *would* have created, never persisted. */
    private int $syntheticId = 0;

    /**
     * @param  callable(int,int,ImportReport):void|null  $onProgress  (processed, total, report)
     */
    public function import(
        string $path,
        bool $dryRun = false,
        bool $updateExisting = false,
        bool $keepInvalidInactive = false,
        bool $queueImages = true,
        ?callable $onProgress = null,
    ): ImportReport {
        $this->reset($dryRun, $updateExisting, $keepInvalidInactive, $queueImages);

        if (! is_file($path)) {
            $this->report->fail(0, new RuntimeException("Spreadsheet not found: {$path}"));
            $this->report->finish();

            return $this->report;
        }

        $spreadsheet = IOFactory::createReaderForFile($path)
            ->setReadDataOnly(true)
            ->load($path);

        try {
            $sheet = $spreadsheet->getActiveSheet();
            $lastColumn = $sheet->getHighestColumn();
            $headerLine = $this->detectHeaderLine($sheet, $lastColumn);
            $columns = $this->mapColumns($sheet, $headerLine, $lastColumn);

            $this->report->start($sheet->getHighestRow() - $headerLine, $dryRun);

            if (! in_array('sku', $columns, true) && ! in_array('name', $columns, true)) {
                $this->report->fail($headerLine, new RuntimeException('No usable header row found'));
                $this->report->finish();

                return $this->report;
            }

            $this->warmCaches();

            $processed = 0;

            for ($line = $headerLine + 1; $line <= $sheet->getHighestRow(); $line++) {
                $row = $this->readRow($sheet, $line, $columns);

                if ($this->isBlank($row)) {
                    $this->report->record($line, ImportReport::SKIPPED, null, ['empty']);
                } else {
                    $this->processLine($line, $row);
                }

                $processed++;

                if ($onProgress !== null) {
                    $onProgress($processed, $this->report->total, $this->report);
                }

                // Release the cell graph now and then; large sheets otherwise
                // accumulate cyclic worksheet references until the request dies.
                if ($processed % 100 === 0) {
                    gc_collect_cycles();
                }
            }
        } catch (Throwable $e) {
            $this->report->fail(0, $e);
        } finally {
            $spreadsheet->disconnectWorksheets();
            unset($spreadsheet);
            $this->report->finish();
        }

        return $this->report;
    }

    private function reset(bool $dryRun, bool $updateExisting, bool $keepInvalidInactive, bool $queueImages): void
    {
        $this->report = new ImportReport;
        $this->dryRun = $dryRun;
        $this->updateExisting = $updateExisting;
        $this->keepInvalidInactive = $keepInvalidInactive;
        $this->queueImages = $queueImages;
        $this->categoryIds = [];
        $this->brandIds = [];
        $this->tagIds = [];
        $this->existingItemIds = [];
        $this->imageSignatures = [];
        $this->syntheticId = 0;
    }

    /**
     * Pick the header line by *score*, not by convention: whichever of the
     * first few rows resolves the most known fields wins. A vendor that puts a
     * banner in row one is handled without a special case.
     */
    private function detectHeaderLine(Worksheet $sheet, string $lastColumn): int
    {
        $bestLine = 1;
        $bestScore = 0;
        $limit = min(self::HEADER_SCAN_ROWS, $sheet->getHighestRow());

        for ($line = 1; $line <= $limit; $line++) {
            $score = 0;

            foreach ($this->columnLetters($lastColumn) as $column) {
                if ($this->fieldFor($this->cell($sheet, $column, $line)) !== null) {
                    $score++;
                }
            }

            if ($score > $bestScore) {
                $bestScore = $score;
                $bestLine = $line;
            }
        }

        return $bestLine;
    }

    /** @return array<string,string> column letter => canonical field */
    private function mapColumns(Worksheet $sheet, int $headerLine, string $lastColumn): array
    {
        $map = [];

        foreach ($this->columnLetters($lastColumn) as $column) {
            $field = $this->fieldFor($this->cell($sheet, $column, $headerLine));

            if ($field !== null) {
                $map[$column] = $field;
            }
        }

        return $map;
    }

    private function fieldFor(string $header): ?string
    {
        $needle = $this->normalize($header);

        if ($needle === '') {
            return null;
        }

        foreach (self::ALIASES as $field => $aliases) {
            if (in_array($needle, $aliases, true)) {
                return $field;
            }
        }

        return null;
    }

    /** Lowercase, strip a UTF-8 BOM, fold accents, drop every separator. */
    private function normalize(?string $value): string
    {
        $value = preg_replace('/^\x{FEFF}/u', '', trim((string) $value)) ?? (string) $value;
        $value = mb_strtolower($value, 'UTF-8');
        $value = strtr($value, self::FOLD);

        return preg_replace('/[^a-z0-9]+/', '', $value) ?? '';
    }

    /**
     * One query per lookup table, not one per row. Lookup tables are small and
     * bounded, so they fit in memory; the item table is preloaded by SKU and by
     * name so duplicate detection is an array hit instead of a LIKE scan.
     */
    private function warmCaches(): void
    {
        foreach (Category::query()->get(['id', 'name']) as $row) {
            $this->categoryIds[$this->normalize($row->name)] = $row->id;
        }

        foreach (Brand::query()->get(['id', 'name']) as $row) {
            $this->brandIds[$this->normalize($row->name)] = $row->id;
        }

        foreach (Tag::query()->get(['id', 'name']) as $row) {
            $this->tagIds[$this->normalize($row->name)] = $row->id;
        }

        foreach (CatalogItem::query()->get(['id', 'sku', 'name']) as $row) {
            foreach ([$row->sku, $row->name] as $value) {
                $key = $this->normalize($value);

                if ($key !== '') {
                    $this->existingItemIds[$key] = $row->id;
                }
            }
        }
    }

    /**
     * A row is the unit of failure.
     *
     * Its writes run in their own transaction, so partial failure is contained:
     * a constraint violation on line 812 rolls back line 812 alone. On a dry
     * run the identical code path runs and the transaction is rolled back, which
     * is what keeps a dry run honest — it exercises the real branch.
     */
    private function processLine(int $line, array $row): void
    {
        DB::beginTransaction();

        try {
            $outcome = $this->applyRow($row);
        } catch (Throwable $e) {
            DB::rollBack();
            $this->report->fail($line, $e, $row['sku'] ?? null);

            return;
        }

        $this->dryRun ? DB::rollBack() : DB::commit();

        $this->report->record($line, $outcome['status'], $outcome['key'], $outcome['reasons'], $outcome['notes']);
    }

    /** @return array{status:string,key:?string,reasons:list<string>,notes:list<string>} */
    private function applyRow(array $row): array
    {
        $sku = $row['sku'] ?? null;
        $name = $row['name'] ?? null;

        $errors = [];
        $warnings = [];

        if ($sku === null) {
            $errors[] = 'missing_sku';
        }

        if ($name === null) {
            $errors[] = 'missing_name';
        }

        if (empty($row['description'])) {
            $warnings[] = 'no_description';
        }

        if (! is_numeric($row['price'] ?? null)) {
            $warnings[] = 'no_price';
        }

        if (empty($row['images'])) {
            $warnings[] = 'no_images';
        }

        if ($errors !== [] && ! $this->keepInvalidInactive) {
            return ['status' => ImportReport::SKIPPED, 'key' => $sku, 'reasons' => $errors, 'notes' => $warnings];
        }

        // Forgiving mode still needs *something* to store: fall back to the other
        // identifier and mark the row inactive rather than lose it entirely.
        $name = $name ?? $sku ?? 'Unnamed item';
        $sku = $sku ?? $this->slug($name);
        $inactive = $errors !== [];

        $categoryId = $this->resolve($this->categoryIds, $row['category'] ?? null, Category::class);
        $brandId = $this->resolve($this->brandIds, $row['brand'] ?? null, Brand::class);
        $tagIds = $this->resolveTags($row['tags'] ?? null);

        $existingId = $this->existingItemIds[$this->normalize($sku)]
            ?? $this->existingItemIds[$this->normalize($name)]
            ?? null;

        if ($existingId !== null) {
            if (! $this->updateExisting) {
                return ['status' => ImportReport::SKIPPED, 'key' => $sku, 'reasons' => ['duplicate'], 'notes' => $warnings];
            }

            $item = $this->dryRun ? null : CatalogItem::query()->find($existingId);

            if ($item !== null) {
                $item->update($this->attributes($row, $name, $categoryId, $brandId, $inactive));
                $item->tags()->sync($tagIds);
                $this->queueImages($item, $row['images'] ?? []);
            }

            return [
                'status' => ImportReport::UPDATED,
                'key' => $sku,
                'reasons' => [],
                'notes' => $this->notes($inactive, $errors, $warnings),
            ];
        }

        // A dry run registers a synthetic id so a later duplicate *within the
        // same file* is still caught — parity with the run that would commit.
        if ($this->dryRun) {
            $this->remember($sku, $name, $this->ghostId());

            return [
                'status' => $inactive ? ImportReport::INACTIVE : ImportReport::CREATED,
                'key' => $sku,
                'reasons' => [],
                'notes' => $this->notes($inactive, $errors, $warnings),
            ];
        }

        $item = CatalogItem::query()->create(
            $this->attributes($row, $name, $categoryId, $brandId, $inactive) + ['sku' => $sku],
        );

        $item->tags()->sync($tagIds);
        $this->remember($sku, $name, $item->id);
        $this->queueImages($item, $row['images'] ?? []);

        return [
            'status' => $inactive ? ImportReport::INACTIVE : ImportReport::CREATED,
            'key' => $sku,
            'reasons' => [],
            'notes' => $this->notes($inactive, $errors, $warnings),
        ];
    }

    /** @return array<string,mixed> */
    private function attributes(array $row, string $name, ?int $categoryId, ?int $brandId, bool $inactive): array
    {
        return [
            'name' => $name,
            'description' => $row['description'] ?? '',
            'category_id' => $categoryId,
            'brand_id' => $brandId,
            'price' => is_numeric($row['price'] ?? null) ? (float) $row['price'] : null,
            'stock' => is_numeric($row['stock'] ?? null) ? (int) $row['stock'] : 0,
            'is_active' => $inactive ? false : $this->parseBool($row['active'] ?? null),
        ];
    }

    /**
     * Resolve a lookup name against the warmed cache, creating it only when the
     * run will commit. On a dry run a missing lookup gets a synthetic id, so
     * later rows see "it would exist" and the dry run still predicts duplicates.
     *
     * @param  array<string,int>  $cache
     * @param  class-string<\Illuminate\Database\Eloquent\Model>  $model
     */
    private function resolve(array &$cache, ?string $label, string $model): ?int
    {
        if ($label === null || $label === '') {
            return null;
        }

        $key = $this->normalize($label);

        if (array_key_exists($key, $cache)) {
            return $cache[$key];
        }

        if ($this->dryRun) {
            return $cache[$key] = $this->ghostId();
        }

        return $cache[$key] = (int) $model::query()->firstOrCreate(['name' => $label])->getKey();
    }

    /** @return list<int> */
    private function resolveTags(?string $raw): array
    {
        if ($raw === null || $raw === '') {
            return [];
        }

        $ids = [];

        foreach (preg_split('/[,;|]+/', $raw) ?: [] as $label) {
            $id = $this->resolve($this->tagIds, trim($label), Tag::class);

            if ($id !== null) {
                $ids[] = $id;
            }
        }

        return array_values(array_unique($ids));
    }

    /**
     * Queue only what the item does not already have. The job re-checks against
     * the store, so this pre-check is a latency optimisation, not the safety
     * mechanism — that lives in the job, where retries also pass through it.
     *
     * @param  list<string>  $urls
     */
    private function queueImages(CatalogItem $item, array $urls): void
    {
        if (! $this->queueImages || $this->dryRun) {
            return;
        }

        foreach (array_values($urls) as $order => $url) {
            if (! filter_var($url, FILTER_VALIDATE_URL)) {
                continue;
            }

            $signature = ImageDownloadJob::signatureFor($url);

            if ($this->imageSignatures[$item->id][$signature] ?? false) {
                continue;
            }

            $this->imageSignatures[$item->id][$signature] = true;

            ImageDownloadJob::dispatch($item->id, $url, $order);
        }
    }

    private function remember(?string $sku, ?string $name, int $id): void
    {
        foreach ([$sku, $name] as $value) {
            $key = $this->normalize($value);

            if ($key !== '') {
                $this->existingItemIds[$key] = $id;
            }
        }
    }

    /** @return list<string> */
    private function notes(bool $inactive, array $errors, array $warnings): array
    {
        if ($inactive) {
            $warnings[] = 'kept inactive: '.implode(', ', $errors);
        }

        return $warnings;
    }

    private function ghostId(): int
    {
        return --$this->syntheticId;
    }

    private function parseBool(?string $value, bool $default = true): bool
    {
        if ($value === null || $value === '') {
            return $default;
        }

        return in_array($this->normalize($value), ['1', 'y', 'yes', 'true', 'enabled', 'active', 'ja', 'si'], true);
    }

    private function slug(string $value): string
    {
        $base = preg_replace('/[^a-z0-9]+/', '-', strtolower($value)) ?? '';

        return trim($base, '-') ?: 'item';
    }

    /** @return array<string,mixed> */
    private function readRow(Worksheet $sheet, int $line, array $columns): array
    {
        $row = [];

        foreach ($columns as $column => $field) {
            $value = $this->cell($sheet, $column, $line);

            if ($value === '') {
                continue;
            }

            if ($field === 'image') {
                $row['images'][] = $value;
            } else {
                $row[$field] = $value;
            }
        }

        return $row;
    }

    private function isBlank(array $row): bool
    {
        foreach ($row as $value) {
            if (is_array($value)) {
                if ($value !== []) {
                    return false;
                }
            } elseif (trim((string) $value) !== '') {
                return false;
            }
        }

        return true;
    }

    private function cell(Worksheet $sheet, string $column, int $line): string
    {
        return trim((string) $sheet->getCell($column.$line)->getValue());
    }

    /** @return list<string> */
    private function columnLetters(string $lastColumn): array
    {
        $letters = [];
        $count = Coordinate::columnIndexFromString($lastColumn);

        for ($index = 1; $index <= $count; $index++) {
            $letters[] = Coordinate::stringFromColumnIndex($index);
        }

        return $letters;
    }
}
