#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const evidenceRoot = "docs/research/event-contract/evidence";
const evidencePath = `${evidenceRoot}/event-contract-orderbooks-2026-08-30.json`;
const binanceEventScreenshotPath = `${evidenceRoot}/binance-event-btcusdt-10m-payout-2026-09-01.jpg`;
const binanceEventProvenancePath = `${evidenceRoot}/binance-event-btcusdt-10m-payout-2026-09-01.json`;
const reportPath = "docs/research/event-contract/product-comparison.html";
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
const binanceEventScreenshot = fs.readFileSync(binanceEventScreenshotPath);
const binanceEventProvenance = JSON.parse(fs.readFileSync(binanceEventProvenancePath, "utf8"));
const report = fs.readFileSync(reportPath, "utf8");
const shares = 100;

assert.equal(
  crypto.createHash("sha256").update(binanceEventScreenshot).digest("hex"),
  "d173fb5bf7838b9b209dad580c1650e6e8c061bf212e77235516aad4702b4863",
  "Binance Event published evidence hash drift",
);
assert.equal(binanceEventProvenance.evidence_type, "owner_supplied_production_screenshot");
assert.equal(binanceEventProvenance.source_application, "Binance mobile app");
assert.equal(binanceEventProvenance.source_surface, "Events");
assert.equal(binanceEventProvenance.source_url, null);
assert.equal(binanceEventProvenance.instrument, "BTCUSDT");
assert.equal(binanceEventProvenance.time_increment, "10 min");
assert.deepEqual(binanceEventProvenance.displayed_payouts, {
  header_higher: "80%",
  header_lower: "80%",
  order_panel_higher: "80%",
  order_panel_lower: "80%",
});
assert.equal(binanceEventProvenance.owner_attestation_original, "prod 10分钟就是0.8");
assert.equal(binanceEventProvenance.received_in_active_review_thread_at, "2026-09-01T00:04:50+08:00");
assert.equal(binanceEventProvenance.image_file, "binance-event-btcusdt-10m-payout-2026-09-01.jpg");
assert.equal(binanceEventProvenance.image_sha256, "d173fb5bf7838b9b209dad580c1650e6e8c061bf212e77235516aad4702b4863");
assert.deepEqual(binanceEventProvenance.image_dimensions_px, { width: 1280, height: 2781 });
assert.equal(binanceEventProvenance.image_encoding, "JPEG published copy");
assert.match(binanceEventProvenance.scope_limit, /BTCUSDT 10-minute production screen only/);

function ordered(levels, ascending) {
  return levels
    .map(([price, size]) => [Number(price), Number(size)])
    .filter(([price, size]) => Number.isFinite(price) && Number.isFinite(size) && size > 0)
    .sort((left, right) => ascending ? left[0] - right[0] : right[0] - left[0]);
}

function levelsThrough(levels, ascending) {
  const selected = [];
  let total = 0;
  for (const level of ordered(levels, ascending)) {
    selected.push(level);
    total += level[1];
    if (total >= shares) break;
  }
  return selected;
}

function walk(levels, ascending, rawFee, roundFee) {
  let remaining = shares;
  let notional = 0;
  let fee = 0;
  const fills = [];
  for (const [price, available] of ordered(levels, ascending)) {
    const filled = Math.min(remaining, available);
    notional += price * filled;
    fee += rawFee(price, filled);
    fills.push([price, filled]);
    remaining -= filled;
    if (remaining < 1e-9) break;
  }
  if (remaining >= 1e-9) return { fillable: false, available: shares - remaining, fills };
  return { fillable: true, notional, fee: roundFee(notional, fee), fills };
}

function responseJson(record) {
  assert.equal(crypto.createHash("sha256").update(record.body).digest("hex"), record.body_sha256);
  return JSON.parse(record.body);
}

function sourceBooks(snapshot) {
  const predict = responseJson(snapshot.source_responses.predict.graphql_response).data.market;
  assert.equal(predict.id, snapshot.markets.predict.id);
  assert.equal(predict.orderbook.marketId, Number(predict.id));
  assert.deepEqual(predict.outcomes.edges.map(({ node }) => node.name), ["Up", "Down"]);
  assert.ok(snapshot.source_responses.predict.market_page_identity.identity_fragment.includes(`\\"id\\":\\"${predict.id}\\"`));

  const okxInstruments = responseJson(snapshot.source_responses.okx.instruments);
  const okxMarket = okxInstruments.data.find(({ instId }) => instId === snapshot.markets.okx.id);
  assert.equal(Number(okxMarket.expTime), Date.parse(snapshot.common_market_window.end));
  assert.equal(okxMarket.method, "PRICE_UP_DOWN");
  assert.equal(okxMarket.ctVal, "1", "OKX event-contract face-value unit drift");
  assert.equal(okxMarket.lotSz, "0.1", "OKX event-contract lot-size drift");
  assert.equal(okxMarket.minSz, "0.01", "OKX event-contract minimum-size drift");
  assert.equal(okxMarket.settleCcy, "USDT", "OKX event-contract settlement-currency drift");
  const okx = responseJson(snapshot.source_responses.okx.orderbook).data[0];

  const polymarketMetadata = responseJson(snapshot.source_responses.polymarket.metadata)[0];
  assert.equal(polymarketMetadata.slug, snapshot.markets.polymarket.slug);
  assert.deepEqual(JSON.parse(polymarketMetadata.outcomes), ["Up", "Down"]);
  assert.deepEqual(JSON.parse(polymarketMetadata.clobTokenIds), snapshot.markets.polymarket.token_ids);
  assert.equal(Date.parse(polymarketMetadata.endDate), Date.parse(snapshot.common_market_window.end));
  const polymarket = snapshot.source_responses.polymarket.orderbooks.map(responseJson);

  const kalshiMarket = responseJson(snapshot.source_responses.kalshi.market).market;
  assert.equal(kalshiMarket.ticker, snapshot.markets.kalshi.ticker);
  assert.equal(Date.parse(kalshiMarket.open_time), Date.parse(snapshot.common_market_window.start));
  assert.equal(Date.parse(kalshiMarket.close_time), Date.parse(snapshot.common_market_window.end));
  const kalshi = responseJson(snapshot.source_responses.kalshi.orderbook).orderbook_fp;

  return {
    predict: {
      up: { asks: predict.orderbook.asks, bids: predict.orderbook.bids },
      down: {
        asks: predict.orderbook.bids.map(([price, size]) => [1 - Number(price), size]),
        bids: predict.orderbook.asks.map(([price, size]) => [1 - Number(price), size]),
      },
    },
    okx: {
      up: { asks: okx.asks, bids: okx.bids },
      down: {
        asks: okx.bids.map(([price, size]) => [1 - Number(price), size]),
        bids: okx.asks.map(([price, size]) => [1 - Number(price), size]),
      },
    },
    polymarket: {
      up: {
        asks: polymarket[0].asks.map(({ price, size }) => [price, size]),
        bids: polymarket[0].bids.map(({ price, size }) => [price, size]),
      },
      down: {
        asks: polymarket[1].asks.map(({ price, size }) => [price, size]),
        bids: polymarket[1].bids.map(({ price, size }) => [price, size]),
      },
    },
    kalshi: {
      up: {
        asks: kalshi.no_dollars.map(([price, size]) => [1 - Number(price), size]),
        bids: kalshi.yes_dollars,
      },
      down: {
        asks: kalshi.yes_dollars.map(([price, size]) => [1 - Number(price), size]),
        bids: kalshi.no_dollars,
      },
    },
  };
}

const standardRound = (_notional, fee) => fee;
const polymarketRound = (_notional, fee) => Math.round((fee + Number.EPSILON) * 1e5) / 1e5;
const kalshiRound = (notional, fee) => Math.ceil((notional + fee - 1e-12) * 1e4) / 1e4 - notional;
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const rounded = (value, digits = 4) => value === null ? null : Number(value.toFixed(digits));

const rawPaths = Object.keys(evidence.raw_capture_sha256).map((name) => `${evidenceRoot}/${name}`);
const rawSnapshots = rawPaths.map((path) => JSON.parse(fs.readFileSync(path, "utf8")));
assert.equal(rawSnapshots.length, 3, "three immutable source-response captures are required");
rawPaths.forEach((path) => {
  assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
    evidence.raw_capture_sha256[path.replace(`${evidenceRoot}/`, "")],
  );
});

const windowIdentity = JSON.stringify(rawSnapshots[0].common_market_window);
const booksBySnapshot = rawSnapshots.map((snapshot, index) => {
  assert.equal(JSON.stringify(snapshot.common_market_window), windowIdentity);
  const fetchDuration = Date.parse(snapshot.fetch_completed_at) - Date.parse(snapshot.collected_at);
  assert.ok(fetchDuration >= 0 && fetchDuration <= 5_000);
  const books = sourceBooks(snapshot);
  for (const venue of Object.keys(books)) {
    for (const side of ["up", "down"]) {
      assert.deepEqual({
        asks_through_100: levelsThrough(books[venue][side].asks, true),
        bids_through_100: levelsThrough(books[venue][side].bids, false),
      }, snapshot.raw_books[venue][side]);
    }
  }
  const derived = structuredClone(snapshot);
  delete derived.schema_version;
  delete derived.calculations;
  delete derived.source_responses;
  assert.deepEqual(derived, evidence.snapshots[index]);
  return books;
});

const venueConfig = {
  predict: (snapshot) => ({
    raw: (price, count) => snapshot.fee_inputs.predict.taker_fee_bps_from_market / 10_000 * Math.min(price, 1 - price) * count,
    round: standardRound,
  }),
  okx: (snapshot) => ({
    raw: (price, count) => snapshot.fee_inputs.okx.taker_coefficient * price * (1 - price) * count,
    round: standardRound,
  }),
  polymarket: (snapshot) => ({
    raw: (price, count) => snapshot.fee_inputs.polymarket_crypto.taker_coefficient * price * (1 - price) * count,
    round: polymarketRound,
  }),
  kalshi: () => ({
    raw: (price, count) => 0.07 * price * (1 - price) * count,
    round: kalshiRound,
  }),
};

const derivedAggregates = {};
for (const venue of Object.keys(venueConfig)) {
  const measurements = { losses: [], spreads: [], entrySlippage: [], depth: [], fees: [], unfilled: [] };
  rawSnapshots.forEach((snapshot, snapshotIndex) => {
    const policy = venueConfig[venue](snapshot);
    for (const side of ["up", "down"]) {
      const book = booksBySnapshot[snapshotIndex][venue][side];
      const asks = ordered(book.asks, true);
      const bids = ordered(book.bids, false);
      measurements.spreads.push((asks[0][0] - bids[0][0]) * 100);
      const buy = walk(asks, true, policy.raw, policy.round);
      const sell = walk(bids, false, policy.raw, policy.round);
      if (!buy.fillable || !sell.fillable) {
        if (!buy.fillable) measurements.unfilled.push(buy.available);
        if (!sell.fillable) measurements.unfilled.push(sell.available);
        continue;
      }
      const buySlippage = (buy.notional / shares - asks[0][0]) * 100;
      const sellSlippage = (bids[0][0] - sell.notional / shares) * 100;
      measurements.losses.push((buy.notional + buy.fee - sell.notional + sell.fee) / shares * 100);
      measurements.entrySlippage.push(buySlippage);
      measurements.depth.push(buySlippage + sellSlippage);
      measurements.fees.push(buy.fee + sell.fee);
    }
  });
  const loss = measurements.losses.length ? median(measurements.losses) : null;
  derivedAggregates[venue] = {
    observations: 6,
    fillable_round_trip_observations: measurements.losses.length,
    median_immediate_round_trip_loss_pp: rounded(loss),
    median_spread_pp: rounded(median(measurements.spreads)),
    median_entry_slippage_pp: measurements.losses.length ? rounded(median(measurements.entrySlippage)) : null,
    median_two_leg_depth_impact_pp: measurements.losses.length ? rounded(median(measurements.depth)) : null,
    median_two_leg_fees: measurements.losses.length ? rounded(median(measurements.fees), 6) : null,
    max_unfilled_leg_visible_shares: measurements.unfilled.length ? rounded(Math.max(...measurements.unfilled)) : null,
    cost_score_20: measurements.losses.length === 6 ? rounded(Math.max(0, 20 - 2 * loss), 1) : 0,
  };
}
assert.deepEqual(derivedAggregates, evidence.aggregation.aggregate);

const okxEntryChecks = rawSnapshots.map((snapshot, snapshotIndex) => {
  const policy = venueConfig.okx(snapshot);
  const upBuy = walk(booksBySnapshot[snapshotIndex].okx.up.asks, true, policy.raw, policy.round);
  const upSell = walk(booksBySnapshot[snapshotIndex].okx.up.bids, false, policy.raw, policy.round);
  const downBuy = walk(booksBySnapshot[snapshotIndex].okx.down.asks, true, policy.raw, policy.round);
  assert.equal(upBuy.fillable, true, `OKX Up entry must fill in snapshot ${snapshotIndex + 1}`);
  assert.equal(upSell.fillable, false, `OKX Up exit must not fill in snapshot ${snapshotIndex + 1}`);
  assert.equal(downBuy.fillable, false, `OKX Down entry must not fill in snapshot ${snapshotIndex + 1}`);
  assert.equal(rounded(upBuy.fills.slice(0, 10).reduce((sum, [, count]) => sum + count, 0), 1), 1);
  assert.deepEqual(upBuy.fills.slice(-2).map(([price, count]) => [price, rounded(count, 1)]), [[0.9, 40], [0.99, 59]]);
  return {
    up_total_cost: rounded(upBuy.notional + upBuy.fee, 6),
    up_break_even_pct: rounded((upBuy.notional + upBuy.fee) / shares * 100, 6),
    up_exit_visible_shares: rounded(upSell.available, 1),
    down_entry_visible_shares: rounded(downBuy.available, 1),
  };
});
assert.deepEqual(okxEntryChecks.map(({ up_total_cost }) => up_total_cost), [94.902606, 94.810581, 94.779744]);
assert.deepEqual(okxEntryChecks.map(({ up_break_even_pct }) => up_break_even_pct), [94.902606, 94.810581, 94.779744]);
assert.deepEqual(okxEntryChecks.map(({ down_entry_visible_shares }) => down_entry_visible_shares), [80.5, 80, 80]);
assert.deepEqual(okxEntryChecks.map(({ up_exit_visible_shares }) => up_exit_visible_shares), [80.5, 80, 80]);

const entryBreakEvenChecks = {};
for (const venue of Object.keys(venueConfig)) {
  entryBreakEvenChecks[venue] = { up: [], down: [], fillable: [], median_fillable_pct: null };
  rawSnapshots.forEach((snapshot, snapshotIndex) => {
    const policy = venueConfig[venue](snapshot);
    for (const side of ["up", "down"]) {
      const buy = walk(booksBySnapshot[snapshotIndex][venue][side].asks, true, policy.raw, policy.round);
      const threshold = buy.fillable ? rounded((buy.notional + buy.fee) / shares * 100, venue === "okx" ? 6 : 4) : null;
      entryBreakEvenChecks[venue][side].push(threshold);
      if (threshold !== null) entryBreakEvenChecks[venue].fillable.push(threshold);
    }
  });
  entryBreakEvenChecks[venue].median_fillable_pct = rounded(median(entryBreakEvenChecks[venue].fillable), venue === "okx" ? 6 : 4);
}
assert.deepEqual(entryBreakEvenChecks.predict, {
  up: [19.6723, 12.373, 10.4269],
  down: [85.3925, 93.6181, 95.2351],
  fillable: [19.6723, 85.3925, 12.373, 93.6181, 10.4269, 95.2351],
  median_fillable_pct: 52.5324,
});
assert.deepEqual(entryBreakEvenChecks.okx, {
  up: [94.902606, 94.810581, 94.779744],
  down: [null, null, null],
  fillable: [94.902606, 94.810581, 94.779744],
  median_fillable_pct: 94.810581,
});
assert.deepEqual(entryBreakEvenChecks.polymarket, {
  up: [15.4199, 5.3325, 3.2037],
  down: [88.7392, 96.2688, 98.1372],
  fillable: [15.4199, 88.7392, 5.3325, 96.2688, 3.2037, 98.1372],
  median_fillable_pct: 52.0795,
});
assert.deepEqual(entryBreakEvenChecks.kalshi, {
  up: [9.9074, 3.7365, 1.6035],
  down: [91.3848, 96.83, 98.6967],
  fillable: [9.9074, 91.3848, 3.7365, 96.83, 1.6035, 98.6967],
  median_fillable_pct: 50.6461,
});

const binanceEventBreakEven = (payoutRatio, tieProbability = 0) => rounded(100 * (1 - tieProbability) / (1 + payoutRatio), 2);
assert.equal(binanceEventBreakEven(0.80), 55.56, "Binance Event fixed-r non-tie break-even drift");
assert.equal(binanceEventBreakEven(0.80, 0.01), 55, "Binance Event tie-aware break-even drift");

const breakEvenChartPrice = 0.50;
const breakEvenChartAxisPp = 6;
const breakEvenChart = [
  {
    label: "Binance Wallet / Predict.fun",
    breakEvenPct: 100 * (breakEvenChartPrice + 0.02 * Math.min(breakEvenChartPrice, 1 - breakEvenChartPrice)),
    displayDigits: 2,
  },
  {
    label: "OKX",
    breakEvenPct: 100 * (breakEvenChartPrice + 0.045 * breakEvenChartPrice * (1 - breakEvenChartPrice)),
    displayDigits: 3,
  },
  {
    label: "Polymarket",
    breakEvenPct: 100 * (breakEvenChartPrice + 0.07 * breakEvenChartPrice * (1 - breakEvenChartPrice)),
    displayDigits: 2,
  },
  {
    label: "Kalshi",
    breakEvenPct: 100 * (breakEvenChartPrice + 0.07 * breakEvenChartPrice * (1 - breakEvenChartPrice)),
    displayDigits: 2,
  },
  {
    label: "Binance Event",
    labelHtml: "Binance Event · <code>r=0.80</code>",
    breakEvenPct: 100 / (1 + 0.80),
    displayDigits: 2,
  },
].map(({ label, labelHtml = label, breakEvenPct, displayDigits }) => {
  return {
    label,
    label_html: labelHtml,
    break_even_pct: rounded(breakEvenPct, displayDigits),
    bar_width_pct: rounded((breakEvenPct - 50) / breakEvenChartAxisPp * 100, 4),
  };
});
assert.deepEqual(breakEvenChart, [
  { label: "Binance Wallet / Predict.fun", label_html: "Binance Wallet / Predict.fun", break_even_pct: 51, bar_width_pct: 16.6667 },
  { label: "OKX", label_html: "OKX", break_even_pct: 51.125, bar_width_pct: 18.75 },
  { label: "Polymarket", label_html: "Polymarket", break_even_pct: 51.75, bar_width_pct: 29.1667 },
  { label: "Kalshi", label_html: "Kalshi", break_even_pct: 51.75, bar_width_pct: 29.1667 },
  { label: "Binance Event", label_html: "Binance Event · <code>r=0.80</code>", break_even_pct: 55.56, bar_width_pct: 92.5926 },
], "break-even comparison formulas drift");

const totals = {
  polymarket: derivedAggregates.polymarket.cost_score_20 + 20 + 20 + 20 + 20,
  kalshi: derivedAggregates.kalshi.cost_score_20 + 20 + 20 + 20 + 16,
  predict: derivedAggregates.predict.cost_score_20 + 20 + 20 + 20 + 20,
  okx: derivedAggregates.okx.cost_score_20 + 20 + 20 + 20 + 20,
  binanceEvent: rounded((0 + 20 + 20 + 16) / 80 * 100 + 1e-9, 1),
};
assert.deepEqual(totals, { polymarket: 96.8, kalshi: 94.9, predict: 88.7, okx: 80, binanceEvent: 70 });

const renderedScores = [
  { label: "① Polymarket", components: [derivedAggregates.polymarket.cost_score_20, 20, 20, 20, 20], total: totals.polymarket },
  { label: "② Kalshi", components: [derivedAggregates.kalshi.cost_score_20, 20, 20, 20, 16], total: totals.kalshi },
  { label: "③ Wallet / Predict.fun", tableLabel: "③ Binance Wallet · Predict.fun", components: [derivedAggregates.predict.cost_score_20, 20, 20, 20, 20], total: totals.predict },
  { label: "④ OKX", components: [derivedAggregates.okx.cost_score_20, 20, 20, 20, 20], total: totals.okx },
];
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const textOnly = (value) => value.replace(/<[^>]*>/g, "").trim();
const binaryRelationRows = [...report.matchAll(/<tr data-binary-relation="([^"]+)">([\s\S]*?)<\/tr>/g)].map((match) => ({
  topic: match[1],
  cells: [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]),
}));
assert.deepEqual(binaryRelationRows.map(({ topic }) => topic), ["entry", "profit", "exit", "edge"], "binary-option relationship must stay conclusion-led");
for (const { topic, cells } of binaryRelationRows) {
  assert.equal(cells.length, 4, `binary-option relationship column drift: ${topic}`);
  assert.match(cells[3], /^<strong>/, `binary-option relationship row lacks a direct conclusion: ${topic}`);
}
const workedExampleRows = [...report.matchAll(/<tr data-worked-product="([^"]+)">([\s\S]*?)<\/tr>/g)].map((match) => ({
  product: match[1],
  cells: [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOnly(cell[1])),
}));
assert.deepEqual(
  workedExampleRows.map(({ product }) => product),
  ["okx", "polymarket", "kalshi", "predict", "binance-event"],
  "worked-example table must cover all five products exactly once",
);
for (const { product, cells } of workedExampleRows) assert.equal(cells.length, 6, `worked-example column drift: ${product}`);
const workedByProduct = Object.fromEntries(workedExampleRows.map(({ product, cells }) => [product, cells]));
assert.match(workedByProduct.okx[1], /51\.125 USDT/);
assert.match(workedByProduct.okx[4], /51\.125%/);
assert.match(workedByProduct.polymarket[1], /51\.75 USDC/);
assert.match(workedByProduct.polymarket[4], /51\.75%/);
assert.match(workedByProduct.kalshi[1], /M=1.*51\.75 USD/);
assert.match(workedByProduct.kalshi[4], /51\.75%/);
assert.match(workedByProduct.predict[1], /51 USDT/);
assert.match(workedByProduct.predict[4], /51\.00%.*0\.5×/);
assert.match(workedByProduct["binance-event"][1], /50 USDT.*r=0\.80/);
assert.match(workedByProduct["binance-event"][4], /55\.56%.*非平局/);
for (const expected of breakEvenChart) {
  const row = report.match(new RegExp(`<div class="metric-row[^"]*"><div class="metric-head"><strong>${escapeRegExp(expected.label_html)}</strong><code>([\\d.]+)%</code></div><div class="metric-track"><span class="metric-fill" style="--bar:([\\d.]+)%"></span></div></div>`));
  assert.ok(row, `missing break-even chart row: ${expected.label}`);
  assert.equal(Number(row[1]), expected.break_even_pct, `break-even chart label drift: ${expected.label}`);
  assert.equal(Number(row[2]), expected.bar_width_pct, `break-even chart width drift: ${expected.label}`);
}
const reportRows = [...report.matchAll(/<tr(?: [^>]*)?>([\s\S]*?)<\/tr>/g)]
  .map((match) => [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => textOnly(cell[1])));
const playerQuestionRows = [...report.matchAll(/<tr data-player-question="([^"]+)">([\s\S]*?)<\/tr>/g)].map((match) => ({
  question: match[1],
  cells: [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]),
}));
assert.deepEqual(
  playerQuestionRows.map(({ question }) => question),
  ["summary", "account", "exit", "horizon", "settlement", "verification", "roundtrip", "hold"],
  "five-product matrix must answer every player question exactly once",
);
for (const { question, cells } of playerQuestionRows) {
  assert.equal(cells.length, 7, `five-product matrix column drift: ${question}`);
  assert.match(cells[6], /^\s*<strong>/, `five-product matrix lacks a direct player conclusion: ${question}`);
}
const roundTripComparison = reportRows.find((cells) => cells[0]?.startsWith("交易成本：100 份立即买入再卖出"));
assert.ok(roundTripComparison, "missing plain-language round-trip cost comparison row");
assert.equal(roundTripComparison.length, 7);
assert.match(roundTripComparison[1], /无法比较.*0 \/ 6.*80\.5/);
assert.match(roundTripComparison[2], new RegExp(`第二便宜.*${derivedAggregates.polymarket.median_immediate_round_trip_loss_pp.toFixed(4)} USDT`));
assert.match(roundTripComparison[3], new RegExp(`最便宜.*${derivedAggregates.kalshi.median_immediate_round_trip_loss_pp.toFixed(4)} USDT`));
assert.match(roundTripComparison[4], new RegExp(`第三.*${derivedAggregates.predict.median_immediate_round_trip_loss_pp.toFixed(4)} USDT`));
assert.match(roundTripComparison[5], /N\/A.*没有订单簿且不能提前卖出.*100 份立即往返测试.*经济折价.*r/);
assert.match(roundTripComparison[6], /Kalshi 最便宜.*Polymarket 第二.*Predict\.fun 第三.*OKX 连 100 份都无法完整退出.*Binance Event 不适用/);

const holdComparison = reportRows.find((cells) => cells[0]?.startsWith("只买入并持有到期"));
assert.ok(holdComparison, "missing buy-and-hold break-even comparison row");
assert.equal(holdComparison.length, 7);
assert.match(holdComparison[1], /94\.7797%–94\.9026%.*Down 无法买满 100 份/);
assert.match(holdComparison[2], /Up 3\.2037%–15\.4199%.*Down 88\.7392%–98\.1372%/);
assert.match(holdComparison[3], /Up 1\.6035%–9\.9074%.*三次都是 Up 最低门槛.*Down 91\.3848%–98\.6967%/);
assert.match(holdComparison[4], /Up 10\.4269%–19\.6723%.*Down 85\.3925%–95\.2351%.*三次都是 Down 最低门槛/);
assert.match(holdComparison[5], /本次参评合约 r=0\.80.*55\.56%.*q\*=\(1−t\)\/1\.8/);
assert.match(holdComparison[6], /没有固定赢家.*门槛随方向和买价变化.*低门槛只代表买得便宜.*不代表更容易猜中/);
for (const score of renderedScores) {
  const chartMatch = report.match(new RegExp(`<div class="score-row"><div class="score-head"><strong>${escapeRegExp(score.label)}</strong><span class="score-total">([^<]+)</span></div><div class="score-track">([\\s\\S]*?)</div></div>`));
  assert.ok(chartMatch, `missing chart row: ${score.label}`);
  assert.equal(Number(chartMatch[1]), score.total, `chart total drift: ${score.label}`);
  const chartSegments = [...chartMatch[2].matchAll(/class="score-seg[^\"]*" style="width:([\d.]+)%">([^<]+)<\/span>/g)];
  assert.deepEqual(chartSegments.map((match) => Number(match[1])), score.components, `chart widths drift: ${score.label}`);
  assert.deepEqual(chartSegments.map((match) => Number(match[2])), score.components, `chart labels drift: ${score.label}`);

  const tableLabel = score.tableLabel || score.label;
  const tableRows = [...report.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1])
    .filter((row) => row.includes(`<strong>${tableLabel}</strong>`) && row.includes("/20") && row.includes("/100"));
  assert.equal(tableRows.length, 1, `expected one score-table row: ${tableLabel}`);
  const cells = [...tableRows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOnly(match[1]));
  assert.deepEqual(cells.slice(1, 6).map((cell) => Number(cell.match(/([\d.]+)\/20/)?.[1])), score.components, `score table components drift: ${tableLabel}`);
  assert.equal(Number(cells[6].match(/([\d.]+)\/100/)?.[1]), score.total, `score table total drift: ${tableLabel}`);

  const provenanceRows = [...report.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1])
    .filter((row) => row.includes(`<strong>${tableLabel}</strong>`) && !row.includes("/100"));
  assert.equal(provenanceRows.length, 1, `expected one provenance row: ${tableLabel}`);
  const provenanceCells = [...provenanceRows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOnly(match[1]));
  assert.equal(provenanceCells.length, 4, `provenance column drift: ${tableLabel}`);
  if (score.components[0] > 0) {
    assert.ok(provenanceCells[1].includes(`→ ${score.components[0]}`), `provenance cost drift: ${tableLabel}`);
  } else {
    assert.match(provenanceCells[1], /成本(?:证据)?分 0/, `provenance zero-cost drift: ${tableLabel}`);
  }
  const provenanceEquation = provenanceCells[2].match(/([\d.]+)\+([\d.]+)\+([\d.]+)\+([\d.]+)=([\d.]+)/);
  assert.ok(provenanceEquation, `missing provenance component equation: ${tableLabel}`);
  assert.deepEqual(provenanceEquation.slice(1, 5).map(Number), score.components.slice(1), `provenance components drift: ${tableLabel}`);
  assert.equal(Number(provenanceEquation[5]), score.components.slice(1).reduce((sum, value) => sum + value, 0), `provenance component sum drift: ${tableLabel}`);
  assert.equal(Number(provenanceCells[3]), score.total, `provenance total drift: ${tableLabel}`);
}

const binanceEventChart = report.match(/<div class="score-row"><div class="score-head"><strong>⑤ Binance Event<\/strong><span class="score-total">([^<]+)<\/span><\/div><div class="score-track">([\s\S]*?)<\/div><\/div>/);
assert.ok(binanceEventChart, "missing chart row: Binance Event");
assert.equal(binanceEventChart[1], "56/80 → 70", "Binance Event chart total drift");
const binanceEventSegments = [...binanceEventChart[2].matchAll(/class="score-seg[^\"]*" style="width:([\d.]+)%"(?: title="[^"]+")?>([^<]+)<\/span>/g)];
assert.deepEqual(binanceEventSegments.map((match) => Number(match[1])), [0, 0, 25, 25, 20], "Binance Event normalized chart widths drift");
assert.deepEqual(binanceEventSegments.map((match) => match[2]), ["N/A", "0", "25*", "25*", "20*"], "Binance Event chart labels drift");

const binanceEventScoreRows = [...report.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map((match) => match[1])
  .filter((row) => row.includes("<strong>⑤ Binance Event</strong>") && row.includes("56/80 × 100 = 70"));
assert.equal(binanceEventScoreRows.length, 1, "expected one Binance Event score-table row");
const binanceEventScoreCells = [...binanceEventScoreRows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOnly(match[1]));
assert.match(binanceEventScoreCells[1], /^N\/A/, "Binance Event cost must be N/A");
assert.deepEqual(binanceEventScoreCells.slice(2, 6).map((cell) => Number(cell.match(/([\d.]+)\/20/)?.[1])), [0, 20, 20, 16]);
assert.equal(binanceEventScoreCells[6], "56/80 × 100 = 70");

const binanceEventProvenanceRows = [...report.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
  .map((match) => match[1])
  .filter((row) => row.includes("<strong>⑤ Binance Event</strong>") && row.includes("0+20+20+16=56/80"));
assert.equal(binanceEventProvenanceRows.length, 1, "expected one Binance Event provenance row");
const binanceEventProvenanceCells = [...binanceEventProvenanceRows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => textOnly(match[1]));
assert.match(binanceEventProvenanceCells[1], /即时往返成本为 N\/A/);
assert.equal(Number(binanceEventProvenanceCells[3]), totals.binanceEvent);

const polymarketNonCost = totals.polymarket - derivedAggregates.polymarket.cost_score_20;
const polymarketTieLoss = (20 - (totals.kalshi - polymarketNonCost)) / 2;
assert.equal(rounded(polymarketTieLoss), 2.55);
const costWeightAtTie = 8 / 0.305;
const shortHorizonWeightAtTie = 40 - costWeightAtTie;
assert.equal(rounded(costWeightAtTie, 6), 26.229508);
assert.equal(rounded(shortHorizonWeightAtTie, 6), 13.770492);
assert.doesNotMatch(report, /平台本身没有“更高胜率”/, "ranking lead must not repeat methodology commentary");
assert.doesNotMatch(report, /A platform does not have a “higher win rate”/, "English ranking lead must not repeat methodology commentary");

const earlyExitExample = (0.72 - 0.40) * 100;
const earlyExitLossExample = (0.30 - 0.40) * 100;
const holdWinExample = (1 - 0.40) * 100;
assert.equal(rounded(earlyExitExample, 2), 32, "early-exit profit example drift");
assert.equal(rounded(earlyExitLossExample, 2), -10, "early-exit loss example drift");
assert.equal(rounded(holdWinExample, 2), 60, "hold-to-expiry profit example drift");

const improvementProducts = ["polymarket", "kalshi", "predict", "okx", "binance-event"];
for (const product of improvementProducts) {
  const row = report.match(new RegExp(`<tr data-improvement-product="${product}">([\\s\\S]*?)<\\/tr>`));
  assert.ok(row, `missing improvement row: ${product}`);
  const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
  assert.equal(cells.length, 2, `improvement row must stay concise: ${product}`);
  const itemCount = (cells[1][1].match(/<li>/g) || []).length;
  assert.ok(itemCount >= 1 && itemCount <= 3, `improvement row must list one to three problems: ${product}`);
  assert.equal((cells[1][1].match(/<strong>问题：<\/strong>/g) || []).length, itemCount, `Chinese problem count drift: ${product}`);
  assert.equal((cells[1][1].match(/<strong>解决：<\/strong>/g) || []).length, itemCount, `Chinese fix count drift: ${product}`);
  assert.equal((cells[1][1].match(/<strong>Problem:<\/strong>/g) || []).length, itemCount, `English problem count drift: ${product}`);
  assert.equal((cells[1][1].match(/<strong>fix:<\/strong>/g) || []).length, itemCount, `English fix count drift: ${product}`);
}

for (const required of [
  "<title>给 Binary Option 玩家的事件合约排名：Polymarket 综合第一；Kalshi 买入再卖出损耗最低</title>",
  "给 Binary Option 玩家的事件合约排名：Polymarket 综合第一；Kalshi 买入再卖出损耗最低",
  "Event-contract ranking for binary-options traders: Polymarket ranks first overall; Kalshi has the lowest buy-then-sell loss",
  "综合排名：① Polymarket（96.8），② Kalshi（94.9），③ Binance Wallet / Predict.fun（88.7），④ OKX（80），⑤ Binance Event（70）。这不是胜率排名；如果只看买入后立即卖出的损耗，Kalshi 最低。",
  "Overall ranking: ① Polymarket (96.8), ② Kalshi (94.9), ③ Binance Wallet / Predict.fun (88.7), ④ OKX (80), ⑤ Binance Event (70). This is not a win-probability ranking; Kalshi has the lowest loss when considering only an immediate sale after entry.",
  "五款产品的分水岭是退出方式",
  "The dividing line is how a position can be exited",
  "如果你说的 Binary Option 是“猜涨跌，到期只有猜对或猜错”",
  "if “binary option” means predicting direction and ending with only a correct or wrong result",
  "订单簿产品比固定赔付 Binary Option 多了“交易价格变化”这条盈利路径",
  "Order-book products add a price-movement profit path that a fixed-payout binary option lacks",
  "两类产品都不是“猜对超过 50% 就赚钱”",
  "Neither product pays simply because accuracy exceeds 50%",
  "Kalshi 本次最少消耗你的优势",
  "Kalshi consumed the least of your edge in this sample",
  "07:39:39",
  "07:40:32",
  "07:41:20",
  "event-contract-orderbooks-2026-08-30.json",
  "普通玩家不适合参与任何一款",
  "ordinary players are not suited to any of these products",
  "三次采集集中在 82 秒内",
  "not three independent market samples",
  "Polymarket 只领先 Kalshi 1.9 分",
  "Polymarket leads Kalshi by only 1.9 points",
  "2.5500 pp",
  "cost 26.229508 and short horizon 13.770492",
  "订单簿产品有两种盈利路径；Binance Event 只有第二种",
  "Order-book products have two profit paths; Binance Event has only the second",
  "净盈亏=C×(P卖−P买)−买卖两次费用",
  "net P&amp;L=C×(Psell−Pbuy)−fees on both trades",
  "100 份从 0.40 涨到 0.72，未计费盈利 32",
  "selling after a fall to 0.30 loses 10",
  "只有 Binance Event 没有路径 1",
  "only Binance Event lacks Path 1",
  "“Event Contract”是大类名称",
  "“Event contract” is an umbrella label",
  "最像固定赔付 Binary Option",
  "Closest to a fixed-payout binary option",
  "买进再卖出有多贵",
  "Cost to buy and sell",
  "规则和结算记录能否核对",
  "Can rules and settlement records be checked?",
  "https://www.cftc.gov/LearnAndProtect/AdvisoriesAndArticles/fraudadv_binaryoptions.html",
  "https://website-prod.nadex.com/learning/how-to-trade-event-contracts/",
  "没有使用厂商付费材料",
  "uses no vendor-paid material",
  "技术校验完整性为高",
  "Technical validation integrity is high",
  "这个“高”只描述数据链与算术完整性",
  "High” describes data-chain and arithmetic integrity only",
  "Gamma 市场元数据 + 两个 CLOB token 盘口",
  "KXBTC15M-26AUG300345-45",
  "Predict.fun GraphQL 市场",
  "1800299",
  "BTC-UPDOWN-15MIN-260830-1530-1545",
  "94.902606、94.810581、94.779744 USDT",
  "94.902606, 94.810581, and 94.779744 USDT",
  "Down 侧三次分别只有 80.5、80、80 份可买",
  "only 80.5, 80, and 80 shares were available",
  "Up 买入后也分别只有 80.5、80、80 份可立即卖回",
  "could immediately sell back only 80.5, 80, and 80 shares",
  "本质是该市场该窗口流动性不足，不是产品形态不同",
  "a liquidity shortfall in that market and window, not a different product shape",
  "这里只保留由本次盘口或明确规则证明",
  "this section keeps only issues demonstrated by the sampled books or explicit rules",
  "最严重问题 → 对应解决方案",
  "Most serious problem → matching fix",
  "100 份买入并持有到期：买方最低保本胜率（不是预测胜率）",
  "Buy 100 and hold: buyer's minimum break-even win rate (not a predicted probability)",
  "Polymarket 示例：份价 <code>P=0.50</code>，买 100 份",
  "Polymarket example: 100 shares at <code>P=0.50</code>",
  "Kalshi 示例：份价 <code>P=0.50</code>，买 100 份",
  "Kalshi example: 100 contracts at <code>P=0.50</code>",
  "OKX、Polymarket、Kalshi 与 Wallet / Predict.fun",
  "OKX, Polymarket, Kalshi, and Wallet / Predict.fun",
  "产品机制把 50% 保本门槛推高多少",
  "How far product mechanics lift the 50% break-even threshold",
  "Binance Event 算法：",
  "Binance Event calculation:",
  "1÷(1+0.80)=55.56%",
  "本次 <code>r=0.80</code>，确认后锁定",
  "This comparison uses <code>r=0.80</code>, locked at confirmation",
  "BTCUSDT 10 分钟产品 Higher 与 Lower 均为 80%",
  "BTCUSDT ten-minute product, with both order panels again showing Payout 80%",
  "evidence/binance-event-btcusdt-10m-payout-2026-09-01.jpg",
  "evidence/binance-event-btcusdt-10m-payout-2026-09-01.json",
  "Event Contracts Terms (accepted Potential Payout Amount is fixed for that contract)",
  "前四款都是可提前卖出的订单簿二元份额",
  "the first four are order-book binary shares that permit early sale",
  "相差最多 <strong>0.75 个百分点</strong>",
  "a maximum gap of only <strong>0.75 points</strong>",
  "买卖价差、盘口深度和能否完整退出",
  "spread, book depth, and ability to complete an exit",
  "15.4199% / 5.3325% / 3.2037%",
  "88.7392% / 96.2688% / 98.1372%",
  "9.9074% / 3.7365% / 1.6035%",
  "91.3848% / 96.8300% / 98.6967%",
  "19.6723% / 12.3730% / 10.4269%",
  "85.3925% / 93.6181% / 95.2351%",
  "94.902606% / 94.810581% / 94.779744%",
  "三次 Up 的真实门槛均超过 94.77%",
  "All three real Up thresholds exceed 94.77%",
  "普通玩家极易亏损，不应下这笔 100 份立即买单",
  "an ordinary player is highly likely to lose and should not place this immediate 100-share buy",
  "前十档合计仅 1 份",
  "first ten ask levels totaled only 1 share",
  "40 份在 0.90",
  "40 shares at 0.90",
  "59 份在 0.99",
  "59 shares at 0.99",
  "100 份立即买满的流动性压力结果",
  "liquidity-stress result of filling 100 shares immediately",
  "越高越难保本，不代表平台预测越容易赢",
  "higher means harder to break even, not that the platform predicts an easier win",
  "期望损失约 44.90 USDT",
  "expected loss after entry cost is about 44.90 USDT",
  "Pr(猜中)+0.5×Pr(平局)",
  "Pr(win)+0.5×Pr(tie)",
  "1/1.8=55.56%",
  "q*=(1−t)/1.8",
  "按非平局条件计算",
  "Conditional on a non-tie",
  "无条件保本门槛为",
  "unconditional break-even threshold is",
  "Price Index 行情流用于核对开盘与结算价格",
  "Index Price feed checks opening and settlement values",
]) assert.ok(report.includes(required), `report is missing: ${required}`);

for (const forbidden of [
  "UpDown Protocol",
  "20/20（最有利假设）",
  "20/20 (best-case assumption)",
  "Binance Wallet / Predict.fun（91）",
  "Binance Wallet / Predict.fun (91)",
  "综合排名的证据置信度为中低",
  "Confidence in the overall rank is medium-low",
  "至少 2,160 轮跨平台采集",
  "at least 2,160 cross-platform collection rounds",
  "连续 30 天",
  "30 consecutive days",
  "短周期涨跌类事件合约：2026-08-30 时点综合评分与真实交易成本",
  "Short-horizon up/down event contracts: August 30, 2026 snapshot scores and executable cost",
  "综合排名与成本排名不能互相冒充",
  "The overall and cost rankings must not be presented as each other",
  "发布方是否另有商业关系不属于公开资料可验证范围",
  "Any separate commercial relationship held by the publisher",
  "事件合约（短周期价格预测）综合排名：Polymarket 第一，Kalshi 实盘成本最低",
  "Event contracts (short-horizon price prediction): Polymarket ranks first overall; Kalshi has the lowest observed cost",
  "可成交观测中位数 / 严格口径",
  "Fillable median / strict convention",
  "<strong>52.0795%</strong>",
  "<strong>50.6461%</strong>",
  "<strong>52.5324%</strong>",
  "仅为三次可成交 Up 买入的中位数",
  "Median of the three fillable Up entries only",
  "Binance Event · 41",
  "它的成本分仍为 0",
  "Cost still scores zero",
  "0/20（不能提前卖出）",
  "0/20 (no early sale)",
  "本文把份额价格、提前平仓、到期赔付和保本胜率翻译成",
  "The guide translates share prices, early exits, expiry payouts, and break-even rates",
  "五款产品对玩家最直接的优缺点",
  "The most practical strengths and drawbacks for a trader",
  "本次直接答案",
  "Direct answer for this sample",
  "Binance Event 不画在同一轴上",
  "Binance Event is not plotted on this axis",
  "做到什么才加分",
  "Evidence required for points",
  "这些情景分不参与当前排名",
  "These scenario scores do not enter the current ranking",
  "玩家熟悉的问法",
  "Trader's question",
  "最像哪一种",
  "Closest analogue",
  "评审披露",
  "Review disclosure:",
  "reviewer-quota-auto-auth-2026-07-24",
  "普通用户无法用完整历史原始数据重放结算",
  "Ordinary users cannot replay settlement from complete historical raw data",
  "授权方应急关盘结果无法由普通用户独立证明",
  "Ordinary users cannot independently prove an authorized emergency close",
  "确认后不能提前退出；<strong>解决：</strong>增加可提前卖出",
  "A confirmed position cannot exit early; <strong>fix:</strong> add publicly quoted early sale",
  "每笔赔付比、指数和申诉结果缺少永久凭证",
  "Each trade lacks a permanent receipt",
  "推出可公开验证的 5 分钟或更短合约",
  "launch a publicly verifiable contract of five minutes or less",
  "0.92 / 0.89",
  "Higher 92%",
]) assert.ok(!report.includes(forbidden), `out-of-scope or stale content remains: ${forbidden}`);

assert.equal((report.match(/https:\/\/updown\.bluffking\.ai\//g) || []).length, 4, "the bilingual testnet callout must carry exactly one visible link per language");
for (const required of [
  "无真钱测试网体验",
  "No-real-money testnet experience",
  "测试币没有价值",
  "test tokens have no value",
  "由本报告发布方运营",
  "operated by this report's publisher",
  "不参与评分、成本比较或排名",
  "does not enter scoring, cost comparison, or ranking",
]) assert.ok(report.includes(required), `testnet disclosure is missing: ${required}`);
assert.doesNotMatch(report, /data-score-product="[^"]*updown/i, "UpDown must not appear in score rows");

assert.ok(report.indexOf("独立性披露") > report.indexOf('<h2><span class="zh">六、来源</span>'), "independence disclosure must stay with sources");
assert.ok(report.indexOf("Independence disclosure") > report.indexOf('<h2><span class="zh">六、来源</span>'), "English independence disclosure must stay with sources");

const zhCount = (report.match(/class="zh"/g) || []).length;
const enCount = (report.match(/class="en"/g) || []).length;
assert.equal(zhCount, enCount, "Chinese and English spans must remain paired");
assert.ok(report.includes("localStorage.setItem('updown-doc-lang', lang)"));

console.log(JSON.stringify({
  status: "pass",
  source_response_captures: rawSnapshots.length,
  observations_per_orderbook_product: 6,
  aggregate: derivedAggregates,
  ranking: totals,
  rendered_score_rows_verified: renderedScores.length + 1,
  ranking_provenance_rows_verified: renderedScores.length + 1,
  entry_break_even_checks: entryBreakEvenChecks,
  okx_entry_checks: okxEntryChecks,
  binance_event_break_even_pct: {
    convention: "compared_contract_r_0_80_non_tie_conditional",
    r_0_80: 55.56,
    r_0_80_tie_1pct_unconditional: 55,
  },
  break_even_chart: breakEvenChart,
  sensitivity: {
    polymarket_tie_loss_pp: rounded(polymarketTieLoss),
    cost_weight_at_tie: rounded(costWeightAtTie, 6),
    short_horizon_weight_at_tie: rounded(shortHorizonWeightAtTie, 6),
  },
  bilingual_spans: { zh: zhCount, en: enCount },
}));
