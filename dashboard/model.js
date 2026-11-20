/* Token Radar value model. Implied FDV from snapshot TVL, peer mcap/TVL, 7-day change and token-free runway. */
(function () {
  "use strict";

  var MODEL_VERSION = "model 2.0";
  // Custody carries no launch of its own. 0.01 keeps it outside the top 30; every pre-token row stays >= $1.
  var CLASS_DISCOUNT = 0.01;
  var PEER_PRIOR = 4;
  var MULTIPLE_MIN = 0.05;
  var MULTIPLE_MAX = 1.5;
  var DEPOSITOR_SHARE = 0.1;

  var CUSTODY_CATEGORIES = {
    "Bridge": 1,
    "Canonical Bridge": 1,
    "Liquid Staking": 1,
    "Liquid Restaking": 1,
    "Restaked BTC": 1,
    "CEX": 1
  };

  var VERSION_MARKER = /\s(?:v\d+(?:\.\d+)?|\d+\.\d+)$/i;
  var CUSTODY_WORD = /\b(wrapped|staked|staking)\b/i;
  var EXCHANGE_PREFIX = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

  function round6(x) {
    return Math.round(x * 1e6) / 1e6;
  }

  function cmpSlug(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function commas(n) {
    var sign = n < 0 ? "-" : "";
    var body = String(Math.round(Math.abs(n)));
    return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function classifyTokenStatus(p) {
    if (p.gecko_id == null && p.symbol == null) return "pre-token";
    if (p.mcap_usd > 0) return "token trades";
    return "token on record";
  }

  function custodyByFields(p) {
    if (CUSTODY_CATEGORIES[p.category]) return true;
    var name = p.name || "";
    if (VERSION_MARKER.test(name)) return true;
    if (CUSTODY_WORD.test(name)) return true;
    if (EXCHANGE_PREFIX.test(name)) return true;
    return false;
  }

  function onWatchlist(p, snapshot) {
    var list = snapshot && snapshot.watchlist;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === p.slug) return true;
    }
    return false;
  }

  function classifyLaunchClass(p, snapshot) {
    if (onWatchlist(p, snapshot)) return "watchlist";
    if (classifyTokenStatus(p) !== "pre-token") return "n/a";
    if (custodyByFields(p)) return "custody";
    return "early";
  }

  function median(sorted) {
    var n = sorted.length;
    var mid = Math.floor(n / 2);
    if (n % 2) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function clampMultiple(x) {
    if (!(x > 0)) return MULTIPLE_MIN;
    if (x < MULTIPLE_MIN) x = MULTIPLE_MIN;
    if (x > MULTIPLE_MAX) x = MULTIPLE_MAX;
    return round6(x);
  }

  function calibratePeerMultiples(protocols) {
    var logsByCat = Object.create(null);
    var all = [];
    for (var i = 0; i < protocols.length; i++) {
      var p = protocols[i];
      if (!(p.mcap_usd > 0) || !(p.tvl_usd > 0)) continue;
      var logRatio = Math.log(p.mcap_usd / p.tvl_usd);
      if (!Number.isFinite(logRatio)) continue;
      all.push(logRatio);
      var cat = p.category || "(unspecified)";
      if (!logsByCat[cat]) logsByCat[cat] = [];
      logsByCat[cat].push(logRatio);
    }
    all.sort(function (a, b) { return a - b; });
    var globalLog = all.length ? median(all) : 0;
    var byCategory = Object.create(null);
    var cats = Object.keys(logsByCat).sort(cmpSlug);
    for (var c = 0; c < cats.length; c++) {
      var catName = cats[c];
      var arr = logsByCat[catName].slice().sort(function (a, b) { return a - b; });
      var n = arr.length;
      var logMedian = median(arr);
      var w = n / (n + PEER_PRIOR);
      var shrunk = w * logMedian + (1 - w) * globalLog;
      byCategory[catName] = {
        n: n,
        log_median: round6(logMedian),
        multiple: clampMultiple(Math.exp(shrunk))
      };
    }
    return {
      peerCount: all.length,
      prior: PEER_PRIOR,
      multipleMin: MULTIPLE_MIN,
      multipleMax: MULTIPLE_MAX,
      globalLogMedian: round6(globalLog),
      globalMultiple: clampMultiple(Math.exp(globalLog)),
      byCategory: byCategory
    };
  }

  function multipleFor(peers, category) {
    var cat = category || "(unspecified)";
    var row = peers.byCategory[cat];
    if (!row) return { n: 0, multiple: peers.globalMultiple, log_median: peers.globalLogMedian };
    return row;
  }

  function growthFactor(change7d) {
    if (change7d == null || !Number.isFinite(change7d)) {
      return { factor: 1, note: "7d unreported" };
    }
    var c = change7d / 25;
    var factor = 1 + 0.2 * (c / (1 + Math.abs(c)));
    if (factor < 0.8) factor = 0.8;
    if (factor > 1.2) factor = 1.2;
    return { factor: round6(factor), note: "" };
  }

  function parseUtcDay(iso) {
    if (!iso || typeof iso !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function daysOnRecord(listedAt, asOf) {
    var listed = parseUtcDay(listedAt);
    var asof = parseUtcDay(asOf);
    if (listed == null || asof == null) return null;
    var days = Math.round((asof - listed) / 86400000);
    return days < 0 ? 0 : days;
  }

  function runwayFactor(ageDays) {
    if (ageDays == null || !Number.isFinite(ageDays)) {
      return { factor: 1, note: "listed_at unreported" };
    }
    var days = ageDays < 0 ? 0 : ageDays;
    var factor = 0.92 + 0.36 * (days / (days + 540));
    return { factor: round6(factor), note: "" };
  }

  function classFactor(launchClass) {
    if (launchClass === "custody") return CLASS_DISCOUNT;
    return 1;
  }

  function impliedValue(p, ctx) {
    var launchClass = ctx.launchClass || classifyLaunchClass(p, ctx.snapshot);
    var peer = multipleFor(ctx.peers, p.category);
    var growth = growthFactor(p.change_7d);
    var days = daysOnRecord(p.listed_at, ctx.asOf);
    var runway = runwayFactor(days);
    var klass = classFactor(launchClass);
    var tvl = p.tvl_usd > 0 ? p.tvl_usd : 0;
    var implied = Math.max(1, Math.round(tvl * peer.multiple * growth.factor * runway.factor * klass));
    var per1k = tvl > 0 ? Math.round((DEPOSITOR_SHARE * implied / tvl) * 1000 * 100) / 100 : 0;
    var notes = [];
    if (growth.note) notes.push(growth.note);
    if (runway.note) notes.push(runway.note);
    if (launchClass === "custody") notes.push("custody discount " + CLASS_DISCOUNT);
    var factors = {
      tvl_usd: tvl,
      peer_multiple: peer.multiple,
      peer_n: peer.n,
      growth_factor: growth.factor,
      growth_note: growth.note,
      runway_factor: runway.factor,
      runway_note: runway.note,
      runway_days: days,
      class_factor: klass,
      launch_class: launchClass,
      per1kFarmed: per1k
    };
    return {
      implied_value_usd: implied,
      per1kFarmed: per1k,
      launch_class: launchClass,
      factors: factors,
      notes: notes
    };
  }

  function copyChains(p) {
    return p.chains && p.chains.length ? p.chains.slice() : [];
  }

  function tokenTradesTable(snapshot) {
    var rows = [];
    var protocols = snapshot.protocols;
    for (var i = 0; i < protocols.length; i++) {
      var p = protocols[i];
      if (!(p.mcap_usd > 0)) continue;
      rows.push({
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: copyChains(p),
        tvl_usd: p.tvl_usd,
        mcap_usd: p.mcap_usd,
        mcap_per_tvl: p.tvl_usd > 0 ? round6(p.mcap_usd / p.tvl_usd) : null,
        change_7d: p.change_7d,
        symbol: p.symbol,
        token_status: "token trades"
      });
    }
    rows.sort(function (a, b) {
      return b.mcap_usd - a.mcap_usd || cmpSlug(a.slug, b.slug);
    });
    return rows;
  }

  function modelSummary(ctx) {
    var peers = ctx.peers;
    var lines = [
      "Model " + MODEL_VERSION + " as of " + ctx.asOf + ". Implied value is this board's claim, in whole dollars, not a market price.",
      "Formula: implied FDV = TVL x peer multiple x growth factor x runway factor x class factor, rounded to a whole dollar and at least $1.",
      "Peer multiple is what the market pays per $1 of TVL. From " + peers.peerCount + " protocols whose token trades (mcap and TVL both above zero), each category takes the median of log(mcap/TVL), shrunk toward the all-peer median with weight n/(n+" + PEER_PRIOR + "). All-peer median multiple: " + peers.globalMultiple + ". No trading peer in a category uses that median. Clamped to " + MULTIPLE_MIN + " .. " + MULTIPLE_MAX + ".",
      "Growth factor = 1 + 0.20 x c/(1+|c|), c = 7-day TVL change in percent / 25, inside 0.80..1.20. A null change_7d is 1.00, flagged \"7d unreported\".",
      "Runway factor = 0.92 + 0.36 x days/(days+540). Days are the UTC span from listed_at to " + ctx.asOf + ". Longer token-free runway raises it from 0.92 toward 1.28. A null listed_at is 1.00, flagged \"listed_at unreported\".",
      "Class factor is 1.00 for watchlist and early (pre-token, including under the $" + commas(ctx.floorUsd) + " floor). Custody is " + CLASS_DISCOUNT + ", from snapshot fields only: category Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX; a name ending in a version marker (V2, v3, 2.0); a whole word wrapped, staked or staking; or a name starting with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini. They carry no launch of their own.",
      "That " + CLASS_DISCOUNT + " discount is one percent of an otherwise identical launch candidate. On this snapshot the best custody row is rank " + ctx.bestCustodyRank + ", outside the top 30, and every pre-token row stays on the board.",
      "Pre-token means gecko_id and symbol are both null: the protocol records no token. Token trades means mcap_usd > 0 and stays off this board. Anything else is token on record.",
      "per1kFarmed illustrates the model, not a promised airdrop: dollars per $1,000 deposited if 10% of implied FDV went to depositors pro rata to TVL.",
      "Rank is implied FDV descending, then slug ascending. This run: " + ctx.rankedCount + " pre-token (" + ctx.watchCount + " watchlist, " + ctx.earlyCount + " early, " + ctx.custodyCount + " custody), " + ctx.tradeCount + " whose token trades, " + ctx.onRecordCount + " token on record."
    ];
    return {
      version: MODEL_VERSION,
      lines: lines,
      constants: {
        class_discount: CLASS_DISCOUNT,
        depositor_share: DEPOSITOR_SHARE,
        peer_prior: PEER_PRIOR,
        multiple_min: MULTIPLE_MIN,
        multiple_max: MULTIPLE_MAX,
        global_multiple: peers.globalMultiple,
        peer_count: peers.peerCount,
        category_count: Object.keys(peers.byCategory).length,
        growth_bounds: [0.8, 1.2],
        runway_bounds: [0.92, 1.28],
        best_custody_rank: ctx.bestCustodyRank,
        ranked_count: ctx.rankedCount,
        watch_count: ctx.watchCount,
        early_count: ctx.earlyCount,
        custody_count: ctx.custodyCount,
        trade_count: ctx.tradeCount,
        on_record_count: ctx.onRecordCount
      }
    };
  }

  function rankBoard(snapshot) {
    var peers = calibratePeerMultiples(snapshot.protocols);
    var asOf = snapshot.as_of;
    var protocols = snapshot.protocols;
    var rows = [];
    var watchCount = 0;
    var earlyCount = 0;
    var custodyCount = 0;
    for (var i = 0; i < protocols.length; i++) {
      var p = protocols[i];
      var status = classifyTokenStatus(p);
      var watched = onWatchlist(p, snapshot);
      if (status !== "pre-token" && !watched) continue;
      var launchClass = classifyLaunchClass(p, snapshot);
      var value = impliedValue(p, { asOf: asOf, peers: peers, launchClass: launchClass });
      if (launchClass === "watchlist") watchCount += 1;
      else if (launchClass === "custody") custodyCount += 1;
      else earlyCount += 1;
      rows.push({
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: copyChains(p),
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        listed_at: p.listed_at,
        token_status: status,
        launch_class: value.launch_class,
        below_floor: p.tvl_usd < snapshot.floor_usd,
        runway_days: value.factors.runway_days,
        implied_value_usd: value.implied_value_usd,
        per1k_farmed: value.per1kFarmed,
        factors: value.factors,
        notes: value.notes
      });
    }
    rows.sort(function (a, b) {
      return b.implied_value_usd - a.implied_value_usd || cmpSlug(a.slug, b.slug);
    });
    var bestCustodyRank = null;
    for (var r = 0; r < rows.length; r++) {
      rows[r].rank = r + 1;
      if (bestCustodyRank == null && rows[r].launch_class === "custody") bestCustodyRank = r + 1;
    }
    var rankedSlugs = Object.create(null);
    for (var s = 0; s < rows.length; s++) rankedSlugs[rows[s].slug] = 1;
    var missingWatch = [];
    var watch = snapshot.watchlist || [];
    for (var w = 0; w < watch.length; w++) {
      if (!rankedSlugs[watch[w]]) missingWatch.push(watch[w]);
    }
    var trades = tokenTradesTable(snapshot);
    var onRecordCount = protocols.length - rows.length - trades.length;
    var ctx = {
      asOf: asOf,
      floorUsd: snapshot.floor_usd,
      peers: peers,
      rankedCount: rows.length,
      watchCount: watchCount,
      earlyCount: earlyCount,
      custodyCount: custodyCount,
      tradeCount: trades.length,
      onRecordCount: onRecordCount,
      bestCustodyRank: bestCustodyRank
    };
    return {
      as_of: asOf,
      floor_usd: snapshot.floor_usd,
      rows: rows,
      trades: trades,
      missing_watchlist: missingWatch,
      summary: modelSummary(ctx),
      ctx: ctx
    };
  }

  globalThis.TokenRadar = Object.assign(globalThis.TokenRadar || {}, {
    MODEL_VERSION: MODEL_VERSION,
    CLASS_DISCOUNT: CLASS_DISCOUNT,
    classifyTokenStatus: classifyTokenStatus,
    classifyLaunchClass: classifyLaunchClass,
    custodyByFields: custodyByFields,
    calibratePeerMultiples: calibratePeerMultiples,
    growthFactor: growthFactor,
    runwayFactor: runwayFactor,
    classFactor: classFactor,
    daysOnRecord: daysOnRecord,
    impliedValue: impliedValue,
    rankBoard: rankBoard,
    tokenTradesTable: tokenTradesTable,
    modelSummary: modelSummary
  });
})();
