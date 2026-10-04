<?php

declare(strict_types=1);

namespace App\Billing;

use App\Models\Account;
use App\Models\Payment;
use App\Models\Plan;
use App\Models\Subscription;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/**
 * The lifecycle of a subscription: what happens when a customer changes plan,
 * when a payment lands, and what happens when one does not.
 *
 * The rules are directional, which is the part that is easy to get wrong:
 *  - an upgrade takes effect the moment it is paid for, and retires the plan
 *    it replaced at the same instant;
 *  - an ordinary downgrade is never charged for — it simply starts when the
 *    current paid window closes, so it is only ever scheduled;
 *  - a drop to the free tier is the exception, because there is no future
 *    invoice for it to move into, so it happens now and the unused time is
 *    refunded;
 *  - a failed *renewal* earns a short grace window; a failed *first* payment
 *    does not, because the customer was never on the plan.
 *
 * Every path takes the account row first and holds it for the whole change.
 * That single lock serialises a customer's plan decisions, so two clicks — or
 * a click racing a settlement callback — cannot leave two active
 * subscriptions behind.
 */
final class PlanChangeService
{
    /** How long a failed renewal has to be fixed before service is withdrawn. */
    private const GRACE_DAYS = 4;

    public function __construct(private readonly PaymentWriter $payments) {}

    public function changePlan(Account $account, Plan $target, BillingCycle $cycle): Subscription
    {
        if (! $target->is_active) {
            throw new InvalidArgumentException("Plan {$target->name} is not open for subscription.");
        }

        return DB::transaction(function () use ($account, $target, $cycle): Subscription {
            $account = Account::query()->lockForUpdate()->findOrFail($account->id);
            $current = $account->activeSubscription;

            if ($current === null) {
                return $this->open($account, $target, $cycle, CarbonImmutable::now());
            }

            // Same plan, new cadence: nothing to buy, just remember the cadence
            // to apply when the current window renews.
            if ($current->plan_id === $target->id) {
                return $this->rescheduleCadence($current, $cycle);
            }

            // A free plan has no paid window and no credit to value, so buying
            // a paid plan is a fresh start rather than a proration.
            if ($current->plan->is_free) {
                $this->retire($current);

                return $this->open($account, $target, $cycle, CarbonImmutable::now());
            }

            if ($target->is_free && ! $current->plan->is_free) {
                return $this->dropToFree($account, $current, $target, $cycle);
            }

            return $target->tier > $current->plan->tier
                ? $this->upgrade($account, $current, $target, $cycle)
                : $this->downgrade($account, $current, $target, $cycle);
        });
    }

    /**
     * A settlement has landed. Promote the subscription it was raised for,
     * retire whatever it replaced, and close any grace window a late payment
     * left open.
     */
    public function settlePayment(Payment $payment): void
    {
        $subscription = $payment->subscription;

        // Refunds are bookkeeping, not activation: one created during a plan
        // change must never promote anything on its own.
        if ($subscription === null || $payment->kind === PaymentKind::Refund) {
            return;
        }

        DB::transaction(function () use ($payment, $subscription): void {
            if (Account::query()->lockForUpdate()->find($subscription->account_id) === null) {
                return;
            }

            $this->retireSupersededBy($payment);
            $this->retireCompeting($subscription);

            $fresh = $subscription->fresh();

            if ($fresh === null) {
                return;
            }

            if ($fresh->state === SubscriptionState::Pending) {
                $fresh->forceFill([
                    'state'      => SubscriptionState::Active,
                    'started_at' => now(),
                ])->save();
            }

            if ($fresh->inGracePeriod()) {
                $fresh->forceFill(['grace_period_ends_at' => null])->save();
            }
        });
    }

    /**
     * A renewal failed. Open a grace window, but never widen an existing one:
     * a second failure inside the window must not buy more time.
     */
    public function recordRenewalFailure(Subscription $subscription): void
    {
        if ($subscription->inGracePeriod()) {
            return;
        }

        $subscription->forceFill([
            'grace_period_ends_at' => now()->addDays(self::GRACE_DAYS),
        ])->save();
    }

    /**
     * Called by the scheduled sweep once a grace window has closed. A payment
     * that arrived in the meantime clears it; otherwise the customer is moved
     * off the plan rather than left on one they are not paying for.
     */
    public function resolveGrace(Subscription $subscription): void
    {
        $endsAt = $subscription->grace_period_ends_at;

        if ($endsAt === null || $endsAt->isFuture()) {
            return;
        }

        if ($subscription->payments()->settled()->exists()) {
            $subscription->forceFill(['grace_period_ends_at' => null])->save();

            return;
        }

        $subscription->forceFill([
            'state'                => SubscriptionState::Expired,
            'ends_at'              => now(),
            'grace_period_ends_at' => null,
        ])->save();
    }

    private function upgrade(Account $account, Subscription $current, Plan $target, BillingCycle $cycle): Subscription
    {
        // The customer is reversing whatever was scheduled; drop it before it
        // can fire on top of the upgrade.
        $this->cancelScheduled($account);

        $proration = Proration::forChange($current, $current->plan, $target, $cycle);

        $subscription = $this->open($account, $target, $cycle, CarbonImmutable::now());
        $subscription->forceFill(['supersedes_subscription_id' => $current->id])->save();

        // The charge carries the proration. A fully-credited change settles
        // without a gateway round trip, so it is activated here instead of
        // waiting for a callback that will never come.
        $payment = $this->payments->recordPlanChange($subscription, $current, $proration);

        if ($payment->state === PaymentState::Settled) {
            $this->settlePayment($payment);
        }

        return $subscription->fresh();
    }

    private function downgrade(Account $account, Subscription $current, Plan $target, BillingCycle $cycle): Subscription
    {
        // One pending change at a time: a second downgrade replaces the first
        // rather than stacking two future subscriptions on one account.
        $this->cancelScheduled($account);

        return Subscription::create([
            'account_id'    => $account->id,
            'plan_id'       => $target->id,
            'billing_cycle' => $cycle,
            'state'         => SubscriptionState::Pending,
            'starts_at'     => $current->ends_at,
            'ends_at'       => $current->ends_at->addMonths($cycle->months()),
            'started_at'    => null,
        ]);
    }

    private function dropToFree(Account $account, Subscription $current, Plan $target, BillingCycle $cycle): Subscription
    {
        $this->cancelScheduled($account);

        $proration = Proration::forChange($current, $current->plan, $target, $cycle);

        $subscription = $this->open($account, $target, $cycle, CarbonImmutable::now());
        $subscription->forceFill(['supersedes_subscription_id' => $current->id])->save();

        // Free has no recurring invoice, so there is nothing to wait for:
        // return the unused money and retire the old plan now.
        if ($proration->refundsCustomer()) {
            $this->payments->recordRefund($current, $proration);
        }

        $this->retire($current);

        return $subscription->fresh();
    }

    private function open(Account $account, Plan $target, BillingCycle $cycle, CarbonImmutable $startsAt): Subscription
    {
        $window = CoverageWindow::openingAt($startsAt, $cycle);

        return Subscription::create([
            'account_id'    => $account->id,
            'plan_id'       => $target->id,
            'billing_cycle' => $cycle,
            'state'         => $target->is_free ? SubscriptionState::Active : SubscriptionState::Pending,
            'starts_at'     => $window->start,
            'ends_at'       => $target->is_free ? null : $window->end,
            'started_at'    => $window->isOpen() ? now() : null,
        ]);
    }

    private function rescheduleCadence(Subscription $current, BillingCycle $cycle): Subscription
    {
        if ($current->billing_cycle === $cycle) {
            return $current;
        }

        $current->forceFill(['scheduled_cycle' => $cycle])->save();

        return $current->fresh();
    }

    private function cancelScheduled(Account $account): void
    {
        Subscription::query()
            ->where('account_id', $account->id)
            ->where('state', SubscriptionState::Pending)
            ->where('starts_at', '>', now())
            ->update([
                'state'               => SubscriptionState::Cancelled,
                'canceled_at'         => now(),
                'cancellation_reason' => 'replaced by a newer plan change',
            ]);
    }

    private function retireSupersededBy(Payment $payment): void
    {
        $oldId = $payment->supersedes_subscription_id
            ?? ($payment->context['old_subscription_id'] ?? null);

        if ($oldId === null) {
            return;
        }

        $old = Subscription::query()
            ->whereKey($oldId)
            ->where('state', SubscriptionState::Active)
            ->first();

        if ($old !== null) {
            $this->retire($old);
        }
    }

    private function retireCompeting(Subscription $keep): void
    {
        Subscription::query()
            ->where('account_id', $keep->account_id)
            ->whereKeyNot($keep->id)
            ->where('state', SubscriptionState::Active)
            ->get()
            ->each(fn (Subscription $competing) => $this->retire($competing));
    }

    private function retire(Subscription $subscription): void
    {
        $subscription->forceFill([
            'state'                => SubscriptionState::Expired,
            'ends_at'              => now(),
            'grace_period_ends_at' => null,
        ])->save();
    }
}
