(function () {
  "use strict";

  var FARM_VERSION = "farm 2.0";

  function gasCostTable() {
    return {
      Ethereum: 4.5, Arbitrum: 0.08, Base: 0.08, Optimism: 0.08, Solana: 0.01,
      BSC: 0.15, Binance: 0.15, Bitcoin: 3.2, Tron: 1.1, Hyperliquid: 0.05,
      "Hyperliquid L1": 0.05, _other: 0.25
    };
  }

  function gasUsd(chain) {
    var table = gasCostTable();
    return chain && table[chain] != null ? table[chain] : table._other;
  }

  function pickFarmChain(chains) {
    var list = chains && chains.length ? chains : ["Ethereum"];
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var cost = gasUsd(list[i]);
      if (!best || cost < best.cost || (cost === best.cost && list[i] < best.name)) {
        best = { name: list[i], cost: cost };
      }
    }
    return best;
  }

  function sizeTicket(tvlUsd) {
    var raw = (tvlUsd > 0 ? tvlUsd : 0) * 0.0002;
    if (raw < 1000) raw = 1000;
    if (raw > 25000) raw = 25000;
    return Math.round(raw / 100) * 100;
  }

  function holdDaysFor(runwayDays) {
    if (runwayDays == null || !Number.isFinite(runwayDays)) return 45;
    var days = 30 + Math.floor(runwayDays / 10);
    if (days > 120) return 120;
    return days < 30 ? 30 : days;
  }

  function cents(n) { return Math.round(n * 100) / 100; }

  function formatUsd(n) {
    var neg = n < 0;
    var scaled = Math.round(Math.abs(n) * 100);
    var whole = Math.floor(scaled / 100);
    var frac = scaled % 100;
    var body = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + "$" + body + (frac ? "." + (frac < 10 ? "0" : "") + frac : "");
  }

  function formatPct(n) {
    if (n == null || !Number.isFinite(n)) return "unreported";
    var r = Math.round(n * 10) / 10;
    return (r < 0 ? "-" : "") + Math.abs(r).toFixed(1) + "%";
  }

  function cashAsset(chain) {
    return chain === "Bitcoin" ? "BTC" : chain === "Tron" ? "USDT" : "USDC";
  }

  function fill(template, info) {
    return template.replace(/\{(\w+)\}/g, function (_, key) { return info[key]; });
  }

  function runwayDays(row, ctx) {
    if (row.runway_days != null) return row.runway_days;
    var api = globalThis.TokenRadar;
    if (api && api.daysOnRecord && ctx && ctx.asOf) return api.daysOnRecord(row.listed_at, ctx.asOf);
    return null;
  }

  function styleBook(group) {
    var book = {
      custody: ["Hold it only if you already need it", "{name} is custody (class factor 0.01): no launch of its own. Move at most {ticket} you already need onto {chain}. No fresh capital.", 1, 20, "Check the parent asset", "Each week, confirm {name} still redeems to the parent.", 0, 10, 0],
      lend: ["Supply {asset}", "Supply {ticket} {asset} to {name} on {chain}. Plain market only.", 1, 20, "Borrow under 35% LTV", "Borrow {borrow} (35% of {ticket}). Repay if health would fall under 1.6.", 1, 15, 0],
      cdp: ["Mint under 40%", "Deposit {ticket} into {name} on {chain} and mint about {forty} (40%). Stay above liquidation.", 2, 25, "Keep debt under 40%", "Each week, repay {name} if debt would pass 40% of collateral.", 0, 10, 0],
      dex: ["LP 50/50", "Add {ticket} as a 50/50 {asset} pool on {name} ({chain}).", 2, 25, "Swap 5% weekly", "For {weeks} weeks, swap {five} through {name}. Skip a week if price moved over 8%.", 1, 10, 1],
      vault: ["Deposit into the curated USDC vault", "Deposit {ticket} {asset} into the curated stable vault on {name} ({chain}).", 1, 20, "Leave it allocated", "Leave {ticket} in {name}. Each week, check the share price.", 0, 10, 0],
      rwa: ["Subscribe after KYC", "KYC with {name} first. After the issuer accepts the {chain} wallet, subscribe {ticket}.", 1, 45, "Keep the receipt", "Each week, confirm {ticket} at {name} and that redemptions are open.", 0, 10, 0],
      deriv: ["Post margin", "Post {ticket} margin on {name} ({chain}).", 1, 20, "Trade 1x notional weekly", "For {weeks} weeks, trade about {ticket} notional on {name} and flatten the same day. Margin use under 40%.", 1, 15, 1],
      basis: ["Long spot, short perp", "On {name} ({chain}), split {ticket} equally across a long spot leg and a short perp.", 2, 30, "Rebalance a 2% drift", "For {weeks} weeks, rebalance {name} if the legs differ by over 2% of {ticket}.", 1, 15, 1],
      flow: ["Open the position", "On {name} ({chain}), use {ticket} {asset}. {action}.", 1, 20, "Keep the action on schedule", "For {weeks} weeks, check {name} still does this: {action}.", 0, 10, 0]
    };
    return book[group] || book.flow;
  }

  function categoryPlaybook(category, launchClass) {
    if (launchClass === "custody") {
      return { group: "custody", action: "Hold via the product only if you already need the asset" };
    }
    var group = {
      Lending: "lend", "Collateral Markets": "lend", CDP: "cdp", "CDP Manager": "cdp",
      Dexs: "dex", Yield: "vault", "Yield Aggregator": "vault", "Risk Curators": "vault",
      "Onchain Capital Allocator": "vault", RWA: "rwa", Derivatives: "deriv",
      Options: "deriv", Synthetics: "deriv", "Basis Trading": "basis"
    }[category] || "flow";
    var byGroup = {
      lend: "Supply a stable and borrow under 35% LTV",
      cdp: "Mint at a safe ratio, debt at most 40% of collateral",
      dex: "LP the ticket and swap about 5% once a week",
      vault: "Deposit into the curated USDC vault",
      rwa: "Subscribe after KYC, not before the issuer accepts the wallet",
      deriv: "Post margin and trade about 1x notional weekly",
      basis: "Long spot, short perp, rebalance if the legs drift 2%"
    };
    if (byGroup[group]) return { group: group, action: byGroup[group] };
    return { group: "flow", action: "Deposit in the " + (category || "primary") + " market and confirm you can withdraw" };
  }

  function fromParts(parts, info, gas, tend) {
    var off = tend ? 4 : 0;
    var times = tend && parts[8] ? +info.weeks : 1;
    return {
      title: fill(parts[off], info),
      detail: fill(parts[off + 1], info),
      cost_usd: cents(gas * parts[off + 2] * times),
      minutes: parts[off + 3] * times
    };
  }

  function buildFarmPlan(row, ctx) {
    ctx = ctx || {};
    var picked = pickFarmChain(row.chains);
    var ticket = sizeTicket(row.tvl_usd);
    var days = runwayDays(row, ctx);
    var hold = holdDaysFor(days);
    var weeks = Math.max(1, Math.round(hold / 7));
    var book = categoryPlaybook(row.category, row.launch_class);
    var gas = picked.cost;
    var per1k = row.per1k_farmed != null ? row.per1k_farmed : row.per1kFarmed;
    var info = {
      name: row.name, chain: picked.name, asset: cashAsset(picked.name), action: book.action,
      ticket: formatUsd(ticket), weeks: String(weeks), hold: String(hold),
      tvl: formatUsd(row.tvl_usd || 0), gas: formatUsd(gas),
      float: formatUsd(Math.max(5, Math.ceil(gas * 20))),
      borrow: formatUsd(Math.round(ticket * 0.35 / 100) * 100),
      forty: formatUsd(Math.round(ticket * 0.4 / 100) * 100),
      five: formatUsd(Math.round(ticket * 0.05)),
      pct: formatPct(row.change_7d),
      floor: formatUsd(Math.round((row.tvl_usd || 0) * 0.75)),
      why: days == null ? "listed_at is unreported, so the hold is the neutral 45 days."
        : "Runway is " + days + " days to " + (ctx.asOf || "the snapshot date") + ", so the hold is " + hold + " days (30 + 1 per 10 runway days, cap 120).",
      illus: per1k == null ? "" : " Illustration: " + formatUsd(per1k) + " per $1,000 if 10% of implied FDV is shared pro rata.",
      live: row.change_7d == null ? " 7-day change is unreported, so the -15% test waits."
        : row.change_7d < -15 ? " Today's 7-day change is " + formatPct(row.change_7d) + ", already below -15%." : ""
    };
    var parts = styleBook(book.group);
    var steps = [];
    function push(kind, title, detail, cost, minutes, holdDays) {
      var step = { kind: kind, title: fill(title, info), detail: fill(detail, info), cost_usd: cents(cost), minutes: minutes };
      if (holdDays) step.hold_days = holdDays;
      steps.push(step);
    }
    if (book.group !== "custody") {
      push("fund", "Move {ticket} {asset} to {chain}", "Move {ticket} {asset} to {chain}, cheapest chain {name} lists, about {gas} a transaction. Keep {float} for gas. Ticket is 0.02% of {tvl}, $1,000 to $25,000, nearest $100.", gas, 20);
    }
    var enter = fromParts(parts, info, gas, false);
    enter.kind = "enter";
    steps.push(enter);
    var tend = fromParts(parts, info, gas, true);
    tend.kind = "tend";
    steps.push(tend);
    push("hold", "Hold {hold} days", "{why} At 5% APR the opportunity cost on {ticket} for {hold} days is this step's cost, not a fee to {name}.{illus}", ticket * 0.05 * hold / 365, 5, hold);
    push("check", "Weekly check-in on {name}", "For {weeks} weeks, about 12 minutes a week on {name}: write down TVL (today {tvl}), the 7-day change (today {pct}), and that the position is still {ticket}.", 0, 12 * weeks);
    push("exit", "Exit on the TVL or 7-day trigger", "Exit if TVL falls below {floor} (25% under today's {tvl}) or the 7-day change turns below -15%.{live} Unwind on {chain} back to {asset}.", gas * 2, 25);
    return steps;
  }

  function farmStepText(step) {
    return (step.title + ": " + step.detail + " - cost about " + formatUsd(step.cost_usd) + ", about " + step.minutes + " min").trim();
  }

  function planTotals(steps) {
    var cost = 0, minutes = 0, hold = 0;
    for (var i = 0; i < steps.length; i++) {
      cost += steps[i].cost_usd;
      minutes += steps[i].minutes;
      if (steps[i].hold_days) hold = steps[i].hold_days;
    }
    return { cost_usd: cents(cost), minutes: minutes, hold_days: hold };
  }

  globalThis.TokenRadar = Object.assign(globalThis.TokenRadar || {}, {
    FARM_VERSION: FARM_VERSION, gasCostTable: gasCostTable, pickFarmChain: pickFarmChain,
    sizeTicket: sizeTicket, categoryPlaybook: categoryPlaybook, holdDaysFor: holdDaysFor,
    buildFarmPlan: buildFarmPlan, farmStepText: farmStepText, planTotals: planTotals
  });
})();
