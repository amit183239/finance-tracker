# finance-tracker

Personal finance tracker on Cloudflare Workers + D1.

## Features
- Auto-sync credit card transactions from Gmail alerts
- Card management with bank/last4 details
- Card-wise spend tiles with bank colors
- Card click drill-down (current month / previous month)
- Recent transactions view (latest 20)
- Category tagging (including UPI)
- Daily cron jobs for token refresh + sync + card cycle updates

## Local setup
```bash
cd finance-tracker
npm install
npm run dev
```

## Deploy
```bash
npm run deploy
```

## Cloudflare config
- Worker: `finance-tracker`
- D1 binding: `DB`
- D1 database: `finance_tracker`

## Production
`https://finance-tracker.amit-maurya173.workers.dev`
