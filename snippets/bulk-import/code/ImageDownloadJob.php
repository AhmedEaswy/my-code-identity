<?php

declare(strict_types=1);

namespace App\Catalog\Jobs;

use App\Catalog\Contracts\ImageStore;
use App\Catalog\Models\CatalogItem;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

/**
 * Downloads one catalog image and hands it to the store.
 *
 * The row is already committed by the time this runs, so the job never touches
 * the import transaction — a slow or dead image host cannot hold a database
 * transaction open. It is safe to run twice: the importer and the job derive
 * the *same* signature from the source URL, and the job refuses to attach an
 * image the store already holds. A retry therefore re-uses one signature and
 * can only fill a gap, never create a duplicate.
 */
final class ImageDownloadJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;

    public int $backoff = 30;

    public int $timeout = 120;

    public function __construct(
        public readonly int $itemId,
        public readonly string $sourceUrl,
        public readonly int $order = 0,
    ) {}

    public function handle(ImageStore $store): void
    {
        $item = CatalogItem::query()->find($this->itemId);

        if ($item === null) {
            return;
        }

        if ($store->hasImage($item, self::signatureFor($this->sourceUrl))) {
            return;
        }

        $staged = null;

        try {
            $staged = $this->download($this->sourceUrl);

            $store->attach($item, $staged, $this->sourceUrl, $this->order);
        } catch (Throwable $e) {
            // Retry only while attempts remain; the last failure is logged and
            // swallowed so the queue does not retry it forever.
            if ($this->attempts() < $this->tries) {
                throw $e;
            }

            Log::error('Catalog image download failed permanently', [
                'item_id' => $this->itemId,
                'url' => $this->sourceUrl,
                'error' => $e->getMessage(),
            ]);
        } finally {
            if ($staged !== null && Storage::disk('local')->exists($staged)) {
                Storage::disk('local')->delete($staged);
            }
        }
    }

    /**
     * A stable identity for a source image: its lowercased file name with any
     * cache-busting query string or `-800x600` resize suffix removed. Two URLs
     * that resolve to the same file collapse to one signature, so the importer
     * can skip it and the job can refuse it.
     */
    public static function signatureFor(string $url): string
    {
        $path = parse_url($url, PHP_URL_PATH) ?: $url;
        $name = strtolower(basename($path));
        $name = preg_replace('/-[0-9]+x[0-9]+(?=\.[a-z0-9]+$)/', '', $name) ?? $name;

        return sha1($name);
    }

    private function download(string $url): string
    {
        $response = Http::timeout(30)
            ->connectTimeout(5)
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException("Image download returned HTTP {$response->status()}");
        }

        $contentType = (string) $response->header('Content-Type');

        if ($contentType !== '' && ! str_starts_with($contentType, 'image/')) {
            throw new RuntimeException("URL is not an image ({$contentType})");
        }

        $path = 'staging/images/'.sha1($url).'.'.$this->extension($url, $contentType);

        Storage::disk('local')->put($path, $response->body());

        return $path;
    }

    private function extension(string $url, string $contentType): string
    {
        $extension = strtolower(pathinfo((string) parse_url($url, PHP_URL_PATH), PATHINFO_EXTENSION));

        if (in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'], true)) {
            return $extension === 'jpeg' ? 'jpg' : $extension;
        }

        return match (true) {
            str_contains($contentType, 'png') => 'png',
            str_contains($contentType, 'gif') => 'gif',
            str_contains($contentType, 'webp') => 'webp',
            str_contains($contentType, 'avif') => 'avif',
            default => 'jpg',
        };
    }
}
