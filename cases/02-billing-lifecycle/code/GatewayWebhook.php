<?php

declare(strict_types=1);

namespace App\Billing;

use App\Billing\Exceptions\InvalidSignature;
use App\Models\Payment;
use App\Models\WebhookEvent;
use Illuminate\Support\Facades\DB;

/**
 * Turns a gateway callback into exactly one payment transition.
 *
 * A callback is a hostile input: it is unauthenticated until its signature is
 * checked, it can arrive more than once, and two copies can arrive at the same
 * instant. So the handler does three things in order — verify, claim, then
 * transition — and answers a repeat with a quiet acknowledgement rather than
 * an error, so the gateway stops retrying.
 *
 * The signing key is injected, never read from a file in this repository; the
 * sample only shows how it is used, not where it is kept.
 */
final class GatewayWebhook
{
    /**
     * The fields the gateway signs, in the exact order it signs them. The
     * order is part of the protocol: the same values in a different sequence
     * produce a different digest, so the list must match the gateway's
     * documentation byte for byte.
     */
    private const SIGNED_FIELDS = [
        'amount_minor',
        'currency',
        'merchant_reference',
        'captured',
        'voided',
        'refunded',
        'error_occurred',
        'parent_transaction',
        'transaction_id',
        'card_pan',
        'pending',
        'three_d_secure',
        'profile_id',
        'reversed',
    ];

    public function __construct(
        private readonly string $signingKey,
        private readonly PlanChangeService $planChanges,
    ) {}

    /**
     * @param array<string, mixed> $payload
     */
    public function handle(array $payload, string $signature): WebhookEvent
    {
        if (! $this->signatureMatches($payload, $signature)) {
            throw new InvalidSignature('The callback signature did not verify.');
        }

        $reference = (string) ($payload['merchant_reference'] ?? '');

        return DB::transaction(function () use ($payload, $reference): WebhookEvent {
            $payment = Payment::query()
                ->where('checkout_reference', $reference)
                ->lockForUpdate()
                ->first();

            if ($payment === null) {
                throw new InvalidSignature("No payment matches reference {$reference}.");
            }

            // Already resolved by an earlier delivery. This is the common
            // case, not an error — the gateway retries until it sees success,
            // so repeats have to be cheap and truthful.
            if ($payment->state->isTerminal()) {
                return $this->record($payment, $payload, 'ignored_terminal');
            }

            // A second callback carrying the same gateway response code is a
            // replay even if the payment is somehow still open.
            $transactionId = (string) ($payload['transaction_id'] ?? '');
            if ($this->alreadySeen($payment, $transactionId)) {
                return $this->record($payment, $payload, 'ignored_replay');
            }

            $this->record($payment, $payload, 'received');

            $changed = $this->apply($payment, $payload);

            return $this->record($payment, $payload, $changed ? 'applied' : 'observed');
        });
    }

    /** @param array<string, mixed> $payload */
    private function signatureMatches(array $payload, string $signature): bool
    {
        if ($signature === '') {
            return false;
        }

        $joined = implode('', array_map(
            fn (string $field): string => (string) ($payload[$field] ?? ''),
            self::SIGNED_FIELDS,
        ));

        $expected = hash_hmac('sha256', $joined, $this->signingKey);

        // Constant-time: a length-dependent comparison leaks where the digest
        // starts to differ, which is enough to forge one byte at a time.
        return hash_equals($expected, $signature);
    }

    /** @param array<string, mixed> $payload */
    private function apply(Payment $payment, array $payload): bool
    {
        $state = match (true) {
            ($payload['captured'] ?? null) === 'true'        => PaymentState::Settled,
            ($payload['voided'] ?? null) === 'true'          => PaymentState::Voided,
            ($payload['refunded'] ?? null) === 'true'        => PaymentState::Refunded,
            ($payload['error_occurred'] ?? null) === 'true'  => PaymentState::Failed,
            default                                          => null,
        };

        if ($state === null) {
            // A pending notice carries no decision; record it and move on.
            return false;
        }

        $payment->forceFill([
            'state'                    => $state,
            'provider_transaction_ref' => $payload['transaction_id'] ?? null,
            'settled_at'               => $state === PaymentState::Settled ? now() : null,
        ])->save();

        if ($state === PaymentState::Settled) {
            $this->planChanges->settlePayment($payment);
        }

        return true;
    }

    private function alreadySeen(Payment $payment, string $transactionId): bool
    {
        if ($transactionId === '') {
            return false;
        }

        return WebhookEvent::query()
            ->where('payment_id', $payment->id)
            ->where('transaction_id', $transactionId)
            ->exists();
    }

    /** @param array<string, mixed> $payload */
    private function record(Payment $payment, array $payload, string $outcome): WebhookEvent
    {
        return WebhookEvent::create([
            'payment_id'     => $payment->id,
            'transaction_id' => $payload['transaction_id'] ?? null,
            'outcome'        => $outcome,
            'payload'        => $payload,
            'received_at'    => now(),
        ]);
    }
}
