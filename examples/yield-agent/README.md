# Yield agent

This agent discovers eligible collateral and checks the configured wallet's active loans. It is intentionally honest about the current API surface: distribution receipts and compound writes are not exposed by this repository yet, so the example prints the compound decision data a future write endpoint would consume.

```bash
cd examples
npm run yield
```

Expected output includes the collateral catalog summary, active wallet positions, and the next protocol action hook for compounding.
