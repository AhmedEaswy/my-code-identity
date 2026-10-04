<?php

declare(strict_types=1);

namespace App\Conversation;

use App\Conversation\Flows\IntakeFlow;
use App\Models\Contact;
use Illuminate\Support\Facades\Cache;

/**
 * Owns the per-contact conversation state and routes each incoming input to the
 * step that is waiting for it.
 *
 * The whole session is `flow`, `step`, and `subject`, kept in the cache under
 * the contact with a sliding TTL. A reply can be late, early, or simply
 * unrecognised; all three are treated as data, never as exceptions. An input
 * that does not fit the current step re-renders that step rather than guessing,
 * and an input with no session behind it gets a gentle reset.
 *
 * Every flow registered here answers the same three questions: may this input
 * advance the current step (`accepts`), what is the next state (`advance`), and
 * what should the sender see now (`prompt`).
 */
final class ConversationRouter
{
    private const TTL_SECONDS = 1800;

    /** @var array<string, object> flow name => flow handler */
    private readonly array $flows;

    public function __construct(
        private readonly Channel $channel,
        IntakeFlow $intake,
    ) {
        $this->flows = [
            IntakeFlow::NAME => $intake,
        ];
    }

    /** Begin a flow, usually because an outbound prompt was just delivered. */
    public function open(Contact $contact, string $flow, array $state): void
    {
        $state = [...$state, 'flow' => $flow];

        $this->remember($contact, $state);
        ($this->flows[$flow] ?? null)?->prompt($contact, $state);
    }

    public function text(Contact $contact, string $body): void
    {
        $state = $this->current($contact);

        if ($state === null) {
            $this->nothingPending($contact);

            return;
        }

        $this->route($contact, $state, ['kind' => 'text', 'body' => $body]);
    }

    /** @param array<string, mixed> $message */
    public function interactive(Contact $contact, array $message): void
    {
        $interactive = $message['interactive'] ?? [];

        $reply = match ($interactive['type'] ?? '') {
            'button_reply' => $interactive['button_reply'] ?? null,
            'list_reply'   => $interactive['list_reply'] ?? null,
            default        => null,
        };

        if (! is_array($reply) || (string) ($reply['id'] ?? '') === '') {
            $this->unsupported($contact, (string) ($interactive['type'] ?? 'interactive'));

            return;
        }

        $state = $this->current($contact);

        if ($state === null) {
            // The prompt this reply answers is gone. Acknowledge, do not guess.
            $this->nothingPending($contact);

            return;
        }

        $this->route($contact, $state, [
            'kind'  => 'reply',
            'id'    => (string) $reply['id'],
            'title' => (string) ($reply['title'] ?? ''),
        ]);
    }

    public function unsupported(Contact $contact, string $type): void
    {
        // A type the product does not model still deserves a courteous answer
        // so the sender is not left in silence; then re-offer the live step.
        $this->channel->sendText($contact->channel_address, __('conversation.unsupported_type'));

        $state = $this->current($contact);

        if ($state !== null) {
            $this->reRender($contact, $state);
        }
    }

    /** @param array<string, mixed> $state  @param array<string, mixed> $input */
    private function route(Contact $contact, array $state, array $input): void
    {
        $flow = $this->flows[$state['flow']] ?? null;

        if ($flow === null) {
            $this->close($contact);
            $this->nothingPending($contact);

            return;
        }

        // A tap for a step we already left, or text where only a button fits,
        // is not an error — it is stale. Re-render; never advance on a guess.
        if (! $flow->accepts($state, $input)) {
            $this->reRender($contact, $state);

            return;
        }

        // A flow may refuse to advance (the subject was resolved elsewhere, the
        // race was lost). A `null` next state means the conversation is over.
        $next = $flow->advance($contact, $state, $input);

        if ($next === null) {
            $this->close($contact);

            return;
        }

        $this->remember($contact, $next);
        $flow->prompt($contact, $next);
    }

    /** @param array<string, mixed> $state */
    private function reRender(Contact $contact, array $state): void
    {
        // Re-putting resets the lease, so an active conversation stays open.
        $this->remember($contact, $state);
        ($this->flows[$state['flow']] ?? null)?->prompt($contact, $state);
    }

    /** @return array<string, mixed>|null */
    private function current(Contact $contact): ?array
    {
        $state = Cache::get($this->key($contact));

        return is_array($state) ? $state : null;
    }

    /** @param array<string, mixed> $state */
    private function remember(Contact $contact, array $state): void
    {
        Cache::put(
            $this->key($contact),
            [...$state, 'updated_at' => now()->toIso8601String()],
            self::TTL_SECONDS
        );
    }

    private function close(Contact $contact): void
    {
        Cache::forget($this->key($contact));
    }

    private function key(Contact $contact): string
    {
        return "conversation:{$contact->id}";
    }

    private function nothingPending(Contact $contact): void
    {
        $this->channel->sendText($contact->channel_address, __('conversation.nothing_pending'));
    }
}
