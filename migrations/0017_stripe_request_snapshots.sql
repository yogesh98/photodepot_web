-- Stripe's idempotency keys require identical parameters on every retry.
-- Persist mutable input before making the corresponding external request.
ALTER TABLE stripe_customers ADD COLUMN customer_create_email TEXT;
ALTER TABLE stripe_customers ADD COLUMN checkout_request_json TEXT;
