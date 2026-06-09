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

// Define the borrowing agent
async function borrowingAgent() {
  // Get the current SOL price
  const solPriceResponse = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  const solPrice = solPriceResponse.data.solana.usd;

  // Check if the SOL price is up 5% in 24 hours
  const solPrice24hResponse = await axios.get('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=1');
  const solPrice24h = solPrice24hResponse.data.prices[0][1];
  if (solPrice > solPrice24h * 1.05) {
    // Simulate borrowing 1 SOL
    const simulateBorrowResponse = await x402Client.simulateBorrow({
      amount: 1,
      token: 'SOL',
    });
    console.log(`Borrowing ${simulateBorrowResponse.amount} SOL...`);

    // Build the borrow transaction
    const buildBorrowResponse = await x402Client.buildBorrow({
      amount: 1,
      token: 'SOL',
    });
    console.log(`Borrow transaction built: ${buildBorrowResponse.transaction}`);

    // Send the borrow transaction
    const sendBorrowResponse = await solana.sendTransaction(buildBorrowResponse.transaction, {
      signers: [solana.wallet],
    });
    console.log(`Borrow transaction sent: ${sendBorrowResponse.signature}`);

    // Verify the borrow transaction
    const verifyBorrowResponse = await x402Client.verifyBorrow({
      transaction: sendBorrowResponse.signature,
    });
    console.log(`Borrow transaction verified: ${verifyBorrowResponse.success}`);
  } else {
    console.log('SOL price is not up 5% in 24 hours.');
  }
}

// Run the borrowing agent
borrowingAgent();
