# Borrowing agent

This agent quotes a borrow when SOL is up at least 5% over the configured 24h reference price. It first calls `/api/v1/simulate-borrow` for a free quote, then demonstrates the x402 challenge/retry flow for `/api/v1/agent/build-borrow`.

```bash
cd examples
npm run borrowing
```

Expected output includes the SOL move, the quote response, and either a `402 Payment Required` challenge or the paid borrow-build response if `X402_PAYMENT_SIGNATURE` is set.
