# Studex — architecture

Static site plus Vercel serverless functions plus Supabase. No framework and no build step:
the root HTML/CSS/JS files are served as they are, and every `api/*.js` file is one function.

## Domains

| Domain | Frontend | Server | DB (run in this order) |
|---|---|---|---|
| Lead form (landing) | `index.html`, `script.js`, `style.css` | `api/lead.js` → Supabase + Telegram notification | `supabase.sql` (`leads`), rate limit `supabase-ratelimit.sql` |
| Admin / CRM | `admin.html`, `admin.js`, `admin.css` | `api/config.js` (public Supabase settings) | `supabase-admin.sql` (`admins`, `is_admin()`), `supabase-crm.sql` (funnel, history) |
| Business-card scan | admin «Візитка» | `api/scan.js` → Claude API | `supabase-scan.sql` (private storage) |
| Telegram Mini App | `tg.html`, `tg.js`, `tg.css` | `api/tg-lead.js`, `api/tg-me.js`, `api/tg-setup.js`, shared `api/_telegram.js` | `supabase-telegram.sql` |
| Vacancy images | admin «Картинки» | `api/generate.js` → OpenAI GPT Image | `supabase-images.sql` (limit 5/day per admin) |

## Hub files
- `api/_telegram.js` — initData signature check, `rpc`, body parsing, errors: used by all `api/tg-*.js`.
- `vercel.json` — security headers (CSP per page), function timeouts, `cleanUrls`.
- `scripts/dev-server.js` — local server on :3000 that mimics Vercel (routes `api/`, applies `vercel.json` headers).

## Access
Admin data is protected by RLS (`is_admin()` over the `admins` email table); admin endpoints pass the
user's Supabase Bearer token through. Telegram endpoints trust only a verified initData signature.
Secrets live only in Vercel env vars (`.env.example` lists them).

## Tooling
`scripts/git-*.sh`, `scripts/wt-*.sh`, `githooks/`, `.claude/hooks/` — vibe-flow git protection, not product code.
