import type { Context } from "hono";
import { Connection, PublicKey } from "@solana/web3.js";
import { LENDING_PROGRAM_V1 } from "../lib/magpie-program.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

/**
 * GET /api/v1/wallet/:wallet/health
 *
 * Borrower health-factor per loan + portfolio-wide collateral utilization.
 * Natural follow-up call after /wallet/:wallet/loans.
 *
 * Free; piggybacks on /wallet/loans cache by using the same getProgramAccounts
 * query, then deriving health metrics from the on-chain Loan account data.
 *
 * Returns:
 *   - perLoan: time-to-due, collateral-to-debt ratio per active loan
 *   - portfolio: aggregate collateral utilization across all active loans
 *
 * Use case: any agent that needs to decide "are my borrower's positions in trouble".
 */

const BORROWER_OFFSET = 8;
const LOAN_ACCOUNT_SIZE = 123;

interface LoanHealth {
  loanPda: string;
  loanId: string;
  collateralMint: string;
  loanAmountLamports: string;
  collateralAmount: string;
  originalLoanAmountLamports: string;
  startTimestampUnix: number;
  dueTimestampUnix: number;
  ltvPercentage: number;
  durationDays: number;
  secondsUntilDue: number;
  collateralToDebtRatio: number;
  status: "active" | "repaid" | "liquidated" | "unknown";
}

interface PortfolioHealth {
  totalActiveLoans: number;
  totalCollateralLamports: string;
  totalDebtLamports: string;
  portfolioUtilizationPercent: number;
  totalSecondsUntilDueMin: number; // smallest seconds-until-due across active loans (earliest)
  totalSecondsUntilDueAvg: number;
}

// Per-wallet cache. 8s TTL matches the wallet-loans cache.
const healthCache = new Map<string, { health: { wallet: string; perLoan: LoanHealth[]; portfolio: PortfolioHealth }; expiresAt: number }>();
const WALLET_TTL_MS = 8_000;

export async function walletHealthHandler(c: Context) {
  const walletParam = c.req.param("wallet");
  if (!walletParam) {
    return c.json({ error: "missing_wallet" }, 400);
  }
  let walletKey: PublicKey;
  try {
    walletKey = new PublicKey(walletParam);
  } catch {
    return c.json({ error: "invalid_wallet_pubkey" }, 400);
  }

  const cacheKey = walletKey.toBase58();
  const cached = healthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.health, 200, {
      "Cache-Control": "public, max-age=8, s-maxage=8, stale-while-revalidate=15",
      "X-Cache": "HIT",
    });
  }

  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const accounts = await conn().getProgramAccounts(LENDING_PROGRAM_V1, {
      commitment: "confirmed",
      filters: [
        { dataSize: LOAN_ACCOUNT_SIZE },
        { memcmp: { offset: BORROWER_OFFSET, bytes: walletKey.toBase58() } },
      ],
    });

    const allLoans = accounts.map(({ pubkey, account }) => {
      const data = Buffer.from(account.data);
      const u64 = (o: number) => data.readBigUInt64LE(o).toString();
      const i64 = (o: number) => Number(data.readBigInt64LE(o));
      const statusByte = data.readUInt8(122);
      const loanAmt = u64(80) === "0" ? BigInt(0) : BigInt(u64(80));
      const collAmt = u64(96) === "0" ? BigInt(0) : BigInt(u64(96));

      return {
        loanPda: pubkey.toBase58(),
        loanId: u64(72),
        collateralMint: new PublicKey(data.subarray(40, 72)).toBase58(),
        loanAmountLamports: u64(80),
        originalLoanAmountLamports: u64(88),
        collateralAmount: u64(96),
        startTimestampUnix: i64(104),
        dueTimestampUnix: i64(112),
        ltvPercentage: data.readUInt8(120),
        durationDays: data.readUInt8(121),
        status:
          statusByte === 0 ? "active" as const :
          statusByte === 1 ? "repaid" as const :
          statusByte === 2 ? "liquidated" as const : "unknown" as const,
        loanAmt,
        collAmt,
        secondsUntilDue: i64(112) - nowUnix,
        collateralToDebtRatio: collAmt > BigInt(0) ? Number(loanAmt) / Number(collAmt) : 0,
      };
    });

    const activeLoans = allLoans.filter((l) => l.status === "active");
    const perLoan: LoanHealth[] = activeLoans.map((l) => ({
      loanPda: l.loanPda,
      loanId: l.loanId,
      collateralMint: l.collateralMint,
      loanAmountLamports: l.loanAmountLamports,
      collateralAmount: l.collateralAmount,
      originalLoanAmountLamports: l.originalLoanAmountLamports,
      startTimestampUnix: l.startTimestampUnix,
      dueTimestampUnix: l.dueTimestampUnix,
      ltvPercentage: l.ltvPercentage,
      durationDays: l.durationDays,
      secondsUntilDue: l.secondsUntilDue,
      collateralToDebtRatio: Number(l.collateralToDebtRatio.toFixed(4)),
      status: l.status,
    }));

    const totalCollateral = activeLoans.reduce((s, l) => s + l.collAmt, BigInt(0));
    const totalDebt = activeLoans.reduce((s, l) => s + l.loanAmt, BigInt(0));
    const avgSecUntilDue = activeLoans.length > 0
      ? Math.round(activeLoans.reduce((s, l) => s + l.secondsUntilDue, 0) / activeLoans.length)
      : 0;
    const minSecUntilDue = activeLoans.length > 0
      ? Math.min(...activeLoans.map((l) => l.secondsUntilDue))
      : 0;

    const portfolio: PortfolioHealth = {
      totalActiveLoans: activeLoans.length,
      totalCollateralLamports: totalCollateral.toString(),
      totalDebtLamports: totalDebt.toString(),
      portfolioUtilizationPercent: totalCollateral > BigInt(0)
        ? Number((Number(totalDebt) / Number(totalCollateral) * 100).toFixed(2))
        : 0,
      totalSecondsUntilDueMin: minSecUntilDue,
      totalSecondsUntilDueAvg: avgSecUntilDue,
    };

    const result = {
      wallet: cacheKey,
      perLoan,
      portfolio,
    };

    healthCache.set(cacheKey, { health: result, expiresAt: Date.now() + WALLET_TTL_MS });

    return c.json(result, 200, {
      "Cache-Control": "public, max-age=8, s-maxage=8, stale-while-revalidate=15",
      "X-Cache": "MISS",
    });
  } catch (err) {
    console.warn("[wallet-health] error:", (err as Error).message);
    return c.json({ error: "wallet_health_fetch_failed" }, 502);
  }
}
