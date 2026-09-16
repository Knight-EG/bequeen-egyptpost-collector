import { chromium } from 'playwright';

const WP_BASE = (process.env.BEQUEEN_WP_BASE || '').replace(/\/$/, '');
const KEY = process.env.BEQUEEN_COLLECTOR_KEY || '';
const LIMIT = Number(process.env.BEQUEEN_BATCH_LIMIT || 100);
const DELAY_MS = Number(process.env.BEQUEEN_DELAY_MS || 2000);
const REQUEST_TIMEOUT_MS = Number(process.env.BEQUEEN_REQUEST_TIMEOUT_MS || 60000);
const MAX_ATTEMPTS = Number(process.env.BEQUEEN_MAX_ATTEMPTS || 3);
const TRACK_PAGE = 'https://egyptpost.gov.eg/ar-eg/home/eservices/track-and-trace/';

if (!WP_BASE || !KEY) throw new Error('Missing BEQUEEN_WP_BASE or BEQUEEN_COLLECTOR_KEY');
const headers = {'X-BeQueen-Collector-Key': KEY, 'Content-Type': 'application/json'};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wpJson(url, options={}) {
  const r = await fetch(url, {...options, headers: {...headers, ...(options.headers||{})}});
  const text = await r.text();
  if (!r.ok) throw new Error(`WordPress HTTP ${r.status}: ${text.slice(0,500)}`);
  try { return JSON.parse(text); } catch { throw new Error(`WordPress returned non-JSON: ${text.slice(0,500)}`); }
}

async function waitForUsablePage(page) {
  await page.goto(TRACK_PAGE, {waitUntil:'domcontentloaded', timeout:60000});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const probe = await page.evaluate(async () => {
      try {
        const r = await fetch('/ar-EG/TrackTrace/GetShipmentDetails?barcode=ENO25400471EG', {credentials:'include', headers:{Accept:'application/json, text/plain, */*'}});
        return {status:r.status, cf:r.headers.get('cf-mitigated'), type:r.headers.get('content-type')||''};
      } catch (e) { return {error:String(e)}; }
    });
    if (probe.status === 200 && !probe.cf && probe.type.includes('application/json')) return;
    await sleep(2500);
  }
  throw new Error('Egypt Post browser session did not become usable within 60s');
}

async function fetchOne(page, tracking) {
  let lastError = '';
  for (let attempt=1; attempt<=MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const result = await page.evaluate(async ({tracking, timeout}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const r = await fetch(`/ar-EG/TrackTrace/GetShipmentDetails?barcode=${encodeURIComponent(tracking)}`, {
            method:'GET', credentials:'include', signal:controller.signal,
            headers:{Accept:'application/json, text/plain, */*'}
          });
          const text = await r.text();
          let raw=null; try { raw=JSON.parse(text); } catch {}
          return {http_status:r.status, cf_mitigated:r.headers.get('cf-mitigated'), content_type:r.headers.get('content-type'), raw, body_preview:text.slice(0,500)};
        } finally { clearTimeout(timer); }
      }, {tracking, timeout:REQUEST_TIMEOUT_MS});

      if (result.http_status === 200 && !result.cf_mitigated && result.raw?.success === true) {
        return {tracking_number:tracking, ok:true, attempts:attempt, elapsed_ms:Date.now()-started, collected_at:new Date().toISOString(), raw:result.raw};
      }
      lastError = `HTTP=${result.http_status} CF=${result.cf_mitigated||'null'} success=${result.raw?.success ?? 'n/a'} body=${result.body_preview||''}`;
    } catch (e) { lastError = String(e?.message || e); }
    if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
  }
  return {tracking_number:tracking, ok:false, attempts:MAX_ATTEMPTS, collected_at:new Date().toISOString(), error:lastError};
}

const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({locale:'ar-EG'});
  const page = await context.newPage();
  console.log('Opening Egypt Post and waiting for a usable browser session...');
  await waitForUsablePage(page);
  console.log('Browser session ready.');

  const active = await wpJson(`${WP_BASE}/wp-json/bequeen-app/v1/collector/shipments?limit=${LIMIT}`);
  console.log(`Active due shipments: ${active.count}`);
  if (!active.shipments?.length) process.exitCode = 0;
  else {
    const results=[];
    for (let i=0;i<active.shipments.length;i++) {
      const sh=active.shipments[i];
      console.log(`[${i+1}/${active.shipments.length}] ${sh.tracking_number}`);
      const r=await fetchOne(page, sh.tracking_number);
      r.order_id=Number(sh.order_id)||null;
      results.push(r);
      console.log(r.ok ? `  OK attempts=${r.attempts} ${r.elapsed_ms}ms` : `  ERROR ${r.error}`);
      if(i<active.shipments.length-1) await sleep(DELAY_MS);
    }
    const pushed=await wpJson(`${WP_BASE}/wp-json/bequeen-app/v1/collector/results`, {method:'POST', body:JSON.stringify({collector:'github-playwright', run_id:process.env.GITHUB_RUN_ID||null, results})});
    console.log('WordPress:', pushed);
    if (pushed.errors?.length) process.exitCode=1;
  }
} finally { await browser.close(); }
