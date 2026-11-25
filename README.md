# MarketFlow

Advanced Discord e-commerce, digital delivery and store management platform.

**Your store. Your products. Your flow.**

## Development preview v0.1.0

Requires Node.js 22+ and PostgreSQL. Create a PostgreSQL database and a Discord bot application. Invite the bot with bot and applications.commands scopes. Copy .env.example to .env and configure DISCORD_TOKEN and DATABASE_URL.

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
This is an untested development preview. No automated payment verification, fulfillment or pending order expiry. Administrators must independently verify payments before approval and manually deliver purchases. Cancel abandoned orders to release stock. Do not collect card information in Discord. Test in staging before handling real orders. Keep tokens and database credentials private.

## Roadmap
Interactive storefronts, Stripe and PayPal webhooks, digital delivery, license API, discounts, recurring subscriptions, customer support, analytics, premium plans, web dashboard.


## v0.2.0 development preview
The sections above describe the original MVP. Additional commands:
- /market panel, brand, coupon-create, coupon, delivery, claim, analytics, support, support-close, license-revoke, plan, premium
- /payment stripe-account, stripe
Free stores are limited to 10 products and 3 coupons. Custom branding requires premium; OWNER_IDS controls premium grants. SUPPORT_ROLE_ID currently supports a single configured staff role. Product delivery is claimed privately in Discord; role delivery is retried by a periodic worker. Fixed-duration role access is not recurring billing; expiring access can remove roles previously granted outside MarketFlow, so use dedicated customer roles. Download links are not revocable once disclosed. License keys are bearer secrets stored in the database; validation does not bind devices. Restrict database access.
The HTTP service defaults to loopback; expose it only behind HTTPS with rate limiting. DASHBOARD_TOKEN (at least 32 random characters) grants platform-wide read-only access, not merchant-scoped access. Stripe Connect direct charges require operator-verified account IDs in STRIPE_ACCOUNT_ALLOWLIST (JSON mapping guild IDs to account IDs), Stripe test credentials, PUBLIC_BASE_URL and a Connect webhook signing secret for checkout.session.completed and checkout.session.async_payment_succeeded at /webhooks/stripe. Orders are paid only after signed events match account, session, amount and currency. Reconcile abandoned or failed provider attempts manually; cancellation is blocked while an attempt exists.
PayPal, automatic recurring billing, full merchant dashboard, device activation and production security testing remain unfinished. No live integration or syntax tests were performed in this environment. Do not deploy for real payments yet.
