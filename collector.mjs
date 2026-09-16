import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const WP_BASE = (process.env.BEQUEEN_WP_BASE || '').replace(/\/$/, '');
const COLLECTOR_KEY = process.env.BEQUEEN_COLLECTOR_KEY || '';

const TRACK_PAGE = 'https://egyptpost.gov.eg/ar-eg/home/eservices/track-and-trace/';
const PROBE_BARCODE = 'ENO25400471EG';
const SESSION_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const BETWEEN_REQUESTS_MS = 2_000;
const MAX_ATTEMPTS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function saveDebug(page, prefix = 'egyptpost-debug') {
  try { await page.screenshot({ path: `${prefix}.png`, fullPage: true }); } catch {}
  try { await fs.writeFile(`${prefix}.html`, await page.content(), 'utf8'); } catch {}
}

async function probe(page, barcode = PROBE_BARCODE) {
  return await page.evaluate(async ({ barcode, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(
        `/ar-EG/TrackTrace/GetShipmentDetails?barcode=${encodeURIComponent(barcode)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json, text/plain, */*' },
          signal: controller.signal
        }
      );
      const body = await r.text();
      let json = null;
      try { json = JSON.parse(body); } catch {}
      return {
        ok: true,
        http: r.status,
        cfMitigated: r.headers.get('cf-mitigated'),
        contentType: r.headers.get('content-type'),
        jsonSuccess: json?.success ?? null,
        jsonCase: json?.data?.case ?? null,
        eventCount: Array.isArray(json?.data?.data) ? json.data.data.length : null,
        bodyPreview: body.slice(0, 500)
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }, { barcode, timeoutMs: REQUEST_TIMEOUT_MS });
}

async function waitForUsablePage(page) {
  console.log('Opening Egypt Post and waiting for a usable browser session...');
  const nav = await page.goto(TRACK_PAGE, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  }).catch(e => {
    console.log('Navigation error:', e.message);
    return null;
  });

  console.log('Navigation HTTP:', nav?.status() ?? 'n/a');

  const started = Date.now();
  let attempt = 0;

  while (Date.now() - started < SESSION_TIMEOUT_MS) {
    attempt++;
    const title = await page.title().catch(() => '');
    console.log(`\n[session probe ${attempt}] elapsed=${Math.round((Date.now()-started)/1000)}s`);
    console.log('URL:', page.url());
    console.log('TITLE:', title);

    const result = await probe(page);
    console.log('PROBE:', JSON.stringify(result, null, 2));

    const contentType = String(result.contentType || '').toLowerCase();
    if (
      result.ok &&
      result.http === 200 &&
      !result.cfMitigated &&
      contentType.includes('application/json') &&
      result.jsonSuccess === true
    ) {
      console.log('Egypt Post browser session is usable.');
      return;
    }

    await sleep(5_000);
  }

  await saveDebug(page);
  throw new Error(
    `Egypt Post browser session did not become usable within ${SESSION_TIMEOUT_MS / 1000}s. ` +
    `Debug files saved as egyptpost-debug.png/html`
  );
}

async function wpFetch(path, options = {}) {
  if (!WP_BASE || !COLLECTOR_KEY) {
    throw new Error('Missing BEQUEEN_WP_BASE or BEQUEEN_COLLECTOR_KEY');
  }
  const r = await fetch(`${WP_BASE}${path}`, {
    ...options,
    headers: {
      'Accept': 'application/json',
      'X-BeQueen-Collector-Key': COLLECTOR_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`WordPress returned HTTP ${r.status}: ${text.slice(0, 500)}`);
  }
  if (!r.ok) throw new Error(`WordPress returned HTTP ${r.status}: ${JSON.stringify(json)}`);
  return json;
}

async function fetchTracking(page, barcode) {
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    last = await probe(page, barcode);
    last.elapsed_ms = Date.now() - started;
    last.attempt = attempt;

    if (
      last.ok &&
      last.http === 200 &&
      !last.cfMitigated &&
      String(last.contentType || '').toLowerCase().includes('application/json')
    ) {
      let parsed;
      try { parsed = JSON.parse(last.bodyPreview); } catch {}

      // Re-fetch full JSON because diagnostic preview is intentionally truncated.
      const full = await page.evaluate(async ({ barcode, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(
            `/ar-EG/TrackTrace/GetShipmentDetails?barcode=${encodeURIComponent(barcode)}`,
            {
              credentials: 'include',
              headers: { 'Accept': 'application/json, text/plain, */*' },
              signal: controller.signal
            }
          );
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return {
            http: r.status,
            cfMitigated: r.headers.get('cf-mitigated'),
            contentType: r.headers.get('content-type'),
            json
          };
        } finally { clearTimeout(timer); }
      }, { barcode, timeoutMs: REQUEST_TIMEOUT_MS });

      if (full.http === 200 && !full.cfMitigated && full.json?.success === true) {
        return { success: true, raw: full.json, attempt, elapsed_ms: last.elapsed_ms };
      }

      // case=3/empty events can still be a valid provider response.
      if (
        full.http === 200 &&
        !full.cfMitigated &&
        full.json?.success === true &&
        full.json?.data?.case === 3
      ) {
        return { success: true, raw: full.json, attempt, elapsed_ms: last.elapsed_ms };
      }

      last.full = full;
    }

    console.log(`Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${barcode}:`, JSON.stringify(last));
    if (attempt < MAX_ATTEMPTS) await sleep(attempt === 1 ? 5_000 : 15_000);
  }
  return { success: false, error: last };
}

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  locale: 'ar-EG',
  viewport: { width: 1365, height: 900 }
});

const page = await context.newPage();

try {
  await waitForUsablePage(page);

  console.log('\nRequesting active shipments from WordPress...');
  const active = await wpFetch('/wp-json/bequeen-app/v1/collector/shipments');
  const shipments = Array.isArray(active?.shipments) ? active.shipments : [];
  console.log(`Active shipments returned by WordPress: ${shipments.length}`);

  if (!shipments.length) {
    console.log('Nothing is due for collection.');
    process.exitCode = 0;
  } else {
    const results = [];

    for (let i = 0; i < shipments.length; i++) {
      const s = shipments[i];
      const barcode = String(s.tracking_number || '').trim();
      if (!barcode) continue;

      console.log(`\n[${i + 1}/${shipments.length}] ${barcode}`);
      const collectedAt = new Date().toISOString();
      const got = await fetchTracking(page, barcode);

      if (got.success) {
        const events = Array.isArray(got.raw?.data?.data) ? got.raw.data.data.length : 0;
        console.log(`OK ${barcode} | events=${events} | attempt=${got.attempt}`);
        results.push({
          order_id: s.order_id,
          tracking_number: barcode,
          collected_at: collectedAt,
          success: true,
          raw: got.raw
        });
      } else {
        console.log(`FAILED ${barcode}; preserving last good WordPress state.`);
        results.push({
          order_id: s.order_id,
          tracking_number: barcode,
          collected_at: collectedAt,
          success: false,
          error: typeof got.error === 'string' ? got.error : JSON.stringify(got.error)
        });
      }

      if (i < shipments.length - 1) await sleep(BETWEEN_REQUESTS_MS);
    }

    console.log(`\nPosting ${results.length} result(s) to WordPress...`);
    const saved = await wpFetch('/wp-json/bequeen-app/v1/collector/results', {
      method: 'POST',
      body: JSON.stringify({ results })
    });
    console.log('WordPress response:', JSON.stringify(saved, null, 2));
  }
} catch (e) {
  console.error('\nCOLLECTOR FATAL ERROR:', e);
  await saveDebug(page);
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
