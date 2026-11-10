# Mutual Fund Target Tracker Telegram Bot (`mf-alert-bot`)

A serverless Telegram bot built on **Cloudflare Workers** and **Cloudflare D1** that tracks Indian mutual fund Net Asset Values (NAVs) using [MFapi.in](https://www.mfapi.in/) and notifies users when their target percentage gains are reached.

## Overview

Users interact with the bot on Telegram to search for mutual fund schemes, record a baseline purchase NAV (or use the latest NAV), and set a target gain percentage. Each day at **7:00 AM IST** (`01:30 UTC`), a Cloudflare Cron Trigger evaluates all active targets against the latest scheme NAVs and sends a Telegram alert whenever a fund reaches or exceeds its target NAV.

## Features

- **Interactive Fund Search**: Search Indian mutual fund schemes via `api.mfapi.in` and pick from the top 5 matches using inline keyboard buttons.
- **Flexible Baseline NAV**: Track gains from an existing purchase price by entering a custom NAV, or reply `current` to start from today's latest NAV.
- **Percentage Gain Targets**: Automatically calculates the target NAV from the baseline NAV and desired gain percentage (`baseline_nav * (1 + target_pct / 100)`).
- **Daily Automated Checks**: Runs via a Cloudflare Worker `scheduled` handler (`30 1 * * *` cron) and sends formatted alerts when `target_nav <= current_nav`.
- **Efficient & Resilient Cron Execution**:
  - Deduplicates NAV lookups by querying each distinct active `scheme_code` once per scheduled run.
  - Only marks a target as triggered (`is_triggered = 1`) after its Telegram notification succeeds, allowing failed deliveries to retry on subsequent runs.
  - Updates `last_nav` and triggered statuses in batched D1 transactions (chunking `IN (...)` updates into batches of up to 100 bound parameters).
- **Safe HTML Formatting**: Escapes dynamic scheme names (`&`, `<`, `>`) before rendering Telegram HTML messages.

## Bot Commands & Workflow

Commands support optional `@botname` suffixes (for example, `/start@your_bot_name`).

| Command | Description |
| :--- | :--- |
| `/start` | Initializes or resets the user's conversation state to `IDLE` and shows available commands. |
| `/add` | Starts the guided flow to search for a mutual fund and configure a new target alert. |
| `/list` | Lists all active (untriggered) target funds for the current chat with baseline NAV, target %, and target NAV. |
| `/help` | Displays step-by-step usage instructions. |

### Conversational Setup Flow (`/add`)

The bot persists per-user wizard progress in the D1 `users` table:

1. **Search Query (`AWAITING_QUERY`)**: After `/add`, the user enters fund keywords (e.g., `Parag Parikh Flexi` or `Nifty 50`). The bot displays up to 5 matching schemes with numbered inline buttons (`SELECT_FUND:<schemeCode>`).
2. **Scheme Selection (`callback_query`)**: Tapping a number fetches the scheme's latest NAV and transitions the user to `AWAITING_BASE_NAV`.
3. **Baseline NAV (`AWAITING_BASE_NAV`)**: The user enters a positive numeric purchase NAV or replies `current` to use the fetched latest NAV.
4. **Target Gain % (`AWAITING_TARGET_PCT`)**: The user enters a positive gain percentage (e.g., `10` or `15.5`). The bot saves the target to `tracked_funds`, resets the user's state to `IDLE`, and confirms registration.

## Tech Stack & Architecture

- **Runtime**: [Cloudflare Workers](https://developers.cloudflare.com/workers/) (TypeScript)
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite, bound as `DB` -> `mf_tracker_db`)
- **HTTP Webhook Handler (`fetch`)**: Processes Telegram `POST` webhook updates (`message.text` and `callback_query`) and responds `200 OK` to non-`POST` health checks.
- **Cron Handler (`scheduled`)**: Evaluates active targets daily at `30 1 * * *` (`01:30 UTC` / `7:00 AM IST`).
- **External APIs**:
  - [Telegram Bot API](https://core.telegram.org/bots/api) (`sendMessage`, `answerCallbackQuery` via `fetch`)
  - [MFapi.in](https://www.mfapi.in/) (`/mf/search` and `/mf/{schemeCode}/latest`)
- **Testing**: [Vitest](https://vitest.dev/) with [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/)

## Database Schema

Defined in [`schema.sql`](./schema.sql):

- **`users`**: Stores per-chat conversation state (`IDLE`, `AWAITING_QUERY`, `AWAITING_BASE_NAV`, `AWAITING_TARGET_PCT`) and temporary selections (`temp_scheme_code`, `temp_scheme_name`, `temp_base_nav`) during `/add`.
- **`tracked_funds`**: Stores registered alerts (`chat_id`, `scheme_code`, `scheme_name`, `baseline_nav`, `target_pct`, `target_nav`, `last_nav`, `is_triggered`, `created_at`).

## Project Structure

```text
.
├── src/
│   └── index.ts          # Cloudflare Worker (webhook fetch handler & scheduled cron handler)
├── test/
│   ├── index.spec.ts     # Vitest suite covering commands, /add flow, HTML escaping, and cron batching
│   └── tsconfig.json     # TypeScript configuration for tests
├── schema.sql            # D1 database schema (users and tracked_funds tables)
├── wrangler.jsonc        # Wrangler config (D1 binding, cron trigger "30 1 * * *", observability)
├── vitest.config.mts     # Vitest + Cloudflare Workers pool configuration
├── tsconfig.json         # TypeScript configuration for Worker source
└── package.json          # Scripts and dependencies
```

## Setup & Development

### Prerequisites

- Node.js and `pnpm`
- A [Cloudflare](https://dash.cloudflare.com/) account with Wrangler authenticated
- A Telegram Bot token created via [@BotFather](https://t.me/BotFather)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Configure D1 Database

Ensure the `d1_databases` binding (`DB`) and `database_id` in [`wrangler.jsonc`](./wrangler.jsonc) point to your Cloudflare D1 database (`mf_tracker_db`), then apply the schema:

```bash
# Local D1 (for wrangler dev)
pnpm exec wrangler d1 execute mf_tracker_db --local --file=./schema.sql

# Remote D1 (for production)
pnpm exec wrangler d1 execute mf_tracker_db --remote --file=./schema.sql
```

If you change bindings in `wrangler.jsonc`, regenerate [`worker-configuration.d.ts`](./worker-configuration.d.ts):

```bash
pnpm cf-typegen
```

### 3. Configure Secrets

Set `BOT_TOKEN` in a local `.env` or `.dev.vars` file (both are gitignored) for local development/testing:

```env
BOT_TOKEN=your_telegram_bot_token
```

For production deployment, upload the secret to Cloudflare Workers:

```bash
pnpm exec wrangler secret put BOT_TOKEN
```

### 4. Local Development & Testing

```bash
# Start local Worker dev server
pnpm dev

# Start local dev server with /__scheduled endpoint enabled to test cron triggers
pnpm exec wrangler dev --test-scheduled

# Run the Vitest test suite
pnpm test
```

## Deployment & Webhook Registration

1. Deploy the Worker to Cloudflare:

   ```bash
   pnpm deploy
   ```

2. Point your Telegram bot's webhook to the deployed Worker URL:

   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://<your-worker>.<your-subdomain>.workers.dev"}'
   ```
