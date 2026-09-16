# BeQueen Egypt Post Collector

GitHub Actions + Playwright Chromium collector for the BeQueen WordPress tracking plugin.

## Required GitHub Secrets
- `BEQUEEN_WP_BASE` = `https://bequeen.com.eg`
- `BEQUEEN_COLLECTOR_KEY` = exact Collector Secret shown in WooCommerce > Be Queen Tracking.

## First run
1. Push this folder as the repository root (including `.github/workflows/egyptpost-collector.yml`).
2. Add the two repository secrets.
3. Open Actions > BeQueen Egypt Post Collector > Run workflow.
4. Check logs for `Browser session ready`, active shipment count, and WordPress accepted results.

## Schedule
The included cron is every 3 hours at minute 17. WordPress itself returns only active shipments whose `next_sync_at` is due.

## Failure behavior
A failed Egypt Post retrieval is posted as an error record only. WordPress records the attempt/error but does NOT erase the last successful raw response or normalized shipment status.
