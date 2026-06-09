import { getJson, loadConfig, printJson } from "../shared/magpie-client.js";

type CollateralCatalog = {
  count?: number;
  categories?: Record<string, number>;
  [key: string]: unknown;
};

type WalletLoans = {
  wallet?: string;
  count?: number;
  loans?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

const config = loadConfig();

const collateral = await getJson<CollateralCatalog>(config, "/api/v1/collateral/eligible");
printJson("eligible collateral summary", {
  count: collateral.count ?? 0,
  categories: collateral.categories ?? {},
});

const walletLoans = await getJson<WalletLoans>(config, `/api/v1/wallet/${config.wallet}/loans?status=active`);
printJson("active wallet positions", {
  wallet: walletLoans.wallet ?? config.wallet,
  count: walletLoans.count ?? 0,
  loans: walletLoans.loans ?? [],
});

console.log(
  "Compound decision: no distribution/compound write endpoint is exposed yet; " +
    "a production agent would feed these wallet positions into that endpoint when it ships.",
);
