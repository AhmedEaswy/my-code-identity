<?php

declare(strict_types=1);

namespace App\Ledger;

use App\Ledger\Models\CashEntry;
use App\Ledger\Models\Customer;
use App\Ledger\Models\LedgerEntry;
use App\Ledger\Models\Platform;
use App\Ledger\Models\Vendor;
use App\Ledger\Models\Wallet;
use Closure;
use Illuminate\Support\Facades\DB;
use Throwable;

use function count;

/**
 * The balance guard.
 *
 * Every path that moves money runs inside exactly one of these. The guard does
 * not compute the expected totals itself — it listens while rows are written,
 * accumulates what they did to each side, and on the way out of the outermost
 * frame asserts the cash identity. If the identity moved, the whole
 * transaction rolls back, rows and balances alike.
 *
 * That is what buys a wallet-based model the one thing a separate journal
 * would have given it for free: the mistake is refused where it is *made*,
 * not discovered by a report the next morning.
 */
final class LedgerGuard
{
    /** @var list<GuardFrame> */
    private static array $stack = [];

    private static bool $writesPlatformSide = true;

    /**
     * Run $callback inside a judged transaction. Passing $unbalancedReason
     * declares the event deliberately unbalanced (a correction, a backfill);
     * the reason is stamped on every row so a legitimate exception can always
     * be told apart from a bug.
     */
    public static function transaction(Closure $callback, ?string $unbalancedReason = null): mixed
    {
        return DB::transaction(function () use ($callback, $unbalancedReason) {
            $parent = self::current();

            $frame = new GuardFrame(
                reason: $unbalancedReason ?? $parent?->reason,
                exempt: $unbalancedReason !== null || ($parent?->exempt ?? false),
            );

            self::$stack[] = $frame;

            try {
                $result = $callback();
            } catch (Throwable $e) {
                self::pop();

                throw $e;
            }

            self::pop();

            if ($parent === null) {
                // Only the outermost frame commits, so only it judges.
                if (! $frame->exempt) {
                    $frame->assertBalanced();
                }
            } elseif (! $frame->exempt) {
                // An inner frame may leave one side for its caller to complete.
                $parent->absorb($frame);
            }

            return $result;
        });
    }

    /**
     * Called from the `created` model events of both row types. Rows written
     * while no guard is open are refused by the models themselves, so a new
     * path that forgets the guard fails immediately instead of drifting.
     */
    public static function record(LedgerEntry|CashEntry $row): void
    {
        $frame = self::current();

        if ($frame === null) {
            return;
        }

        if ($row instanceof CashEntry) {
            $frame->cash += $row->direction === 'in' ? (float) $row->amount : -(float) $row->amount;

            return;
        }

        $movement = (float) $row->balance_after - (float) $row->balance_before;

        match (self::ownerTypeOf($row->wallet_id)) {
            Customer::class => $frame->customers += $movement,
            Vendor::class   => $frame->vendors += $movement,
            Platform::class => $frame->platform += $movement,
            default         => null,
        };
    }

    public static function active(): bool
    {
        return count(self::$stack) > 0;
    }

    /** Whether the platform journal and cash ledger may write at all. */
    public static function writesPlatformSide(): bool
    {
        return self::$writesPlatformSide;
    }

    public static function currentReason(): ?string
    {
        return self::current()?->reason;
    }

    /**
     * Replay history the way the old code would have written it: no platform
     * row, no cash entry, no judgement. Used only by the backfill, which must
     * start from exactly what the database already holds.
     */
    public static function asLegacyHistory(Closure $callback): mixed
    {
        $previous = self::$writesPlatformSide;
        self::$writesPlatformSide = false;

        try {
            return DB::transaction(function () use ($callback) {
                self::$stack[] = new GuardFrame(reason: null, exempt: true);

                try {
                    return $callback();
                } finally {
                    self::pop();
                }
            });
        } finally {
            self::$writesPlatformSide = $previous;
        }
    }

    private static function current(): ?GuardFrame
    {
        return self::$stack[count(self::$stack) - 1] ?? null;
    }

    private static function pop(): void
    {
        array_pop(self::$stack);
    }

    /**
     * One small read per row written. A per-request memo would save the query
     * and go wrong the day a wallet id is reused under a new owner.
     */
    private static function ownerTypeOf(int $walletId): ?string
    {
        return Wallet::query()->whereKey($walletId)->value('owner_type');
    }
}
