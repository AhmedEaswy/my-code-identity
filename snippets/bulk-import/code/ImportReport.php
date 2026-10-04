<?php

declare(strict_types=1);

namespace App\Import;

use Throwable;

/**
 * The receipt for one import run.
 *
 * Every line the importer looked at lands here exactly once, with the action
 * taken and the reasons behind it: created, updated, kept-but-inactive,
 * skipped, or failed. The counters are *derived* from those recorded rows
 * rather than tallied alongside them, so a summary view and a detail view of
 * the same run can never disagree — the same reason a ledger is read back
 * instead of recomputed.
 *
 * A skipped row carries one or more machine-readable reasons ("missing_sku",
 * "duplicate") so the UI can group a 4,000-line file by *why* it was rejected
 * instead of making an operator read 4,000 messages.
 */
final class ImportReport
{
    public const CREATED = 'created';

    public const UPDATED = 'updated';

    public const INACTIVE = 'kept_inactive';

    public const SKIPPED = 'skipped';

    public const FAILED = 'failed';

    /** @var list<array{line:int,status:string,key:?string,reasons:list<string>,notes:list<string>}> */
    private array $rows = [];

    /** @var array<string,int> */
    private array $skipReasons = [];

    public int $total = 0;

    public bool $dryRun = false;

    private readonly float $startedAt;

    private ?float $finishedAt = null;

    public function __construct()
    {
        $this->startedAt = microtime(true);
    }

    public function start(int $total, bool $dryRun): void
    {
        $this->total = $total;
        $this->dryRun = $dryRun;
    }

    /**
     * @param  list<string>  $reasons
     * @param  list<string>  $notes
     */
    public function record(int $line, string $status, ?string $key = null, array $reasons = [], array $notes = []): void
    {
        $this->rows[] = [
            'line' => $line,
            'status' => $status,
            'key' => $key,
            'reasons' => array_values($reasons),
            'notes' => array_values($notes),
        ];

        if ($status === self::SKIPPED) {
            foreach ($reasons === [] ? ['other'] : $reasons as $reason) {
                $this->skipReasons[$reason] = ($this->skipReasons[$reason] ?? 0) + 1;
            }
        }
    }

    public function fail(int $line, Throwable $error, ?string $key = null): void
    {
        $this->record($line, self::FAILED, $key, [$error->getMessage()]);
    }

    public function finish(): void
    {
        $this->finishedAt = microtime(true);
    }

    public function count(string $status): int
    {
        $count = 0;

        foreach ($this->rows as $row) {
            if ($row['status'] === $status) {
                $count++;
            }
        }

        return $count;
    }

    /** @return array<string,int> the reasons a row was skipped, commonest first */
    public function skipReasons(): array
    {
        arsort($this->skipReasons);

        return $this->skipReasons;
    }

    public function elapsed(): float
    {
        return round(($this->finishedAt ?? microtime(true)) - $this->startedAt, 3);
    }

    /** @return list<array{line:int,status:string,key:?string,reasons:list<string>,notes:list<string>}> */
    public function rows(): array
    {
        return $this->rows;
    }

    public function toArray(): array
    {
        return [
            'dry_run' => $this->dryRun,
            'total' => $this->total,
            'created' => $this->count(self::CREATED),
            'updated' => $this->count(self::UPDATED),
            'kept_inactive' => $this->count(self::INACTIVE),
            'skipped' => $this->count(self::SKIPPED),
            'failed' => $this->count(self::FAILED),
            'skip_reasons' => $this->skipReasons(),
            'elapsed_seconds' => $this->elapsed(),
            'rows' => $this->rows,
        ];
    }
}
