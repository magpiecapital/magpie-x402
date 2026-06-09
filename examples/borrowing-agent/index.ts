import {
  integerEnv,
  jsonPost,
  loadConfig,
  numberEnv,
  paidJson,
  printJson,
  pubkeyEnv,
  rawAmountEnv,
  getJson,
} from "../shared/magpie-client.js";

type BorrowQuote = { [key: string]: unknown };
type BuildBorrowResponse = { [key: string]: unknown };

const config = loadConfig();
const collateralMint = pubkeyEnv("MAGPIE_COLLATERAL_MINT", "So11111111111111111111111111111111111111112");
const collateralAmount = rawAmountEnv("MAGPIE_COLLATERAL_AMOUNT_RAW", "1000000000");
const decimals = integerEnv("MAGPIE_COLLATERAL_DECIMALS", 9);
const collateralPriceUsd = numberEnv("MAGPIE_COLLATERAL_PRICE_USD", 160);
const solPriceUsd = numberEnv("MAGPIE_SOL_PRICE_USD", 160);
const solPrice24hAgoUsd = numberEnv("MAGPIE_SOL_PRICE_24H_AGO_USD", 150);
const minMovePct = numberEnv("MAGPIE_MIN_SOL_MOVE_PCT", 5);

const movePct = ((solPriceUsd - solPrice24hAgoUsd) / solPrice24hAgoUsd) * 100;
console.log(`SOL move: ${movePct.toFixed(2)}%`);
if (movePct < minMovePct) {
  console.log(`No borrow action: threshold is ${minMovePct}%`);
  process.exit(0);
}

const quotePath =
  `/api/v1/simulate-borrow?mint=${collateralMint}` +
  `&amount=${collateralAmount}` +
  `&decimals=${decimals}` +
  `&pricePerTokenUsd=${collateralPriceUsd}` +
  `&solPriceUsd=${solPriceUsd}` +
  "&tier=all";
const quote = await getJson<BorrowQuote>(config, quotePath);
printJson("borrow quote", quote);

const body = {
  borrower_wallet: config.wallet,
  collateral_mint: collateralMint,
  collateral_amount: collateralAmount,
  tier: 1,
};

// x402 step 1: call the paid builder without X-Payment to receive the signed challenge.
// x402 step 2: send the exact Solana payment with the returned memo.
// x402 step 3: re-run with X402_PAYMENT_SIGNATURE so the helper retries with X-Payment.
const buildBorrow = await paidJson<BuildBorrowResponse>(
  config,
  "/api/v1/agent/build-borrow",
  jsonPost(body),
);
if (buildBorrow.kind === "challenge") {
  console.log("Borrow transaction build is ready after the x402 payment signature is supplied.");
} else {
  printJson("borrow build response", buildBorrow.data);
}
