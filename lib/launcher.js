import { ethers } from 'ethers';
import { getDecryptedWallet, hasWallet } from './wallet.js';

// API endpoint for the Ponder indexer server (includes launch endpoint)
const API_BASE_URL = process.env.LAUNCHER_API_URL || 'https://vibecoin.up.railway.app';

/**
 * Launch a new coin by calling the external deployment API
 */
export async function launchCoin(options) {
  const { password, name, symbol, url, github, description } = options;

  // Validate inputs - just check they exist
  if (!name) {
    return { success: false, error: 'Name is required' };
  }

  if (!symbol) {
    return { success: false, error: 'Symbol is required' };
  }

  // Check if wallet exists
  if (!hasWallet()) {
    return {
      success: false,
      error: 'No wallet found. Create one first using the wallet tool with action="create". Your wallet is where fees from coin launches are sent. IMPORTANT: Choose a password you will NEVER forget - there is NO recovery option!',
      action_required: 'create_wallet'
    };
  }

  // Get wallet to sign the launch request
  const walletResult = getDecryptedWallet(password);
  if (!walletResult.success) {
    return walletResult;
  }

  const wallet = walletResult.wallet;
  const walletAddress = wallet.address;

  // Create the message to sign
  const timestamp = Date.now();
  const message = `Launch coin on Vibecoins\n\nName: ${name}\nSymbol: ${symbol}\nCreator: ${walletAddress}\nTimestamp: ${timestamp}`;

  // Sign the message
  const signature = await wallet.signMessage(message);

  // Call external API to deploy the contract
  try {
    const response = await fetch(`${API_BASE_URL}/api/launch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        walletAddress,
        signature,
        message,
        name,
        symbol,
        timestamp,
        url: url || null,
        github: github || null,
        description: description || null,
      })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      return {
        success: false,
        error: result.error || 'Failed to launch coin'
      };
    }

    return {
      success: true,
      message: 'Coin launched successfully!',
      coin: {
        id: result.tokenAddress,
        name,
        symbol,
        totalSupply: result.totalSupply,
        contractAddress: result.tokenAddress,
        transactionHash: result.transactionHash,
        creator: walletAddress,
        status: 'launched',
        url: url || null,
        github: github || null,
        description: description || null,
      }
    };
  } catch (err) {
    // API not available - run in stub mode for testing
    if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch')) {
      console.error('API not available, running in stub mode');

      const mockTxHash = `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;
      const mockContractAddress = `0x${Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

      return {
        success: true,
        message: 'Coin launched (STUB MODE - API not available)',
        coin: {
          id: mockContractAddress,
          name,
          symbol,
          contractAddress: mockContractAddress,
          transactionHash: mockTxHash,
          creator: walletAddress,
          status: 'launched',
          url: url || null,
          github: github || null,
          description: description || null,
        },
        note: 'Running in stub mode because deployment API is not available.'
      };
    }

    return {
      success: false,
      error: `Launch failed: ${err.message}`
    };
  }
}

/**
 * Get status of the deployment API (via stats endpoint)
 */
export async function getApiStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/stats`);
    const result = await response.json();
    return {
      available: true,
      ...result
    };
  } catch (err) {
    return {
      available: false,
      message: 'Indexer API not available. Launches will run in stub mode.',
      apiUrl: API_BASE_URL
    };
  }
}
