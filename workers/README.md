# Subscription reminder delivery

The customer portal is `/account`. The admin dashboard shows active subscriptions
ending in the next seven days, renewal requests, and reminder history.
One trial-ending reminder is eligible in the final 48 hours of each active trial
term. The hourly scheduler catches newly due terms and retries temporary failures.
Standard subscriptions are listed in the admin queue but do not receive trial mail.

Email delivery is disabled until a mail provider and sender are configured.
The dashboard's **Check reminders now** action processes due reminders using the
same routine as the scheduled Worker once delivery is configured.

Email delivery uses [Resend](https://resend.com/docs/api-reference/emails/send-email).
Configure these encrypted/server-only settings in the website Pages project:

- `RESEND_API_KEY`: a sending API key for a verified sender domain.
- `PHOTODEPOT_EMAIL_FROM`: for example `Photodepot <hello@photodepot.app>`.
- `PHOTODEPOT_REMINDER_TOKEN`: a new random secret of at least 32 characters.

Use the same reminder token as an encrypted secret on the scheduled Worker. It has
no user login authority and can only trigger bounded reminder batches. It must
never appear in browser assets or desktop settings. Its endpoint denies unsigned
and incorrect-token requests.

After deploying the website with all current migrations, compile the scheduler
with `pnpm reminders:build`, deploy it with `pnpm reminders:deploy`, and add the token:

```sh
pnpm exec wrangler secret put PHOTODEPOT_REMINDER_TOKEN --config wrangler.reminders.jsonc
```

Enter the token through the prompt, not as a command argument. The scheduler does
not send until website delivery settings and the matching Worker token are present.
Check the website origin in `wrangler.reminders.jsonc` before deploying.

Delivery is keyed by subscription ID and exact term end, preventing repeat reminders
on sign-in, retries, and unrelated admin edits. Concurrent jobs claim rows atomically;
temporary provider failures retry the same payload and idempotency key.
Sender and message contents are retained with the attempt. A credential change
stops an uncertain retry for review rather than sending through a different key.
The sender must still own a live delivery lease immediately before transmission.
Resend's
[idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys) lasts
24 hours. Unknown outcomes outside that window stop as **uncertain** for admin review
instead of risking another message. Provider rejection is recorded as **failed**.
Changed/revoked/expired terms, reminder opt-outs, and deleted accounts cancel pending messages. Email
verification is required; a changed recipient cancels retries to the previous address.
Provider responses, credentials and message recipients are not logged.

No payment provider, automatic charges, or renewal billing is connected.

Reminder preferences are independent of access. The account-access migration maps
old canceled-renewal preferences to reminders disabled, preserving dates and audits.
Paid renewal messages will belong to the future billing provider.
