<?php

declare(strict_types=1);

namespace App\Conversation;

use App\Conversation\Exceptions\InvalidSignature;
use App\Models\Contact;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * The only door into the conversation machine.
 *
 * A channel delivery is hostile until proven otherwise. It is unauthenticated
 * until its HMAC verifies; it repeats whenever the provider's retry schedule
 * says so; two copies can race each other. So the receiver does three things in
 * order — verify, claim, resolve — and hands exactly one clean message to the
 * router. Everything downstream may assume a single, authenticated delivery.
 *
 * The signing secret is injected; the sample shows how it is used, not where it
 * is kept.
 */
final class WebhookReceiver
{
    private const DEDUPE_TTL_HOURS = 24;

    public function __construct(
        private readonly string $signingSecret,
        private readonly ConversationRouter $router,
    ) {}

    public function receive(Request $request): void
    {
        if (! $this->signatureMatches($request)) {
            throw new InvalidSignature('The delivery signature did not verify.');
        }

        // Whole-delivery replay: the provider re-sends an identical body. An
        // atomic add means the first copy wins the key and every retry is a
        // no-op, with no read-then-write window for two copies to slip through.
        $delivery = 'conversation:delivery:'.hash('sha256', $request->getContent());

        if (! Cache::add($delivery, true, now()->addHours(self::DEDUPE_TTL_HOURS))) {
            return;
        }

        foreach ($this->messagesIn($request) as $message) {
            $this->dispatch($message);
        }
    }

    /** @param array<string, mixed> $message */
    private function dispatch(array $message): void
    {
        $address = (string) ($message['from'] ?? '');
        $messageId = (string) ($message['id'] ?? '');

        if ($address === '') {
            return;
        }

        // Message-level replay: a retry can carry the same id inside a body
        // whose hash changed (a status field moved). Claim the id itself, so
        // the two dedupe layers cover different kinds of duplicate.
        if ($messageId !== '' && ! Cache::add(
            "conversation:message:{$messageId}",
            true,
            now()->addHours(self::DEDUPE_TTL_HOURS)
        )) {
            return;
        }

        $contact = Contact::query()->where('channel_address', $address)->first();

        if ($contact === null) {
            // An unknown sender is not necessarily an error: record and stop.
            Log::info('Message from an unrecognised address', ['address' => $address]);

            return;
        }

        // Every reply is rendered in the sender's own language, resolved from
        // the contact, never from the process default.
        app()->setLocale($contact->locale ?? config('app.locale'));

        match ((string) ($message['type'] ?? '')) {
            'interactive' => $this->router->interactive($contact, $message),
            'text'        => $this->router->text($contact, (string) ($message['text']['body'] ?? '')),
            // Quick-reply buttons sent from a template arrive as plain text.
            'button'      => $this->router->text($contact, (string) ($message['button']['text'] ?? '')),
            default       => $this->router->unsupported($contact, (string) ($message['type'] ?? '')),
        };
    }

    private function signatureMatches(Request $request): bool
    {
        $signature = (string) $request->header('X-Channel-Signature');

        if ($signature === '') {
            return false;
        }

        $expected = hash_hmac('sha256', $request->getContent(), $this->signingSecret);

        // Constant time: a byte-by-byte comparison leaks where the digest first
        // differs, which is enough to forge the signature one byte at a time.
        return hash_equals($expected, $signature);
    }

    /** @return list<array<string, mixed>> */
    private function messagesIn(Request $request): array
    {
        // The provider nests messages a few levels deep and has changed the
        // shape before; accept both spellings rather than fail on an update.
        return $request->input('entry.0.changes.0.value.messages')
            ?? $request->input('value.messages')
            ?? [];
    }
}
