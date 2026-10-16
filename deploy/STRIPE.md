# Stripe Billing through WorkOS Entitlements

Photodepot delegates paid feature access to the WorkOS Stripe Entitlements add-on.
Stripe hosts Checkout and Customer Portal and manages subscriptions, invoices,
trials, discounts, Tax, cancellation and payment recovery. Photodepot does not
listen to Stripe subscription webhooks or interpret invoices to authorize access.

## What the application retains

- A private personal WorkOS organization with one active customer membership and
  the linked Stripe Customer ID. This is separate from the administration org.
- Authenticated, same-origin Checkout and Portal actions with server-owned Prices,
  customers and return URLs. Duplicate purchases are checked against live Stripe.
- One encrypted backend-owned WorkOS AuthKit session per billing account. Its
  authorization-code/PKCE flow uses a separate WorkOS Application in the same
  environment, identified by `WORKOS_BILLING_CLIENT_ID`.
  Browser logout and removing one Mac do not revoke this shared billing session.
- Verification of WorkOS-signed `entitlements` for the exact client, user and
  personal organization. Only `PHOTODEPOT_WORKOS_ENTITLEMENT` grants paid access.
- Stable signed desktop receipt IDs. Historical manual grants are ignored.

WorkOS tokens contain feature keys, not subscription renewal dates or trial terms.
The existing 48-hour offline allowance remains a Photodepot authorization policy:
a receipt is bounded by the proof's issuance time plus 48 hours. An expired proof
must be refreshed before another paid receipt can be issued. Provider failures
cannot renew that allowance. Session expiry/revocation requires account
confirmation from the dashboard. Subscription coupons are managed in Stripe.

The billing panel retrieves live Stripe subscription status and dates only for
display. It recognizes flexible-mode `cancel_at` cancellations. Changing an
abandoned Checkout interval expires the old session before creating a replacement.

## Connect WorkOS and configure Stripe test mode

WorkOS currently does **not** support connecting a Stripe Sandbox account. Use a
standard Stripe account and its **test mode**. The earlier `photodepot sandbox`
connection cannot activate this add-on. Match the WorkOS environment to the app's
browser/default `WORKOS_CLIENT_ID`; the billing application must belong to that
same environment. Use separate databases, keys and Prices for test and live modes.

1. Create a separate WorkOS Application for backend billing sessions in that
   environment. Set `WORKOS_BILLING_CLIENT_ID` to its client ID; it must differ
   from `WORKOS_CLIENT_ID`. Keep `WORKOS_CLIENT_ID` as the existing browser/default
   application so its issuer and normal account/admin sessions remain unchanged.
2. In the matching WorkOS environment, enable the Stripe add-on and authorize its
   Stripe Connect connection. Enable **Use Stripe entitlements**. Individual
   Photodepot accounts do not need Seat Sync. This OAuth connection requires the
   account owner's browser authorization; setting a local flag cannot create it.
3. In Stripe test mode, create the product and recurring monthly and annual
   Prices: USD20/month and USD200/year (two months free compared with monthly).
   Use the same product and explicit tax behavior for both, with fixed per-unit
   licensed pricing and no quantity transformation. Attach a Stripe
   Entitlements feature with lookup key `photodepot-standard` to the product,
   or set `PHOTODEPOT_WORKOS_ENTITLEMENT` to the chosen key. WorkOS propagates this
   feature into tokens. Adding features to existing subscriptions may take effect
   at the next billing cycle; verify with a newly created test subscription.
4. Create a test-mode Customer Portal configuration. Enable payment updates,
   invoices and period-end cancellation. Enable price updates and restrict them to
   the Standard product's monthly and annual Prices, with quantity changes
   disabled. Set `features.subscription_update.proration_behavior` to
   `create_prorations` or `always_invoice` so yearly changes credit unused monthly
   time, and `features.subscription_update.trial_update_behavior=continue_trial`
   to preserve a current free trial when switching plans. Stripe's defaults omit
   proration and end trials immediately; targeted yearly upgrades reject those
   defaults. Stripe presents the resulting invoice for confirmation.
   Set `STRIPE_PORTAL_CONFIGURATION_ID`.
5. Apply migrations through `0017_stripe_request_snapshots.sql`. Earlier Stripe ledger
   tables are retained for history/upgrade compatibility and are not used by
   runtime authorization. No Stripe webhook endpoint or signing secret is needed.
   Migration 0017 saves the original customer email and Checkout request before
   contacting Stripe, so retries after a network or database failure reuse the
   exact parameters required by Stripe's idempotency keys. Existing unresolved
   requests without these inputs, or requests older than 23 hours, require support
   reconciliation; do not clear their state or create another customer/session
   until the original Stripe operation has been located and resolved.
6. Configure the server-only settings from `.dev.vars.example`:
   `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_BILLING_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`,
   `WORKOS_REDIRECT_URI`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_MONTHLY` and/or
   `STRIPE_PRICE_ANNUAL`, `STRIPE_PORTAL_CONFIGURATION_ID`,
   `PHOTODEPOT_WORKOS_ENTITLEMENT`, `PHOTODEPOT_STRIPE_MODE=test`, and
   `PHOTODEPOT_STRIPE_ORIGIN`. The existing server-only environment API key is used
   for user and organization reads/setup. Billing uses public-client PKCE for
   authorization-code exchange and the same billing client ID for refresh; neither
   requires a separate billing API key.
7. Register the exact `WORKOS_REDIRECT_URI` ending in `/api/auth/callback` on both
   WorkOS applications. Keep `/api/account/auth/login` as the browser application's
   initiate-login URI and preserve its sign-out URLs. Billing authorization starts
   at `/api/account/billing/authorize`; use that route if configuring a billing-app
   initiate-login URI. It requires an already signed-in browser account and prior
   billing setup. The shared callback dispatches the sealed billing transaction
   separately from normal account/admin login flows.
8. Review Stripe Tax's business address, product tax code, markets, registrations,
   and inclusive/exclusive behavior. Checkout enables automatic tax by default,
   collects billing addresses/tax IDs, and saves customer address/name changes.
   Set `PHOTODEPOT_STRIPE_AUTOMATIC_TAX=false` only as an explicit merchant decision.
9. Leave `PHOTODEPOT_STRIPE_TRIAL_DAYS` unset unless a trial policy is chosen. Prior
   manual or Stripe trial history prevents another offered trial. Configure the
   distinct `WORKOS_BILLING_CLIENT_ID` before enabling new purchases with
   `PHOTODEPOT_STRIPE_ENABLED=true`, after the test-mode setup is ready. Existing
   billing management and cancellation remain available during this setup.
   Retired Prices and invalid purchase-only settings disable new purchases without
   preventing existing customers from viewing billing or canceling.

Never commit keys, encrypted session credentials, refresh tokens or cookie secrets.
`WORKOS_COOKIE_PASSWORD` seals the server-owned tokens with purpose/client/user/org
bindings. Preserve it across deployments; rotating it requires reconnecting access
as well as normal account sessions.

Complete the code and configuration rollout to every backend instance before
reconnecting billing, so an older instance cannot invalidate a new-client session.
After rollout, customers with encrypted billing sessions issued through the old
browser client must reconnect billing from the account dashboard. Those sessions
cannot serve as the new billing application's grant. Previously signed desktop
receipts retain their original verification deadlines; reconnection requirements
do not extend their offline allowance.

## Customer flow

The Subscription section shows Free, Monthly, and Yearly. A free account selects
**Upgrade** on a paid option. This
prepares the private billing organization and, when needed, confirms identity
through WorkOS. The server seals the chosen interval in the authorization
transaction and resumes Stripe Checkout automatically after the callback. The app
refreshes WorkOS entitlements after Checkout/Portal return;
regular polling uses the current short-lived proof until it needs refreshing.
The billing application's separate client provides session isolation. The flow
also requests a fresh sign-in (`max_age=0`); this enforces authentication freshness
and does not create an independent token family by itself. If social sign-in
returns an unscoped token, the callback explicitly selects the private billing
organization using the new grant before saving it. The ordinary browser session
is never rotated into the billing store. Both applications use the environment's
default issuer; token validation separately requires the billing application's
`client_id` claim.
Stripe's own recovery and portal flows handle payment problems and cancellation.
The current paid card's **Cancel** button opens a `subscription_cancel` portal
flow for period-end cancellation. A monthly subscriber's yearly **Upgrade**
button opens `subscription_update_confirm` for the server-selected annual Price
and existing item. Both flows return directly to the account after confirmation;
neither action creates a second subscription or directly changes billing.

## Complimentary access and discounts

Create coupons and customer-facing promotion codes in Stripe; users redeem them
in hosted Checkout. `allow_promotion_codes=true` enables the field, and
`payment_method_collection=if_required` allows a subscription with nothing due to
complete without a card. Set a 100% coupon's duration to match the intended free
period; `forever` discounts all future invoices. Use customer restrictions and
redemption limits where appropriate. Discounts retain the same product and
WorkOS entitlement path; there is no manual access request or grant.

The account dashboard displays configured base prices from Stripe. For existing
discounted subscriptions, the billing portal shows the applicable discount and
actual invoice amounts. Never treat a coupon code or Checkout return URL as proof
of access; only verified WorkOS entitlements authorize it.

## Verification before launch

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm functions:build`, `pnpm test:billing-browser`, and `pnpm test:dashboard`.
Local tests mock external providers; they do not establish that Stripe Connect,
feature synchronization, payment collection, or Tax setup is operational.

In the connected test-mode account, verify monthly/annual purchases, prior trial
history, promotions, Tax and Portal changes/cancellation. Confirm refreshed WorkOS
claims grant/remove the configured feature, unrelated organization/user claims do
not authorize, and browser logout does not interrupt Mac access. Confirm that the
billing grant has the billing application's `client_id` and a different session
ID from the ordinary browser session. Verify expired billing sessions reconnect,
failed refreshes preserve rather than extend the last
offline allowance, historical manual grants cannot authorize, and existing Mac receipts keep
stable IDs and increasing revisions.

No production deployment, remote migration, live payment or Stripe OAuth connection
is performed by preparing this code. Live launch requires separate live settings,
the corresponding WorkOS add-on connection, verified feature mapping and an
explicit deployment decision.

## References

- [WorkOS Stripe Entitlements add-on](https://workos.com/docs/authkit/add-ons/stripe)
- [WorkOS Applications and client context](https://workos.com/docs/authkit/applications)
- [WorkOS reauthentication and authentication freshness](https://workos.com/docs/authkit/reauthentication)
- [WorkOS sessions and organization switching](https://workos.com/docs/authkit/sessions)
- [WorkOS session resilience](https://workos.com/docs/authkit/session-resilience)
- [Stripe Entitlements](https://docs.stripe.com/billing/entitlements)
- [Hosted subscription Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=checkout&ui=stripe-hosted)
- [Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Stripe Tax setup](https://docs.stripe.com/tax/set-up)
- [Stripe coupons and promotion codes](https://docs.stripe.com/billing/subscriptions/coupons)
- [Checkout payment method collection](https://docs.stripe.com/api/checkout/sessions/create#create_checkout_session-payment_method_collection)
