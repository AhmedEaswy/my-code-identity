<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Billing\BillingCycle;
use App\Billing\Exceptions\InvalidSignature;
use App\Billing\GatewayWebhook;
use App\Billing\PaymentKind;
use App\Billing\PaymentState;
use App\Billing\PlanChangeService;
use App\Billing\Proration;
use App\Billing\SubscriptionState;
use App\Models\Account;
use App\Models\Payment;
use App\Models\Plan;
use App\Models\Subscription;
use App\Models\WebhookEvent;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * These tests describe the rules a customer can feel: how much a mid-cycle
 * change costs, when a downgrade starts, and what happens when the same
 * payment callback is delivered twice. They are written against money and
 * state, not against the methods that happen to implement them.
 */
final class BillingLifecycleTest extends TestCase
{
    use RefreshDatabase;

    private const SIGNING_KEY = 'test-signing-key';

    private Plan $free;

    private Plan $starter;

    private Plan $basic;

    private Plan $pro;

    private Account $account;

    private Subscription $subscription;

    private CarbonImmutable $windowStart;

    protected function setUp(): void
    {
        parent::setUp();

        $this->buildBillingFixture();

        // Pin the gateway key so the signature in a test is built from the
        // same secret the handler verifies with.
        $this->app->bind(
            GatewayWebhook::class,
            fn (): GatewayWebhook => new GatewayWebhook(self::SIGNING_KEY, app(PlanChangeService::class)),
        );
    }

    public function test_an_upgrade_mid_cycle_credits_the_unused_time_before_charging(): void
    {
        // Six days into a thirty-day month, so twenty-four days are unused.
        $this->travelTo($this->windowStart->addDays(6));

        $proration = Proration::forChange(
            $this->subscription,
            $this->basic,
            $this->pro,
            BillingCycle::Monthly,
        );

        // Basic is 30.00 for the month, so 1.00 a day and 24.00 of credit.
        $this->assertSame(24.0, $proration->unusedCredit);
        // Pro lists at 90.00; the credit covers part of it, leaving 66.00 due.
        $this->assertSame(66.0, $proration->amountDue);
        $this->assertFalse($proration->refundsCustomer());
    }

    public function test_moving_to_the_free_tier_refunds_every_unused_cent(): void
    {
        // Ten days in, twenty of thirty days are unused -> 20.00.
        $this->travelTo($this->windowStart->addDays(10));

        $proration = Proration::forChange(
            $this->subscription,
            $this->basic,
            $this->free,
            BillingCycle::Monthly,
        );

        $this->assertSame(20.0, $proration->unusedCredit);
        $this->assertSame(20.0, $proration->refundDue);
        $this->assertSame(0.0, $proration->amountDue);
        $this->assertTrue($proration->refundsCustomer());
    }

    public function test_unused_credit_that_exceeds_the_target_is_refunded_not_carried(): void
    {
        $this->travelTo($this->windowStart->addDays(6)); // 24.00 of credit

        $proration = Proration::forChange(
            $this->subscription,
            $this->basic,
            $this->starter, // lists at 10.00
            BillingCycle::Monthly,
        );

        $this->assertSame(24.0, $proration->unusedCredit);
        $this->assertSame(14.0, $proration->refundDue);
        $this->assertSame(0.0, $proration->amountDue);
    }

    public function test_a_downgrade_is_scheduled_for_the_end_of_the_paid_window_and_costs_nothing(): void
    {
        $this->travelTo($this->windowStart->addDays(6));

        $scheduled = app(PlanChangeService::class)
            ->changePlan($this->account, $this->starter, BillingCycle::Monthly);

        $this->assertSame(SubscriptionState::Pending, $scheduled->state);
        $this->assertTrue($scheduled->starts_at->equalTo($this->subscription->ends_at));
        $this->assertSame(0, Payment::query()->where('subscription_id', $scheduled->id)->count());
    }

    public function test_an_upgrade_keeps_the_old_plan_until_the_payment_settles(): void
    {
        $this->travelTo($this->windowStart->addDays(6));

        $upgraded = app(PlanChangeService::class)
            ->changePlan($this->account, $this->pro, BillingCycle::Monthly);

        $this->assertSame(SubscriptionState::Pending, $upgraded->state);
        $this->assertSame(SubscriptionState::Active, $this->subscription->fresh()->state);

        $this->settle($upgraded, supersedes: $this->subscription->id);

        $this->assertSame(SubscriptionState::Active, $upgraded->fresh()->state);
        $this->assertSame(SubscriptionState::Expired, $this->subscription->fresh()->state);
    }

    public function test_a_duplicate_callback_is_acknowledged_and_never_applied_twice(): void
    {
        $payment = $this->pendingPayment('chk_9f2');

        $callback = $this->signedCallback([
            'merchant_reference' => 'chk_9f2',
            'transaction_id'     => 'txn_55',
            'captured'           => 'true',
            'amount_minor'       => '9000',
            'currency'           => 'USD',
        ]);

        $gateway = app(GatewayWebhook::class);
        $gateway->handle($callback, $callback['signature']);
        $gateway->handle($callback, $callback['signature']);

        $this->assertSame(PaymentState::Settled, $payment->fresh()->state);
        $this->assertSame(1, WebhookEvent::query()->where('outcome', 'applied')->count());
        $this->assertSame(1, WebhookEvent::query()->where('outcome', 'ignored_terminal')->count());
    }

    public function test_a_replayed_pending_callback_is_ignored_but_acknowledged(): void
    {
        $payment = $this->pendingPayment('chk_pending');

        $callback = $this->signedCallback([
            'merchant_reference' => 'chk_pending',
            'transaction_id'     => 'txn_77',
            'pending'            => 'true',
            'amount_minor'       => '9000',
            'currency'           => 'USD',
        ]);

        $gateway = app(GatewayWebhook::class);
        $gateway->handle($callback, $callback['signature']);
        $gateway->handle($callback, $callback['signature']);

        $this->assertSame(PaymentState::Pending, $payment->fresh()->state);
        $this->assertSame(1, WebhookEvent::query()->where('outcome', 'ignored_replay')->count());
    }

    public function test_a_callback_with_a_bad_signature_is_rejected_before_any_write(): void
    {
        $payment = $this->pendingPayment('chk_forged');

        try {
            app(GatewayWebhook::class)->handle([
                'merchant_reference' => 'chk_forged',
                'transaction_id'     => 'txn_x',
                'captured'           => 'true',
            ], 'not-a-real-signature');

            $this->fail('A callback with a forged signature was accepted.');
        } catch (InvalidSignature) {
            // Expected.
        }

        $this->assertSame(PaymentState::Pending, $payment->fresh()->state);
        $this->assertSame(0, WebhookEvent::query()->count());
    }

    public function test_a_second_renewal_failure_does_not_extend_the_grace_window(): void
    {
        $service = app(PlanChangeService::class);

        $service->recordRenewalFailure($this->subscription);
        $opened = $this->subscription->fresh()->grace_period_ends_at;

        $this->assertNotNull($opened);

        $this->travelTo(CarbonImmutable::now()->addDay());
        $service->recordRenewalFailure($this->subscription->fresh());

        $this->assertTrue($opened->equalTo($this->subscription->fresh()->grace_period_ends_at));
    }

    public function test_a_settled_payment_closes_an_open_grace_window(): void
    {
        $service = app(PlanChangeService::class);
        $service->recordRenewalFailure($this->subscription);

        $this->assertNotNull($this->subscription->fresh()->grace_period_ends_at);

        $this->settle($this->subscription, kind: PaymentKind::Renewal);

        $this->assertNull($this->subscription->fresh()->grace_period_ends_at);
    }

    private function buildBillingFixture(): void
    {
        $this->free = Plan::create([
            'name' => 'Free', 'slug' => 'free', 'tier' => 1, 'is_free' => true, 'is_active' => true,
            'monthly_price' => 0, 'yearly_price' => 0,
        ]);

        $this->starter = Plan::create([
            'name' => 'Starter', 'slug' => 'starter', 'tier' => 2, 'is_free' => false, 'is_active' => true,
            'monthly_price' => 10, 'yearly_price' => 100,
        ]);

        $this->basic = Plan::create([
            'name' => 'Basic', 'slug' => 'basic', 'tier' => 3, 'is_free' => false, 'is_active' => true,
            'monthly_price' => 30, 'yearly_price' => 300,
        ]);

        $this->pro = Plan::create([
            'name' => 'Pro', 'slug' => 'pro', 'tier' => 4, 'is_free' => false, 'is_active' => true,
            'monthly_price' => 90, 'yearly_price' => 900,
        ]);

        $this->account = Account::create(['name' => 'Northwind Labs']);

        $this->windowStart = CarbonImmutable::parse('2026-01-01 00:00:00');

        $this->subscription = Subscription::create([
            'account_id'    => $this->account->id,
            'plan_id'       => $this->basic->id,
            'billing_cycle' => BillingCycle::Monthly,
            'state'         => SubscriptionState::Active,
            'starts_at'     => $this->windowStart,
            'ends_at'       => $this->windowStart->addDays(30),
            'started_at'    => $this->windowStart,
        ]);
    }

    private function pendingPayment(string $reference): Payment
    {
        return Payment::create([
            'subscription_id'    => $this->subscription->id,
            'account_id'         => $this->account->id,
            'kind'               => PaymentKind::Renewal,
            'state'              => PaymentState::Pending,
            'amount'             => 90,
            'checkout_reference' => $reference,
        ]);
    }

    private function settle(Subscription $subscription, PaymentKind $kind = PaymentKind::Upgrade, ?int $supersedes = null): Payment
    {
        $payment = Payment::create([
            'subscription_id'            => $subscription->id,
            'account_id'                 => $subscription->account_id,
            'kind'                       => $kind,
            'state'                      => PaymentState::Settled,
            'amount'                     => 66,
            'checkout_reference'         => 'chk_'.uniqid(),
            'supersedes_subscription_id' => $supersedes,
        ]);

        app(PlanChangeService::class)->settlePayment($payment);

        return $payment;
    }

    /**
     * Builds a callback body and signs it the way the gateway does. The field
     * order here mirrors the gateway's published order; the handler owns the
     * list it verifies against.
     *
     * @param  array<string, string>  $fields
     * @return array<string, string>
     */
    private function signedCallback(array $fields): array
    {
        $order = [
            'amount_minor', 'currency', 'merchant_reference', 'captured',
            'voided', 'refunded', 'error_occurred', 'parent_transaction',
            'transaction_id', 'card_pan', 'pending', 'three_d_secure',
            'profile_id', 'reversed',
        ];

        $joined = implode('', array_map(
            fn (string $field): string => $fields[$field] ?? '',
            $order,
        ));

        $fields['signature'] = hash_hmac('sha256', $joined, self::SIGNING_KEY);

        return $fields;
    }
}
