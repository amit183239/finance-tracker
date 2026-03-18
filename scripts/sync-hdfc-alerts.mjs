#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const days = Number(process.argv[2] || 7);
const out = execFileSync('node', ['/root/clawd/agents/github/finance-tracker/scripts/sync-gmail-to-app.mjs', String(days)], {
  env: { ...process.env, INCLUDE_TRASH: '1' },
  encoding: 'utf8'
});
console.log(out.trim());
