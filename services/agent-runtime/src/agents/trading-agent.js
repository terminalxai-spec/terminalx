function normalizeSymbol(symbol) {
  return String(symbol || "BTC").trim().toUpperCase();
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertAnalysisOnly(action) {
  const blockedActions = new Set(["execute", "buy", "sell", "place_order", "live_trade"]);
  if (blockedActions.has(String(action || "").toLowerCase())) {
    throw new Error("Trading Agent is analysis-only. Broker execution is not connected.");
  }
}

function analyzeMarketData(payload = {}) {
  const symbol = normalizeSymbol(payload.symbol);
  const price = asNumber(payload.price, 0);
  const previousClose = asNumber(payload.previous_close, price);
  const volume = asNumber(payload.volume, null);
  const change = previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
  const bias = change > 1 ? "bullish" : change < -1 ? "bearish" : "neutral";

  return {
    agent: "trading-agent",
    mode: "analysis_only",
    action: "analyze_market_data",
    symbol,
    analysis: {
      price,
      previous_close: previousClose,
      percent_change: Number(change.toFixed(2)),
      volume,
      bias,
      notes: [
        `${symbol} is currently classified as ${bias} based on the supplied price data.`,
        "This is not financial advice and does not execute a trade.",
        "Add live market data integration later before using this for real decisions."
      ]
    }
  };
}

function createWatchlist(payload = {}) {
  const symbols = (payload.symbols || ["BTC", "ETH", "SPY", "QQQ"]).map(normalizeSymbol);
  const watchlist = symbols.map((symbol) => ({
    symbol,
    reason: payload.reason || "Track for trend, volatility, and risk/reward setup.",
    alerts: ["price near support/resistance", "volume expansion", "news or macro catalyst"]
  }));

  return {
    agent: "trading-agent",
    mode: "analysis_only",
    action: "create_watchlist",
    watchlist
  };
}

function calculateRisk(payload = {}) {
  const entry = asNumber(payload.entry);
  const stopLoss = asNumber(payload.stop_loss);
  const accountSize = asNumber(payload.account_size, 10000);
  const riskLimitPercent = asNumber(payload.risk_limit_percent);

  if (!entry || !stopLoss || !riskLimitPercent) {
    throw new Error("entry, stop_loss, and risk_limit_percent are required for risk calculation.");
  }

  const riskPerUnit = Math.abs(entry - stopLoss);
  const maxRiskAmount = accountSize * (riskLimitPercent / 100);
  const maxPositionSize = riskPerUnit > 0 ? maxRiskAmount / riskPerUnit : 0;

  return {
    agent: "trading-agent",
    mode: "analysis_only",
    action: "calculate_risk",
    risk: {
      entry,
      stop_loss: stopLoss,
      account_size: accountSize,
      risk_limit_percent: riskLimitPercent,
      max_risk_amount: Number(maxRiskAmount.toFixed(2)),
      risk_per_unit: Number(riskPerUnit.toFixed(4)),
      max_position_size: Number(maxPositionSize.toFixed(4))
    }
  };
}

function createTradingIdea(payload = {}) {
  const symbol = normalizeSymbol(payload.symbol);
  const direction = String(payload.direction || "watch").toLowerCase();
  const entry = asNumber(payload.entry);
  const stopLoss = asNumber(payload.stop_loss);
  const riskLimitPercent = asNumber(payload.risk_limit_percent);

  if (!stopLoss || !riskLimitPercent) {
    throw new Error("Trading ideas require stop_loss and risk_limit_percent.");
  }

  const risk = entry
    ? calculateRisk({
        entry,
        stop_loss: stopLoss,
        account_size: payload.account_size,
        risk_limit_percent: riskLimitPercent
      }).risk
    : null;

  return {
    agent: "trading-agent",
    mode: "analysis_only",
    action: "create_trading_idea",
    idea: {
      symbol,
      direction,
      thesis: payload.thesis || `Watch ${symbol} for confirmation before considering any action.`,
      entry,
      stop_loss: stopLoss,
      risk_limit_percent: riskLimitPercent,
      invalidation: `Idea is invalid if ${symbol} violates the stop loss or thesis conditions.`,
      risk,
      execution_status: "not_executed",
      broker_connected: false
    }
  };
}

function createTradePlan(payload = {}) {
  const idea = createTradingIdea(payload).idea;
  return {
    agent: "trading-agent",
    mode: "analysis_only",
    action: "create_trade_plan",
    plan: {
      ...idea,
      checklist: [
        "Confirm setup with current market data.",
        "Check news and broader market context.",
        "Respect stop loss before sizing any position.",
        "Keep risk at or below the configured risk limit.",
        "Do not execute from TerminalX MVP. Broker execution is disabled."
      ]
    }
  };
}

function runTradingAction(payload = {}) {
  const action = String(payload.action || "analyze").trim().toLowerCase();
  assertAnalysisOnly(action);

  switch (action) {
    case "analyze":
    case "analyze_market_data":
      return analyzeMarketData(payload);
    case "watchlist":
    case "create_watchlist":
      return createWatchlist(payload);
    case "idea":
    case "trading_idea":
      return createTradingIdea(payload);
    case "risk":
    case "calculate_risk":
      return calculateRisk(payload);
    case "plan":
    case "trade_plan":
      return createTradePlan(payload);
    default:
      throw new Error(`Unsupported trading action: ${action}`);
  }
}

module.exports = {
  analyzeMarketData,
  calculateRisk,
  createTradePlan,
  createTradingIdea,
  createWatchlist,
  runTradingAction
};

