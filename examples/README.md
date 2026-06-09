# Magpie x402 reference agents

These examples are small runnable agents that exercise the current Magpie x402 API without inventing client SDKs. They default to dry-run mode for paid endpoints: the first call fetches the `402 Payment Required` challenge, prints the exact amount, recipient, nonce, and memo, and only retries when `X402_PAYMENT_SIGNATURE` is set.

## Setup

```bash
cd examples
npm install
cp .env.example .env
```

For local API testing, start the service from the repository root:

```bash
npm run dev
```

Then run an agent:

```bash
npm run borrowing
npm run liquidation
npm run yield
npm run portfolio-risk
```

## Examples

| Agent | Command | Demonstrates |
| --- | --- | --- |
| Borrowing agent | `npm run borrowing` | `/simulate-borrow`, `/agent/build-borrow`, x402 challenge and retry |
| Liquidation bot | `npm run liquidation` | `/markets/liquidatable` polling and liquidation candidate ranking |
| Yield agent | `npm run yield` | collateral discovery plus wallet-position monitoring for compound decisions |
| Portfolio-risk agent | `npm run portfolio-risk` | `/credit-score`, `/agent/credit-attest`, partner-side attestation verification hook |

Paid endpoints stay in dry-run mode until a real Solana payment signature is provided. That keeps the examples safe to copy and run while still showing every x402 step a production agent needs.
