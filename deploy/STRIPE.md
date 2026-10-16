# Stripe Billing and Tax

Photodepot uses hosted Stripe Checkout for an individual recurring subscription
and Stripe's Customer Portal for billing changes, invoices, payment methods and
cancellation. Prices and optional trial duration are deployment configuration;
the application does not invent prices or create a product catalog on startup.
Billing is disabled by default. Existing accounts must explicitly enter Checkout.

The Stripe plugin and OAuth MCP connection were installed and verified against
`photodepot sandbox`. The implementation planner accepted guide
`iguide_61VaOp5JeRKd1WL2s41LxUHN6dX9s` with hosted Checkout, flat-rate pricing,
pay-at-checkout as the baseline, Customer Portal and Stripe-managed recovery.
Tax registrations, prices, currency, trial policy and launch remain merchant
decisions. Planner example amounts are not Photodepot prices.

## Integration boundary

WorkOS authenticates the user. A private personal WorkOS organization links each
billing customer to a Stripe Customer, separately from the administration
organization. Billing does not add administrator membership, teams or seats.
Stripe Customers v1 are used for WorkOS's `stripeCustomerId` compatibility.
Stripe's portal documentation supports both Customers v1 and Accounts v2;
Accounts v2 for a standalone merchant currently requires preview enrollment.

Cloudflare Pages Functions create authenticated Checkout and Portal sessions.
`GET /api/account/billing` returns available intervals and billing status.
`POST /api/account/billing` accepts `checkout` with a configured `monthly` or
`annual` interval, or `portal`. The server chooses the user, customer, price and
return URLs. Requests cannot supply another customer's identifiers or prices.
The browser redirects to Stripe to review the actual price, trial and tax details.

`POST /api/billing/webhook` verifies the raw body and `Stripe-Signature` before
processing events. Event deduplication and per-account serialization protect the
local billing projection. The handler retrieves the current subscription so
delayed events cannot restore obsolete state. Unconfirmed renewal terms do not
extend paid access.

Manual grants remain separate from paid subscription records and their audits.
The central entitlement loader resolves effective access and preserves a stable
receipt ID with increasing revisions across manual and paid transitions. Desktop
receipts continue to contain permissions and deadlines; Stripe credentials,
customer IDs and payment details stay on the server. Free collaboration and
computer approval remain independent of payment.

The later valid manual or confirmed Stripe deadline wins; Stripe wins a tie.
Paid cancellation removes the paid entitlement but does not erase a still-valid
manual grant. Trial allowance and purchased paid-through time are stored
separately so shortening a trial or failing its conversion cannot preserve an
obsolete deadline.

Manual access-editing and request-approval paths reject accounts with ongoing
Stripe subscriptions. A local grant edit must never imply that the next Stripe
charge was postponed. Manage paid terms in Stripe and let verified state update
access. Notes, reminder preferences and computer removal remain separate actions.

## Sandbox configuration

1. Apply the D1 migrations, including the billing and entitlement migrations:
   `pnpm db:migrate:local` for local development. Apply remote migrations only as
   part of an authorized deployment. Use a separate D1 database and secret set
   for a sandbox/staging deployment and production. Never repoint a database
   containing sandbox billing identifiers at live Stripe credentials.
2. In your Stripe sandbox, create the Photodepot product and recurring monthly
   and/or annual Prices. Choose the amount, currency and inclusive/exclusive tax
   behavior. Set `STRIPE_PRICE_MONTHLY` and/or `STRIPE_PRICE_ANNUAL`.
3. Configure a Customer Portal configuration for the same sandbox. Allow only
   Photodepot's supported product and price changes; enable payment updates,
   invoice history, tax IDs, and cancellation at the end of the paid period.
   Store its ID as `STRIPE_PORTAL_CONFIGURATION_ID`.
4. Add the server-only sandbox key as `STRIPE_SECRET_KEY` in ignored `.dev.vars`
   locally, or an encrypted Pages secret for a deployed sandbox. Never place it
   in browser variables, the desktop app, source control, chat or a URL.
5. Set `PHOTODEPOT_STRIPE_MODE=test` and `PHOTODEPOT_STRIPE_ORIGIN` to the exact
   application origin. Local preview uses `http://localhost:8788`; its WorkOS
   callback must use that same origin. A deployed origin uses HTTPS.
6. Register the snapshot events listed below with
   `https://YOUR_HOST/api/billing/webhook`, or forward them locally with
   `stripe listen --forward-to localhost:8788/api/billing/webhook`.
   Store that destination/listener's signing secret as `STRIPE_WEBHOOK_SECRET`.
7. Keep `PHOTODEPOT_STRIPE_TRIAL_DAYS` unset unless a trial duration and conversion
   policy have been chosen. Configured trials require a payment method and must
   not issue repeat trials or silently convert existing manual trials.
8. Configure Stripe Tax as described below, then set
   `PHOTODEPOT_STRIPE_ENABLED=true` to expose the purchase flows in that sandbox.

Subscribe to `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `customer.subscription.paused`,
`customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`, and
`invoice.finalization_failed`. Use the installed SDK's API version for the
snapshot destination. Stripe SDK 23.0.0 currently pins `2026-09-30.endive`.

## Tax configuration

Confirm the seller's head-office address, customer markets, product tax category,
existing registrations and obligations, and inclusive/exclusive price behavior.
Choose the category that describes this downloadable photo software rather than
assuming all software is taxed identically. Do not create registrations for
unverified jurisdictions.

Checkout enables automatic tax by default, collects billing addresses and tax
IDs, and saves collected address/name changes to the customer for future invoices.
Stripe Tax calculates collection based on the configured registrations and product
classification. A successful Checkout request does not establish that the tax
configuration or registration obligations are complete.

If the business has no current collection obligations, review Stripe's threshold
monitoring option. Configure filings/remittance separately as appropriate.
`PHOTODEPOT_STRIPE_AUTOMATIC_TAX=false` is an explicit deployment decision, not a
fallback after a tax error. Keep collection enabled where required and resolve
address or tax configuration failures before launch.

## Verification before launch

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm functions:build`, `pnpm test:billing-browser`, and `pnpm test:dashboard`.
Browser tests require a Playwright browser; an installed Chrome can be selected
with `PHOTODEPOT_TEST_BROWSER_CHANNEL=chrome`. Local regression tests use mocked
Stripe requests and local SQL/D1 behavior; they do not demonstrate a successful
Stripe payment.

In a connected sandbox, verify monthly and annual Checkout, retries/double clicks,
cancelled Checkout, payment authentication, optional trial conversion and repeat
trial prevention, address/tax IDs and tax-inclusive/exclusive totals, and Portal
updates/cancellation. Replay duplicate and out-of-order webhook events. Verify
failed/unpaid renewals do not extend access, scheduled cancellation retains the
confirmed term, effective cancellation removes paid access, manual fallback
preserves valid grants, and an existing desktop can transition without losing
its stable receipt identity. Configure Smart Retries and Stripe's payment/trial
emails in the Dashboard and verify failure recovery.

The initial implementation intentionally defers Stripe API testing at the
merchant's request. No product, Price, Checkout Session, subscription, tax
registration or live configuration was created during code preparation.

Live launch needs separate live Prices, Portal configuration, API key and webhook
secret, the correct HTTPS origin, reviewed Tax configuration, and explicit
`PHOTODEPOT_STRIPE_MODE=live`. Keep billing disabled until sandbox verification and
the deployment decision are complete.

## Stripe references

- [Hosted subscription Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=checkout&ui=stripe-hosted)
- [Customer Portal, including Customers v1](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Webhook verification and delivery](https://docs.stripe.com/webhooks)
- [Stripe Tax setup](https://docs.stripe.com/tax/set-up)
- [Tax with Checkout](https://docs.stripe.com/tax/checkout)
- [Tax threshold monitoring](https://docs.stripe.com/tax/monitoring)
- [Revenue recovery](https://docs.stripe.com/billing/revenue-recovery)
