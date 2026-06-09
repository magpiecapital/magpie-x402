# Portfolio-risk agent

This agent demonstrates the paid credit-score and signed credit-attestation flow. In dry-run mode it prints the x402 challenge for the paid endpoints; after payment, set `X402_PAYMENT_SIGNATURE` and re-run to fetch the paid response.

```bash
cd examples
npm run portfolio-risk
```

Expected output includes the credit-score challenge or response, the attestation challenge or response, and a partner-side verification result when the attestation payload contains a public key, payload, and signature.
