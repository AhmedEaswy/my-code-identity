<?php

declare(strict_types=1);

namespace App\Conversation\Flows;

use App\Conversation\Channel;
use App\Enums\RequestStatus;
use App\Models\Contact;
use App\Models\Request;

/**
 * The "take it or leave it" flow behind an open request.
 *
 * A request is offered to a responder over the channel. They can claim it or
 * decline it, and a decline first asks for confirmation so an accidental tap
 * does not cost them the work. Every transition re-reads the request's real
 * status before writing, so a replayed or out-of-order tap cannot apply twice.
 */
final class IntakeFlow
{
    public const NAME = 'intake';

    private const STEP_CHOOSE = 'choose';

    private const STEP_CONFIRM_RELEASE = 'confirm_release';

    public function __construct(private readonly Channel $channel) {}

    /** @param array<string, mixed> $state  @param array<string, mixed> $input */
    public function accepts(array $state, array $input): bool
    {
        $id = $input['kind'] === 'reply' ? $input['id'] : null;

        return match ($state['step']) {
            self::STEP_CHOOSE => in_array($id, ['claim', 'release'], true),
            self::STEP_CONFIRM_RELEASE => in_array($id, ['confirm_release', 'keep'], true),
            default => false,
        };
    }

    /** @param array<string, mixed> $state  @param array<string, mixed> $input */
    public function advance(Contact $contact, array $state, array $input): ?array
    {
        $request = Request::query()->find($state['subject']);

        // The subject can vanish or be resolved by another response while this
        // conversation is still open. Stop rather than operate on a stale row.
        if ($request === null) {
            $this->channel->sendText($contact->channel_address, __('intake.subject_missing'));

            return null;
        }

        if ($request->status !== RequestStatus::Open) {
            $this->channel->sendText($contact->channel_address, __('intake.already_resolved'));

            return null;
        }

        return match ($state['step']) {
            self::STEP_CHOOSE => match ($input['id']) {
                'claim'   => $this->claim($contact, $request),
                'release' => [...$state, 'step' => self::STEP_CONFIRM_RELEASE],
                default   => $state,
            },
            self::STEP_CONFIRM_RELEASE => match ($input['id']) {
                'confirm_release' => $this->release($contact, $request),
                'keep'            => [...$state, 'step' => self::STEP_CHOOSE],
                default           => $state,
            },
            default => $state,
        };
    }

    /** @param array<string, mixed> $state */
    public function prompt(Contact $contact, array $state): void
    {
        match ($state['step']) {
            self::STEP_CHOOSE => $this->askAction($contact, $state),
            self::STEP_CONFIRM_RELEASE => $this->askConfirmation($contact),
            default => null,
        };
    }

    private function claim(Contact $contact, Request $request): ?array
    {
        // Conditional write: only an *open* request can be claimed. If another
        // response won the race between our read and this write, zero rows
        // change, and we treat it exactly like a replay — acknowledge, stop.
        $claimed = Request::query()
            ->whereKey($request->id)
            ->where('status', RequestStatus::Open)
            ->update(['status' => RequestStatus::Accepted, 'owner_id' => $contact->id]);

        if ($claimed === 0) {
            $this->channel->sendText($contact->channel_address, __('intake.already_resolved'));

            return null;
        }

        $this->channel->sendText($contact->channel_address, __('intake.claimed'));

        return null; // the work has moved on; close the conversation
    }

    private function release(Contact $contact, Request $request): ?array
    {
        $released = Request::query()
            ->whereKey($request->id)
            ->where('status', RequestStatus::Open)
            ->update(['status' => RequestStatus::Released]);

        if ($released === 0) {
            $this->channel->sendText($contact->channel_address, __('intake.already_resolved'));

            return null;
        }

        $this->channel->sendText($contact->channel_address, __('intake.released'));

        return null;
    }

    /** @param array<string, mixed> $state */
    private function askAction(Contact $contact, array $state): void
    {
        $request = Request::query()->find($state['subject']);
        $item = $request?->title ?? __('intake.unknown_item');

        $this->channel->sendButtons(
            $contact->channel_address,
            __('intake.prompt_action', ['item' => $item]),
            [
                ['id' => 'claim', 'title' => __('intake.button_claim')],
                ['id' => 'release', 'title' => __('intake.button_release')],
            ],
        );
    }

    private function askConfirmation(Contact $contact): void
    {
        $this->channel->sendButtons(
            $contact->channel_address,
            __('intake.prompt_confirm_release'),
            [
                ['id' => 'confirm_release', 'title' => __('intake.button_confirm')],
                ['id' => 'keep', 'title' => __('intake.button_keep')],
            ],
        );
    }
}
