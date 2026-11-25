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
