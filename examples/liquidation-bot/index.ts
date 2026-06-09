import { getJson, integerEnv, loadConfig, printJson } from "../shared/magpie-client.js";

type LiquidatableLoan = {
  loanPda: string;
  loanId: string;
  borrower: string;
  secondsPastDue: number;
  loanAmountLamports: string;
};

type LiquidatableResponse = {
  total_active_loans?: number;
  eligible_count?: number;
  returned_count?: number;
  loans?: LiquidatableLoan[];
  [key: string]: unknown;
};

const config = loadConfig();
const withinSeconds = integerEnv("MAGPIE_LIQUIDATION_WITHIN_SECONDS", 300);
const limit = integerEnv("MAGPIE_LIQUIDATION_LIMIT", 5);
const loops = integerEnv("MAGPIE_LIQUIDATION_LOOPS", 1);

async function pollOnce(loopNumber: number) {
  const path = `/api/v1/markets/liquidatable?within_seconds=${withinSeconds}&limit=${limit}`;
  const response = await getJson<LiquidatableResponse>(config, path);
  console.log(`poll ${loopNumber}: active=${response.total_active_loans ?? 0}, eligible=${response.eligible_count ?? 0}`);
  const loans = response.loans ?? [];
  if (loans.length === 0) {
    console.log("No liquidation candidates in this window.");
    return;
  }
  printJson("top liquidation candidates", loans.slice(0, limit));
  console.log("Production bot next step: build and submit the protocol liquidate instruction for the chosen loan PDA.");
}

for (let i = 1; i <= loops; i += 1) {
  await pollOnce(i);
  if (i < loops) await new Promise((resolve) => setTimeout(resolve, 5_000));
}
