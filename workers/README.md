# Retired manual access reminder worker

Subscription renewal, trial-ending, and payment-recovery messages are managed in
Stripe. The manual trial-grant reminder queue and administration controls have
been removed. The former reminder endpoints return HTTP410 and do not send mail.
Historical grant, outbox, and delivery records remain stored for audit.

Do not deploy the legacy scheduled reminder worker for the subscription flow.
Existing deployed schedules can be removed as part of the production rollout;
against the updated backend they cannot send manual access reminders.

See [Stripe setup](../deploy/STRIPE.md) for subscription configuration and
complimentary access through coupons.
