#!/usr/bin/env node
// QualityLoop evaluation - independent reference scorer.
// Deliberately shares NO code with src/. Node >= 18, no dependencies.
//
// Usage:
//   node eval/reference/score.js --split dev  --data <dir> --predictions <file>
//   node eval/reference/score.js --split dev  --data <dir> --print-expected
// <dir> holds ncs.json and labels.json for the split (eval/dev, or the private test folder).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const split = opt('--split');
const dataDir = opt('--data');
const predFile = opt('--predictions');
const printExpected = args.includes('--print-expected');
if (!split || !dataDir || (!predFile && !printExpected)) {
  console.error('Usage: --split dev|test --data <dir> (--predictions <file> | --print-expected)');
  process.exit(2);
}

const evalRoot = path.resolve(__dirname, '..');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const frozen = JSON.parse(fs.readFileSync(path.join(evalRoot, 'FROZEN.json'), 'utf8'));
const files = {
  corpus: path.join(evalRoot, 'corpus', 'capas.json'),
  ncs: path.join(dataDir, 'ncs.json'),
  labels: path.join(dataDir, 'labels.json'),
};
for (const [k, p] of Object.entries(files)) {
  const want = k === 'corpus' ? frozen.sha256['corpus/capas.json'] : frozen.sha256[`${split}/${k}.json`];
  const got = sha(p);
  if (got !== want) { console.error(`FROZEN CHECK FAILED for ${p}\n expected ${want}\n got      ${got}`); process.exit(3); }
}

const corpus = JSON.parse(fs.readFileSync(files.corpus, 'utf8')).capas;
const ncs = JSON.parse(fs.readFileSync(files.ncs, 'utf8')).ncs;
const labels = Object.fromEntries(JSON.parse(fs.readFileSync(files.labels, 'utf8')).labels.map((l) => [l.id, l]));

// ---- L1 reference rules (see eval/README.md, section "L1 rules") ----
const norm = (s) => (s == null ? '' : String(s)).trim().replace(/\s+/g, ' ').toUpperCase();
// T24 named part-number rule: spaces around hyphens are removed.
// Failure-mode text keeps the original trim/collapse/uppercase rules.
const normPart = (s) => norm(s).replace(/\s*-\s*/g, '-');
const splitPart = (p) => { const m = /^(.*)-([A-Z]{1,2})$/.exec(p); return m ? { base: m[1], rev: m[2] } : { base: p, rev: '' }; };
const dayNum = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000);

function expectedFor(nc) {
  const np = normPart(nc.part), nf = norm(nc.failureMode), ns = splitPart(np);
  const out = { strong: [], relatedRevision: [] };
  for (const c of corpus) {
    if (!c.closedDate) continue;
    const days = dayNum(nc.detectedDate) - dayNum(c.closedDate);
    if (days < 1 || days > 365) continue;
    if (norm(c.failureMode) !== nf || !np) continue;
    const cp = normPart(c.part), cs = splitPart(cp);
    if (cp === np) out.strong.push(c.id);
    else if (cs.base === ns.base && cs.rev !== ns.rev) out.relatedRevision.push(c.id);
  }
  out.strong.sort(); out.relatedRevision.sort();
  return out;
}

if (printExpected) {
  for (const nc of ncs) { const e = expectedFor(nc); console.log(`${nc.id}\tstrong=[${e.strong}]\trelatedRevision=[${e.relatedRevision}]`); }
  process.exit(0);
}

const preds = JSON.parse(fs.readFileSync(predFile, 'utf8'));
const asSet = (a) => [...new Set(a || [])].sort().join(',');

let l1ok = 0; const l1bad = [];
let tp = 0, fp = 0, ambSurfaced = 0, truePairs = 0;
const burden = []; const misses = []; const falsePos = [];
const missByTrap = {};
let ncWithTrue = 0, ncHit = 0;

for (const nc of ncs) {
  const p = preds[nc.id];
  if (!p) { console.error(`Missing prediction for ${nc.id}`); process.exit(4); }
  const exp = expectedFor(nc);
  if (asSet(p.strong) === asSet(exp.strong) && asSet(p.relatedRevision) === asSet(exp.relatedRevision)) l1ok++;
  else l1bad.push(`${nc.id}: expected strong=[${exp.strong}] related=[${exp.relatedRevision}] got strong=[${asSet(p.strong)}] related=[${asSet(p.relatedRevision)}]`);

  const surfaced = new Set([...(p.strong || []), ...(p.relatedRevision || [])]);
  burden.push(surfaced.size);
  const lab = labels[nc.id];
  const pairLabel = (cid) => lab.pairs[cid] || 'NOT';
  for (const cid of surfaced) {
    const l = pairLabel(cid);
    if (l === 'TRUE') tp++; else if (l === 'AMBIGUOUS') ambSurfaced++; else { fp++; falsePos.push(`${nc.id}->${cid} (${lab.trap})`); }
  }
  const trues = Object.entries(lab.pairs).filter(([, v]) => v === 'TRUE').map(([k]) => k);
  if (trues.length) { ncWithTrue++; if (trues.some((t) => surfaced.has(t))) ncHit++; }
  for (const t of trues) {
    truePairs++;
    if (!surfaced.has(t)) { misses.push(`${nc.id}->${t} (${lab.trap})`); missByTrap[lab.trap] = (missByTrap[lab.trap] || 0) + 1; }
  }
}

const r = (x) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');
const recall = (truePairs - misses.length) / truePairs;
const precision = tp / (tp + fp);
const avgB = burden.reduce((a, b) => a + b, 0) / burden.length;
const maxB = Math.max(...burden);

console.log(`QualityLoop evaluation - split=${split}, NCs=${ncs.length}, CAPAs=${corpus.length}, frozen=${frozen.frozenAt}`);
console.log(`L1 signature correctness: ${l1ok}/${ncs.length}  (target: all)`);
l1bad.forEach((x) => console.log('  L1 MISMATCH ' + x));
console.log(`L2 pair recall:     ${r(recall)}  (${truePairs - misses.length}/${truePairs} TRUE pairs surfaced; target >= 0.95)`);
console.log(`L2 NC-level recall: ${r(ncHit / ncWithTrue)}  (${ncHit}/${ncWithTrue} NCs with a true precedent had at least one surfaced)`);
console.log(`L2 pair precision:  ${r(precision)}  (${tp} TRUE, ${fp} NOT, ${ambSurfaced} AMBIGUOUS surfaced; ambiguous excluded; reported, no target)`);
console.log(`Review burden: avg ${r(avgB)} cards/NC (target <= 3), max ${maxB} (target <= 6)`);
console.log('Missed TRUE pairs by trap type:', JSON.stringify(missByTrap));
misses.forEach((x) => console.log('  MISS ' + x));

// ---- Secondary report (added 2026-11-01, after freeze; data unchanged): "check these" hints ----
// Hints are NOT matches. They are reported separately and never change the primary metrics above.
if (Object.values(preds).some((p) => Array.isArray(p.hints))) {
  let caught = 0, hintCards = 0, hintMax = 0, hintTrue = 0, hintNot = 0;
  const stillMissed = [];
  for (const nc of ncs) {
    const p = preds[nc.id];
    const hints = new Set(p.hints || []);
    hintCards += hints.size; hintMax = Math.max(hintMax, hints.size);
    const lab = labels[nc.id];
    for (const h of hints) { const l = lab.pairs[h] || 'NOT'; if (l === 'TRUE') hintTrue++; else if (l === 'NOT') hintNot++; }
  }
  for (const m of misses) {
    const [id, rest] = m.split('->'); const cid = rest.split(' ')[0];
    if ((preds[id].hints || []).includes(cid)) caught++; else stillMissed.push(m);
  }
  console.log('--- Secondary: "check these" hints (not matches) ---');
  console.log(`Recall incl. hints: ${r((truePairs - misses.length + caught) / truePairs)}  (${caught} of ${misses.length} missed TRUE pairs appear as hints)`);
  console.log(`Hint cards: avg ${r(hintCards / ncs.length)}/NC, max ${hintMax}; hints that are TRUE ${hintTrue}, NOT ${hintNot}`);
  stillMissed.forEach((x) => console.log('  STILL MISSED ' + x));
}
falsePos.forEach((x) => console.log('  FIELD-ONLY MATCH (expert says not a recurrence) ' + x));
