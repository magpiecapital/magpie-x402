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

// Define the yield agent
async function yieldAgent() {
  // Get the list of distributions
  const distributionsResponse = await x402Client.getDistributions();
  const distributions = distributionsResponse.data;

  // Loop through the distributions and compound them
  for (const distribution of distributions) {
    // Compound the distribution
    const compoundDistributionResponse = await x402Client.compoundDistribution({
      distributionId: distribution.id,
    });
    console.log(`Compounding distribution ${distribution.id}...`);

    // Verify the compounding transaction
    const verifyCompoundingResponse = await x402Client.verifyCompounding({
      transaction: compoundDistributionResponse.transaction,
    });
    console.log(`Compounding transaction verified: ${verifyCompoundingResponse.success}`);
  }
}

// Run the yield agent
yieldAgent();
