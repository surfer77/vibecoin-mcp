import { ethers } from 'ethers';
import { getDecryptedWallet, getWalletAddress, hasWallet } from './wallet.js';

// Vesting Manager contract address
const VESTING_MANAGER_ADDRESS = process.env.VESTING_MANAGER_ADDRESS || '0xBFb167A9c8054bb2C46799D98CE15045A40961Bc';

// Default RPC URL (uses env or falls back to Sepolia for now, switch to mainnet when ready)
const DEFAULT_RPC_URL = process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/demo';

// Vesting Manager ABI (actual contract interface on Sepolia)
const VESTING_MANAGER_ABI = [
  // View functions - using correct function names from deployed contract
  'function schedules(address token, address beneficiary) external view returns (uint256 totalAmount, uint256 releasedAmount, uint256 startTime, uint256 duration)',
  'function vestedAmount(address token, address beneficiary) external view returns (uint256)',
  // Write functions
  'function release(address token) external',
  'function releaseFor(address token, address beneficiary) external'
];

// ERC20 ABI for token info
const ERC20_ABI = [
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function balanceOf(address account) external view returns (uint256)'
];

/**
 * Get vesting info for a specific token
 */
export async function getVestingInfo(tokenAddress, rpcUrl = DEFAULT_RPC_URL) {
  // Get wallet address
  const walletResult = getWalletAddress();
  if (!walletResult.success || !walletResult.address) {
    return {
      success: false,
      error: 'No wallet found. Create a wallet first.'
    };
  }

  const beneficiary = walletResult.address;

  // Validate token address
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return {
      success: false,
      error: 'Invalid token address'
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const vestingManager = new ethers.Contract(VESTING_MANAGER_ADDRESS, VESTING_MANAGER_ABI, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    // Get token info
    let tokenName, tokenSymbol, decimals;
    try {
      [tokenName, tokenSymbol, decimals] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals()
      ]);
    } catch {
      tokenName = 'Unknown';
      tokenSymbol = 'UNKNOWN';
      decimals = 18;
    }

    // Get vesting schedule using correct function name
    const schedule = await vestingManager.schedules(tokenAddress, beneficiary);
    const totalAmount = schedule[0];
    const releasedAmount = schedule[1];
    const startTime = schedule[2];
    const duration = schedule[3];

    // Check if schedule exists
    if (totalAmount === 0n) {
      return {
        success: false,
        error: 'No vesting schedule found for this token. The vesting schedule may not have been created yet.',
        tokenAddress,
        beneficiary,
        vestingManagerAddress: VESTING_MANAGER_ADDRESS
      };
    }

    // Calculate releasable amount (vested but not yet claimed)
    const now = BigInt(Math.floor(Date.now() / 1000));
    const startTimeBig = BigInt(startTime);
    const durationBig = BigInt(duration);
    const endTime = startTimeBig + durationBig;

    let vestedAmount;
    if (now >= endTime) {
      vestedAmount = totalAmount;
    } else if (now <= startTimeBig) {
      vestedAmount = 0n;
    } else {
      vestedAmount = (totalAmount * (now - startTimeBig)) / durationBig;
    }

    const releasable = vestedAmount - releasedAmount;

    // Calculate unreleased (locked) amount
    const unreleased = totalAmount - vestedAmount;

    // Format amounts
    const formatAmount = (amount) => {
      const formatted = Number(amount) / Math.pow(10, decimals);
      if (formatted === 0) return '0';
      if (formatted < 0.01) return formatted.toExponential(2);
      if (formatted < 1000000) return formatted.toLocaleString();
      return `${(formatted / 1000000).toFixed(2)}M`;
    };

    // Calculate vesting progress
    const nowNum = Math.floor(Date.now() / 1000);
    const startTimeNum = Number(startTime);
    const durationNum = Number(duration);
    const endTimeNum = startTimeNum + durationNum;

    let vestingProgress = 0;
    let timeRemaining = '';

    if (nowNum >= endTimeNum) {
      vestingProgress = 100;
      timeRemaining = 'Fully vested';
    } else if (nowNum <= startTimeNum) {
      vestingProgress = 0;
      timeRemaining = `Starts in ${Math.ceil((startTimeNum - nowNum) / 86400)} days`;
    } else {
      vestingProgress = Math.floor(((nowNum - startTimeNum) / durationNum) * 100);
      const remainingSeconds = endTimeNum - nowNum;
      const remainingDays = Math.ceil(remainingSeconds / 86400);
      timeRemaining = remainingDays > 30
        ? `${Math.floor(remainingDays / 30)} months remaining`
        : `${remainingDays} days remaining`;
    }

    return {
      success: true,
      token: {
        address: tokenAddress,
        name: tokenName,
        symbol: tokenSymbol,
        decimals
      },
      beneficiary,
      vesting: {
        totalAmount: formatAmount(totalAmount),
        releasedAmount: formatAmount(releasedAmount),
        releasableAmount: formatAmount(releasable),
        lockedAmount: formatAmount(unreleased),
        progress: `${vestingProgress}%`,
        timeRemaining,
        startTime: new Date(startTimeNum * 1000).toISOString(),
        endTime: new Date(endTimeNum * 1000).toISOString()
      },
      raw: {
        totalAmount: totalAmount.toString(),
        releasedAmount: releasedAmount.toString(),
        releasableAmount: releasable.toString(),
        lockedAmount: unreleased.toString()
      },
      vestingManagerAddress: VESTING_MANAGER_ADDRESS
    };

  } catch (err) {
    // Check for common error cases
    if (err.message.includes('execution reverted') || err.message.includes('call revert')) {
      return {
        success: false,
        error: 'No vesting schedule found for this token and wallet combination',
        tokenAddress,
        beneficiary,
        vestingManagerAddress: VESTING_MANAGER_ADDRESS
      };
    }
    return {
      success: false,
      error: `Failed to get vesting info: ${err.message}`
    };
  }
}

/**
 * Claim vested tokens
 */
export async function claimVestedTokens(password, tokenAddress, rpcUrl = DEFAULT_RPC_URL) {
  if (!hasWallet()) {
    return {
      success: false,
      error: 'No wallet found. Create a wallet first.'
    };
  }

  // Validate token address
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return {
      success: false,
      error: 'Invalid token address'
    };
  }

  // Get decrypted wallet
  const walletResult = getDecryptedWallet(password);
  if (!walletResult.success) {
    return walletResult;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = walletResult.wallet.connect(provider);
    const vestingManager = new ethers.Contract(VESTING_MANAGER_ADDRESS, VESTING_MANAGER_ABI, wallet);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    // Get token info
    let tokenName, tokenSymbol, decimals;
    try {
      [tokenName, tokenSymbol, decimals] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals()
      ]);
    } catch {
      tokenName = 'Unknown';
      tokenSymbol = 'UNKNOWN';
      decimals = 18;
    }

    // Get vesting schedule and calculate releasable amount
    const schedule = await vestingManager.schedules(tokenAddress, wallet.address);
    const totalAmount = schedule[0];
    const releasedAmount = schedule[1];
    const startTime = schedule[2];
    const duration = schedule[3];

    if (totalAmount === 0n) {
      return {
        success: false,
        error: 'No vesting schedule found for this token.',
        tokenAddress,
        tokenName,
        tokenSymbol
      };
    }

    // Calculate releasable amount
    const now = BigInt(Math.floor(Date.now() / 1000));
    const startTimeBig = BigInt(startTime);
    const durationBig = BigInt(duration);
    const endTime = startTimeBig + durationBig;

    let vestedAmount;
    if (now >= endTime) {
      vestedAmount = totalAmount;
    } else if (now <= startTimeBig) {
      vestedAmount = 0n;
    } else {
      vestedAmount = (totalAmount * (now - startTimeBig)) / durationBig;
    }

    const releasable = vestedAmount - releasedAmount;

    if (releasable <= 0n) {
      return {
        success: false,
        error: 'No tokens available to claim. All vested tokens have already been claimed.',
        tokenAddress,
        tokenName,
        tokenSymbol
      };
    }

    const formatAmount = (amount) => {
      const formatted = Number(amount) / Math.pow(10, decimals);
      return formatted.toLocaleString();
    };

    // Release tokens
    const tx = await vestingManager.release(tokenAddress);
    const receipt = await tx.wait();

    // Get new balance
    const newBalance = await token.balanceOf(wallet.address);

    return {
      success: true,
      message: `Successfully claimed ${formatAmount(releasable)} ${tokenSymbol}!`,
      token: {
        address: tokenAddress,
        name: tokenName,
        symbol: tokenSymbol
      },
      claimed: {
        amount: formatAmount(releasable),
        rawAmount: releasable.toString()
      },
      transaction: {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber
      },
      newBalance: formatAmount(newBalance),
      vestingManagerAddress: VESTING_MANAGER_ADDRESS
    };

  } catch (err) {
    if (err.message.includes('Unsupported state') || err.message.includes('auth')) {
      return {
        success: false,
        error: 'Invalid password'
      };
    }
    if (err.message.includes('execution reverted') || err.message.includes('call revert')) {
      return {
        success: false,
        error: 'Transaction reverted. No vesting schedule may exist or no tokens are available to claim.',
        tokenAddress
      };
    }
    return {
      success: false,
      error: `Claim failed: ${err.message}`
    };
  }
}

/**
 * Get all vesting schedules for the wallet
 * Requires a list of token addresses to check
 */
export async function getAllVestingInfo(tokenAddresses, rpcUrl = DEFAULT_RPC_URL) {
  if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
    return {
      success: false,
      error: 'Token addresses array is required'
    };
  }

  const results = [];
  for (const tokenAddress of tokenAddresses) {
    const result = await getVestingInfo(tokenAddress, rpcUrl);
    if (result.success) {
      results.push(result);
    }
  }

  return {
    success: true,
    schedules: results,
    totalSchedules: results.length,
    vestingManagerAddress: VESTING_MANAGER_ADDRESS
  };
}
