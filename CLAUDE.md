## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Project: RapidePI (RAPIDÉ POS-IMS)

Till and stock app for small shops in Laos: products, stock, barcode scanning, sales, orders, expiry, reports. Full details in `PROJECT.md` (read it before larger changes) and `README.md`.

### Stack
- Vanilla JS + Vite, installable PWA (no framework)
- Supabase (Postgres, Auth, row-level security, Realtime). With no Supabase keys in `.env`, the app runs in local demo mode (`localStorage`)
- Hosted on Cloudflare Workers, not Pages: Lao Telecom blocks `*.pages.dev`

### Commands
- `npm run dev`: dev server at http://localhost:5173
- `npm test`: i18n check + unit tests + database tests (same as CI). Run before calling work done
- `npm run build`: production build into `dist/`
- `npm run backup` / `npm run backup:verify`: back up the live database and check the backup

### Layout
- `src/main.js`: startup, routing, all button actions (`A` and `INPUT` maps)
- `src/views/*.js`: one file per screen
- `src/data/`: `store.js` picks `remote.js` (Supabase) or `local.js` (demo); both enforce the same rules
- `src/i18n/en.js`, `lo.js`: all interface text
- `supabase/migrations/`: numbered SQL files; add a new file, never edit an applied one
- `scripts/`: tests, i18n check, backups

### Deploys (Cloudflare builds from GitHub on every push to `master`)
- `wrangler.jsonc`: main app, rapidepi.rapidewms.workers.dev
- `wrangler.cashier.jsonc`: cashier site (same build, `VITE_APP_MODE=cashier`)
- `wrangler.landing.jsonc`: landing page (`npm run build:landing`)
- `.github/workflows/pages.yml`: runs the tests and publishes the demo to GitHub Pages

### Rules
- This repo is PUBLIC. Never commit `.env`, keys, passwords or backups (`*.ndjson.gz`)
- Never hardcode interface text: add a key to both `en.js` and `lo.js` and use `t("key")` / `tn("key", n)`
- Escape user data with `E()` before putting it into HTML
- Buttons use `data-act="name"`, inputs `data-input="name"`; no inline `onclick`
- Stock changes only through the stock functions (`adjust`, `saveItem`, `completeOrder` / the SQL functions), never by editing `qty` directly
- Errors carry an i18n key, not a sentence: `fail("err.key", {...})`, shown with `errText(e)`
