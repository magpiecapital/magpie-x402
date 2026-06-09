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

// Define the liquidation bot
async function liquidationBot() {
  // Get the list of liquidatable loans
  const liquidatableLoansResponse = await x402Client.getLiquidatableLoans();
  const liquidatableLoans = liquidatableLoansResponse.data;

  // Loop through the liquidatable loans and liquidate them
  for (const loan of liquidatableLoans) {
    // Liquidate the loan
    const liquidateLoanResponse = await x402Client.liquidateLoan({
      loanId: loan.id,
    });
    console.log(`Liquidating loan ${loan.id}...`);

    // Verify the liquidation transaction
    const verifyLiquidationResponse = await x402Client.verifyLiquidation({
      transaction: liquidateLoanResponse.transaction,
    });
    console.log(`Liquidation transaction verified: ${verifyLiquidationResponse.success}`);
  }
}

// Run the liquidation bot
setInterval(liquidationBot, 5000);
