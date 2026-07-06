#!/usr/bin/env node
/**
 * preview-internal-links.mjs — DRY RUN ONLY. Reads all product descriptions from
 * the public products.json and proposes ONE care-guide internal link per product
 * (first natural mention, HTML-safe, never inside an existing <a>). Writes nothing.
 *
 *   node scripts/preview-internal-links.mjs [numExamples]   # default 20 examples
 */

const STORE_URL = 'https://rainforestflora.com';
const NUM_EXAMPLES = parseInt(process.argv[2] || '20', 10);

// term → care guide (care-guide-primary). First matching guide by position wins.
const GUIDES = [
  { name: 'tillandsia',  url: '/pages/tillandsia-care-guide',  re: /\b(tillandsias?|air[ -]?plants?)\b/i },
  { name: 'neoregelia',  url: '/pages/neoregelia-care-guide',  re: /\b(neoregelias?)\b/i },
  { name: 'platycerium', url: '/pages/platycerium-care-guide', re: /\b(staghorn(?:[ -]ferns?)?|platyceriums?)\b/i },
];

function snippet(text, idx, match) {
  const a = Math.max(0, idx - 55), b = Math.min(text.length, idx + match.length + 55);
  const s = (text.slice(a, idx) + '⟦' + match + '⟧' + text.slice(idx + match.length, b)).replace(/\s+/g, ' ').trim();
  return (a > 0 ? '…' : '') + s + (b < text.length ? '…' : '');
}

// Propose a single link. Returns {guide, match, contextBefore, newHtml} or null.
function propose(html) {
  if (!html) return null;
  const tokens = html.split(/(<[^>]+>)/); // odd indices = tags
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
    if (html.includes(`href="${hit.guide.url}"`)) return { skipped: 'already links this guide', guide: hit.guide.name };
    const anchor = `<a href="${hit.guide.url}">${hit.match}</a>`;
    const newTok = tok.slice(0, hit.index) + anchor + tok.slice(hit.index + hit.match.length);
    const nt = tokens.slice(); nt[i] = newTok;
    return { guide: hit.guide.name, match: hit.match, contextBefore: snippet(tok, hit.index, hit.match), newHtml: nt.join('') };
  }
  return null;
}

async function fetchAll() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${STORE_URL}/products.json?limit=250&page=${page}`);
    const { products } = await res.json();
    if (!products || products.length === 0) break;
    all.push(...products);
    if (products.length < 250) break;
  }
  return all;
}

const products = await fetchAll();
let linked = 0, already = 0, none = 0;
const byGuide = {};
const examples = [];
for (const p of products) {
  const r = propose(p.body_html || '');
  if (!r) { none++; continue; }
  if (r.skipped) { already++; continue; }
  linked++; byGuide[r.guide] = (byGuide[r.guide] || 0) + 1;
  if (examples.length < NUM_EXAMPLES) examples.push({ title: p.title, guide: r.guide, ctx: r.contextBefore });
}

console.log(`\nScanned ${products.length} products (care-guide-primary, 1 link max, first mention)\n`);
console.log(`  would add a link:        ${linked}`);
console.log(`  already links its guide: ${already}`);
console.log(`  no linkable term:        ${none}`);
console.log(`  by guide: ${JSON.stringify(byGuide)}\n`);
console.log(`── ${examples.length} example proposals (⟦word⟧ = becomes the link) ──\n`);
for (const e of examples) {
  console.log(`• ${e.title}`);
  console.log(`   → /pages/${e.guide}-care-guide`);
  console.log(`   ${e.ctx}\n`);
}
