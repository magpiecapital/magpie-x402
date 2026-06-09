const axios = require('axios');
const { Solana } = require('@solana/web3.js');
const { X402Client } = require('x402-client');

// Load environment variables
require('dotenv').config();

// Set up X402 client
const x402Client = new X402Client({
  scheme: 'https',
  host: 'api.magpie.capital',
  port: 443,
});

// Set up Solana client
const solana = new Solana({
  rpcUrl: 'https://api.devnet.solana.com',
});

// Define the portfolio risk agent
async function portfolioRiskAgent() {
  // Get the credit score
  const creditScoreResponse = await x402Client.getCreditScore();
  const creditScore = creditScoreResponse.data;

  // Attest the credit score to a partner protocol
  const attestCreditScoreResponse = await x402Client.attestCreditScore({
    creditScore: creditScore.score,
  });
  console.log(`Attesting credit score...`);

  // Verify the attestation transaction
  const verifyAttestationResponse = await x402Client.verifyAttestation({
    transaction: attestCreditScoreResponse.transaction,
  });
  console.log(`Attestation transaction verified: ${verifyAttestationResponse.success}`);
}

// Run the portfolio risk agent
setInterval(portfolioRiskAgent, 604800);
