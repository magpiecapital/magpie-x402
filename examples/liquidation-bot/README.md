# Liquidation bot

This monitor polls `/api/v1/markets/liquidatable`, ranks loans by `secondsPastDue`, and prints the loan PDA data a production liquidator would feed into the on-chain liquidation instruction.

```bash
cd examples
npm run liquidation
```

Expected output shows the number of active and eligible loans plus the top candidates. Set `MAGPIE_LIQUIDATION_LOOPS` above `1` for continuous polling.
