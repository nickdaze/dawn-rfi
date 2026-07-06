#!/usr/bin/env node
/**
 * set-page-seo.mjs — set SEO meta descriptions on Rainforest Flora content pages
 * via the Shopify Admin GraphQL API (page SEO description = global.description_tag
 * metafield). Validated against Admin API 2026-04.
 *
 * Auth: a Dev Dashboard app + the client-credentials grant. You store a long-lived
 * Client ID / Client secret; this script exchanges them for a short-lived (24h)
 * access token at runtime. No long-lived token is stored or printed.
 * (Legacy custom apps can no longer be created as of Jan 1, 2026.)
 *
 * ── Setup (one time) ─────────────────────────────────────────────────────────
 * 1. Shopify admin → Settings → Apps and sales channels → Develop apps →
 *    "Build apps in Dev Dashboard" → Create app → Start from Dev Dashboard.
 * 2. Configure the app's Admin API access scopes: write_content
 *    (also write_online_store_pages if offered). Save / release the version.
 * 3. Install the app on the Rainforest Flora store (app Home → Install app).
 * 4. App → Settings → copy the Client ID and Client secret.
 * 5. Put them in .env (see .env.example). The app and store must belong to the
 *    same Shopify organization for the client-credentials grant to work.
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   node scripts/set-page-seo.mjs          # DRY RUN: shows current → new, writes nothing
 *   node scripts/set-page-seo.mjs --apply   # actually writes the descriptions
 *
 * Only the pages listed in DESCRIPTIONS below are touched. Anything not listed
 * (e.g. neoregelia-care-guide, which already has a good description) is left alone.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load .env (repo root) into process.env without overriding vars already set in
// the shell. So either exported env vars or a local .env file work.
(function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(process.cwd(), '.env'), join(here, '..', '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return;
  }
})();

const STORE = process.env.SHOPIFY_STORE || '42d600-71.myshopify.com';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // optional: legacy shpat_ token
const API_VERSION = '2026-04';
const APPLY = process.argv.includes('--apply');

// handle → SEO meta description (~150-160 chars, keyword-optimized)
const DESCRIPTIONS = {
  'contact':
    'Visit or call Rainforest Flora in Torrance, CA for airplants, tillandsias, staghorn ferns and bromeliads. Store hours, address and phone: (310) 370-8044.',
  'about-us':
    'Rainforest Flora has grown and shipped rare tillandsias, staghorn ferns and landscape bromeliads across the US since 1974. Visit our Torrance, CA nursery.',
  'care-guides':
    'Free care guides from Rainforest Flora for airplants (Tillandsia), staghorn ferns (Platycerium), neoregelias and vrieseas. Grow healthy plants with expert tips.',
  'tillandsia-care-guide':
    'Airplant (Tillandsia) care guide: how to water, light and grow these soil-free bromeliads. Expert tips from Rainforest Flora, growing tillandsias since 1974.',
  'platycerium-care-guide':
    'How to care for staghorn ferns (Platycerium): light, watering, temperature and mounting tips from Rainforest Flora, growing epiphytes since 1974.',
  'data-sharing-opt-out':
    'Manage your privacy choices at Rainforest Flora and opt out of the sale or sharing of your personal information for targeted advertising.',
};

if (!STATIC_TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error('✗ Missing credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env (see .env.example).');
  process.exit(1);
}

// Exchange Client ID/secret for a short-lived (24h) Admin API token.
async function getAccessToken() {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  if (!j.access_token) throw new Error(`No access_token in response: ${JSON.stringify(j)}`);
  return j.access_token;
}

const TOKEN = await getAccessToken();
const ENDPOINT = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data;
}

const GET_PAGES = `query GetPages {
  pages(first: 100) {
    nodes { id handle title metafield(namespace: "global", key: "description_tag") { value } }
  }
}`;

const SET_SEO = `mutation SetSeo($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key value }
    userErrors { field message code }
  }
}`;

function clip(s, n = 60) { return !s ? '(none)' : s.length > n ? s.slice(0, n) + '…' : s; }

const data = await gql(GET_PAGES);
const byHandle = Object.fromEntries(data.pages.nodes.map((p) => [p.handle, p]));

console.log(`\nStore: ${STORE}   Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

const toWrite = [];
for (const [handle, desc] of Object.entries(DESCRIPTIONS)) {
  const page = byHandle[handle];
  if (!page) { console.log(`⚠️  /pages/${handle}: not found on store — skipping`); continue; }
  const current = page.metafield?.value || null;
  console.log(`• /pages/${handle}  (${desc.length} chars)`);
  console.log(`    current: ${clip(current)}`);
  console.log(`    new:     ${clip(desc)}\n`);
  toWrite.push({ ownerId: page.id, namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: desc });
}

if (!APPLY) {
  console.log('Dry run only. Re-run with --apply to write these descriptions.');
  process.exit(0);
}

const result = await gql(SET_SEO, { metafields: toWrite });
const errs = result.metafieldsSet.userErrors;
if (errs.length) { console.error('✗ userErrors:', JSON.stringify(errs, null, 2)); process.exit(1); }
console.log(`✓ Updated ${result.metafieldsSet.metafields.length} page descriptions.`);
