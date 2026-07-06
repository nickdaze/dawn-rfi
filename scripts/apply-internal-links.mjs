#!/usr/bin/env node
/**
 * apply-internal-links.mjs — add ONE care-guide internal link per product
 * description (first natural mention, HTML-safe), via the Admin GraphQL API.
 *
 * Auth: same Dev Dashboard client credentials as set-page-seo.mjs (.env), BUT the
 * app needs the **write_products** scope (add it in the Dev Dashboard, release the
 * version, and update the install so the client-credentials token includes it).
 *
 *   node scripts/apply-internal-links.mjs                       # DRY RUN (no writes)
 *   node scripts/apply-internal-links.mjs --apply --limit 10    # write first 10 changed (batch)
 *   node scripts/apply-internal-links.mjs --apply               # write all changed
 *   node scripts/apply-internal-links.mjs --rollback <file>     # restore originals
 *
 * Before any write, originals are saved to a rollback file (path printed) so the
 * whole run can be undone with --rollback.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
const STATIC_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2026-04';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.includes('--rollback') ? process.argv[process.argv.indexOf('--rollback') + 1] : null;
const LIMIT = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : Infinity;

// term → care guide (care-guide-primary). Identical logic to preview-internal-links.mjs.
const GUIDES = [
  { name: 'tillandsia',  url: '/pages/tillandsia-care-guide',  re: /\b(tillandsias?|air[ -]?plants?)\b/i },
  { name: 'neoregelia',  url: '/pages/neoregelia-care-guide',  re: /\b(neoregelias?)\b/i },
  { name: 'platycerium', url: '/pages/platycerium-care-guide', re: /\b(staghorn(?:[ -]ferns?)?|platyceriums?)\b/i },
];

function propose(html) {
  if (!html) return null;
  const tokens = html.split(/(<[^>]+>)/);
  let insideA = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i % 2 === 1) {
      if (/^<a\b/i.test(tok)) insideA++;
      else if (/^<\/a>/i.test(tok)) insideA = Math.max(0, insideA - 1);
      continue;
    }
    if (insideA > 0 || !tok) continue;
    let hit = null;
    for (const g of GUIDES) {
      const m = g.re.exec(tok);
      if (m && (hit === null || m.index < hit.index)) hit = { index: m.index, match: m[0], guide: g };
    }
    if (!hit) continue;
    if (html.includes(`href="${hit.guide.url}"`)) return null; // already links this guide
    const anchor = `<a href="${hit.guide.url}">${hit.match}</a>`;
    const nt = tokens.slice();
    nt[i] = tok.slice(0, hit.index) + anchor + tok.slice(hit.index + hit.match.length);
    return { guide: hit.guide.name, newHtml: nt.join('') };
  }
  return null;
}

if (!STATIC_TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error('✗ Missing credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env.');
  process.exit(1);
}

async function getAccessToken() {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const TOKEN = await getAccessToken();
const ENDPOINT = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    const throttled = json.errors && JSON.stringify(json.errors).match(/throttl/i);
    if (throttled && attempt < tries) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
    return json.data;
  }
}

const GET_PRODUCTS = `query GetProducts($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id handle title descriptionHtml }
  }
}`;

const UPDATE = `mutation UpdateDesc($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id handle } userErrors { field message } }
}`;

// ── gather all products, compute the changeset ──
const products = [];
let cursor = null;
do {
  const d = await gql(GET_PRODUCTS, { cursor });
  products.push(...d.products.nodes);
  cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
} while (cursor);

let changeset = [];
for (const p of products) {
  const r = propose(p.descriptionHtml || '');
  if (r) changeset.push({ id: p.id, handle: p.handle, title: p.title, guide: r.guide, original: p.descriptionHtml, newHtml: r.newHtml });
}

// ── rollback mode ──
if (ROLLBACK) {
  const saved = JSON.parse(readFileSync(ROLLBACK, 'utf8'));
  console.log(`Rolling back ${saved.length} products from ${ROLLBACK}...`);
  let ok = 0;
  for (const s of saved) {
    const res = await gql(UPDATE, { product: { id: s.id, descriptionHtml: s.original } });
    if (res.productUpdate.userErrors.length) console.error(`✗ ${s.handle}:`, res.productUpdate.userErrors);
    else ok++;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`✓ Restored ${ok}/${saved.length}.`);
  process.exit(0);
}

const batch = changeset.slice(0, LIMIT);
console.log(`\nStore: ${STORE}   Products: ${products.length}   Would link: ${changeset.length}   This run: ${batch.length}`);
console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

if (!APPLY) {
  const byGuide = {};
  for (const c of changeset) byGuide[c.guide] = (byGuide[c.guide] || 0) + 1;
  console.log(`by guide: ${JSON.stringify(byGuide)}`);
  console.log('\nDry run only. Re-run with --apply (add --limit N for a batch).');
  process.exit(0);
}

// ── save rollback BEFORE writing ──
const rollbackFile = join(dirname(fileURLToPath(import.meta.url)), `rollback-internal-links-${Date.now()}.json`);
writeFileSync(rollbackFile, JSON.stringify(batch.map(({ id, handle, original }) => ({ id, handle, original })), null, 2));
console.log(`Saved originals for rollback → ${rollbackFile}\n`);

let ok = 0;
for (const c of batch) {
  const res = await gql(UPDATE, { product: { id: c.id, descriptionHtml: c.newHtml } });
  const errs = res.productUpdate.userErrors;
  if (errs.length) { console.error(`✗ ${c.handle}:`, JSON.stringify(errs)); }
  else { ok++; console.log(`✓ ${c.handle} → /pages/${c.guide}-care-guide`); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`\n✓ Linked ${ok}/${batch.length}. Undo with: node scripts/apply-internal-links.mjs --rollback ${rollbackFile}`);
