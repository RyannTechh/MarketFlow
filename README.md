# MarketFlow

Advanced Discord e-commerce, digital delivery and store management platform.

**Your store. Your products. Your flow.**

## Getting started

Requires Node.js 22+ and PostgreSQL. Create a PostgreSQL database and a Discord bot application. Invite the bot with bot and applications.commands scopes. Copy .env.example to .env and configure DISCORD_TOKEN, DATABASE_URL and LICENSE_ENCRYPTION_KEY (64 hexadecimal characters). Generate the latter with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Back up this key separately and never commit it.

Run:
```sh
npm install
npm run check
npm start
```
The bot initializes its database schema and registers global commands at startup. On Pterodactyl, use a Node.js egg and npm start, with a separately provisioned PostgreSQL database.

## Commands
| Command | Purpose |
|---|---|
| /store setup | Initialize store and currency |
| /store product-add | Add product with category, minor-unit price and stock |
| /store product-stock | Set available inventory |
| /store browse | Browse products |
| /store cart-add | Set quantity of a product in cart |
| /store cart | View cart |
| /store cart-clear | Clear cart |
| /store checkout | Create order and reserve inventory |
| /store orders | View orders (admins see all server orders) |
| /store approve | Mark independently verified payment paid |
| /store cancel | Cancel pending order and restore stock |

Administrative commands require Manage Server. Prices are entered in cents (1999 = 19.99). Each server has separate data. Currency cannot be changed after setup.

## Limitations
This is an untested development preview. Stripe verification and automated fulfillment are implemented but untested; Stripe expiry reconciliation and opt-in manual expiry are available in v0.2.3. Administrators must independently verify payments before approval and manually deliver purchases configured for manual fulfillment. Cancel abandoned orders to release stock. Do not collect card information in Discord. Test in staging before handling real orders. Keep tokens and database credentials private.

## Roadmap
Interactive storefronts, Stripe and PayPal webhooks, digital delivery, license API, discounts, recurring subscriptions, customer support, analytics, web dashboard.


## Advanced commerce commands
The sections above describe the original MVP. Additional commands:
- /market panel, brand, coupon-create, coupon, delivery, claim, analytics, support, support-close, license-revoke
- /payment stripe-account, stripe
All features are available to every store without premium tiers, product limits or coupon limits. Configure support staff per server with /market support-role. Product delivery is claimed privately in Discord; role delivery is retried by a periodic worker. Fixed-duration role access is not recurring billing; expiring access can remove roles previously granted outside MarketFlow, so use dedicated customer roles. Download links are not revocable once disclosed. License keys are encrypted at rest with AES-256-GCM and validated using SHA-256 hashes; validation does not bind devices. Restrict database access.
The HTTP service defaults to loopback; expose it only behind HTTPS with rate limiting. DASHBOARD_TOKEN (at least 32 random characters) grants platform-wide read-only access, not merchant-scoped access. Stripe Connect direct charges require operator-verified account IDs in STRIPE_ACCOUNT_ALLOWLIST (JSON mapping guild IDs to account IDs), Stripe test credentials, PUBLIC_BASE_URL and a Connect webhook signing secret for checkout.session.completed and checkout.session.async_payment_succeeded at /webhooks/stripe. Orders are paid only after signed events match account, session, amount and currency. Stripe Checkout is restricted to test keys. Known sessions are reconciled periodically and expired sessions release reservations. Unresolved attempts without a session ID require manual reconciliation; never delete an attempt without confirming provider state. Refund or dispute events place orders on hold; access revocation is best-effort for Discord roles.
PayPal, automatic recurring billing, full merchant dashboard, device activation and production security testing remain unfinished. No live integration or syntax tests were performed in this environment. Do not deploy for real payments yet.

## Open-source direction (v0.2.2)
MarketFlow has no paid feature gates. Every self-hosted instance has the same functionality. Payment processors may charge their own fees. The repository remains private during development; the MIT license is included and a public release is pending.

## Docker installation
Copy .env.example to .env. Set a strong POSTGRES_PASSWORD and DATABASE_URL using db as hostname, e.g. postgresql://marketflow:URL_ENCODED_PASSWORD@db:5432/marketflow. Configure Discord and the license encryption key. Run docker compose up -d --build. The HTTP service binds only to loopback on the host. Use an HTTPS reverse proxy for external access. Back up PostgreSQL and the encryption key separately. Stop all older bot instances before migrating; retain backups and rotate any exposed legacy license keys if necessary.
## Payment safety in v0.2.3
Stripe Connect test mode only. Subscribe to checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired, checkout.session.async_payment_failed, charge.refunded and charge.dispute.created. Refunds (including partial refunds) and disputes conservatively hold the entire order. A hold is not a refund initiation or final dispute resolution. Previously downloaded content cannot be recalled. MANUAL_ORDER_EXPIRY_HOURS defaults to zero; enable only with a manual payment process that reconciles payments before orders expire. Unverified attempts remain reserved. Do not handle real transactions. Automated tests have been added but their results have not been verified.
