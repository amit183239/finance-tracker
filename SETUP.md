# SETUP

## Prerequisites
- Node.js 18+
- Cloudflare account and D1 access
- Wrangler via npm devDependency

## Steps
1. `npm install`
2. Verify `wrangler.toml` D1 database binding/id
3. `npm run dev` for local
4. `npm run deploy` for production

## Optional Sync Automation
Use OpenClaw cron jobs for:
- Gmail token refresh
- Gmail transaction sync
- HDFC alerts sync
- Card cycle spend update
