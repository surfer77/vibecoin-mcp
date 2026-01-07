import { ethers } from "ethers";
import { getDecryptedWallet, getWalletAddress, hasWallet } from "./wallet.js";

// Vesting Manager contract address
const VESTING_MANAGER_ADDRESS =
  process.env.VESTING_MANAGER_ADDRESS ||
  "0x943007c14606446BD433426b1E2363309d4C9F0f";

// Default RPC URL (uses env or falls back to Sepolia for now, switch to mainnet when ready)
const DEFAULT_RPC_URL =
  process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";

// Vesting Manager ABI (actual contract interface on Sepolia)
const VESTING_MANAGER_ABI = [
  // View functions - parameter order is (beneficiary, token)
  "function getSchedule(address beneficiary, address token) external view returns (uint256 totalAmount, uint256 released, uint256 releasable, uint256 startTime, uint256 endTime)",
  "function releasable(address beneficiary, address token) external view returns (uint256)",
  "function vestedAmount(address beneficiary, address token) external view returns (uint256)",
  // Write functions
  "function release(address beneficiary, address token) external",
];

// ERC20 ABI for token info
const ERC20_ABI = [
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address account) external view returns (uint256)",
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
      error: "No wallet found. Create a wallet first.",
    };
  }

  const beneficiary = walletResult.address;

  // Validate token address
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return {
      success: false,
      error: "Invalid token address",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const vestingManager = new ethers.Contract(
      VESTING_MANAGER_ADDRESS,
      VESTING_MANAGER_ABI,
      provider
    );
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    // Get token info
    let tokenName, tokenSymbol, decimals;
    try {
      [tokenName, tokenSymbol, decimals] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals(),
      ]);
    } catch {
      tokenName = "Unknown";
      tokenSymbol = "UNKNOWN";
      decimals = 18n;
    }
    // Ensure decimals is a number for math operations - convert via string to avoid BigInt issues
    const decimalsNum =
      typeof decimals === "bigint"
        ? parseInt(decimals.toString(), 10)
        : Number(decimals);

    // Get vesting schedule using correct function name and parameter order (beneficiary, token)
    let schedule;
    try {
      schedule = await vestingManager.getSchedule(beneficiary, tokenAddress);
    } catch (scheduleErr) {
      return {
        success: false,
        error: `Failed to fetch vesting schedule: ${scheduleErr.message}`,
        tokenAddress,
        beneficiary,
      };
    }

    // Convert all values to BigInt explicitly to handle different ethers.js return types
    const totalAmount = BigInt(schedule[0].toString());
    const releasedAmount = BigInt(schedule[1].toString());
    const releasableAmount = BigInt(schedule[2].toString());
    const startTime = BigInt(schedule[3].toString());
    const endTime = BigInt(schedule[4].toString());

    // Check if schedule exists
    if (totalAmount === 0n) {
      return {
        success: false,
        error:
          "No vesting schedule found for this token. The vesting schedule may not have been created yet.",
        tokenAddress,
        beneficiary,
        vestingManagerAddress: VESTING_MANAGER_ADDRESS,
      };
    }

    // Use releasable from contract directly
    const now = BigInt(Math.floor(Date.now() / 1000));
    // startTime and endTime are already BigInts from above
    const durationBig = endTime - startTime;

    let vestedAmount;
    if (now >= endTime) {
      vestedAmount = totalAmount;
    } else if (now <= startTime) {
      vestedAmount = 0n;
    } else {
      vestedAmount = (totalAmount * (now - startTime)) / durationBig;
    }

    // Use releasable from contract (more accurate)
    const releasable = releasableAmount;

    // Calculate unreleased (locked) amount
    const unreleased = totalAmount - vestedAmount;

    // Format amounts - safely handle BigInt conversion
    const formatAmount = (amount) => {
      // Convert BigInt to number-like string, then parse
      // For very large numbers, use string manipulation to avoid overflow
      const amountStr = amount.toString();

      // Handle the decimal placement
      let formatted;
      if (amountStr.length <= decimalsNum) {
        // Number is less than 1
        const zeros = "0".repeat(decimalsNum - amountStr.length);
        formatted = parseFloat(`0.${zeros}${amountStr}`);
      } else {
        // Insert decimal point
        const intPart = amountStr.slice(0, amountStr.length - decimalsNum);
        const decPart = amountStr.slice(amountStr.length - decimalsNum);
        formatted = parseFloat(`${intPart}.${decPart}`);
      }

      if (formatted === 0) return "0";
      if (formatted < 0.01) return formatted.toExponential(2);
      if (formatted < 1000000) return formatted.toLocaleString();
      return `${(formatted / 1000000).toFixed(2)}M`;
    };

    // Calculate vesting progress - convert BigInt timestamps to numbers via string
    const nowNum = Math.floor(Date.now() / 1000);
    const startTimeNum = parseInt(startTime.toString(), 10);
    const endTimeNum = parseInt(endTime.toString(), 10);
    const durationNum = endTimeNum - startTimeNum;

    let vestingProgress = 0;
    let timeRemaining = "";

    if (nowNum >= endTimeNum) {
      vestingProgress = 100;
      timeRemaining = "Fully vested";
    } else if (nowNum <= startTimeNum) {
      vestingProgress = 0;
      timeRemaining = `Starts in ${Math.ceil(
        (startTimeNum - nowNum) / 86400
      )} days`;
    } else {
      vestingProgress = Math.floor(
        ((nowNum - startTimeNum) / durationNum) * 100
      );
      const remainingSeconds = endTimeNum - nowNum;
      const remainingDays = Math.ceil(remainingSeconds / 86400);
      timeRemaining =
        remainingDays > 30
          ? `${Math.floor(remainingDays / 30)} months remaining`
          : `${remainingDays} days remaining`;
    }

    return {
      success: true,
      token: {
        address: tokenAddress,
        name: tokenName,
        symbol: tokenSymbol,
        decimals: decimalsNum,
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
        endTime: new Date(endTimeNum * 1000).toISOString(),
      },
      raw: {
        totalAmount: totalAmount.toString(),
        releasedAmount: releasedAmount.toString(),
        releasableAmount: releasable.toString(),
        lockedAmount: unreleased.toString(),
      },
      vestingManagerAddress: VESTING_MANAGER_ADDRESS,
    };
  } catch (err) {
    // Check for common error cases
    if (
      err.message &&
      (err.message.includes("execution reverted") ||
        err.message.includes("call revert"))
    ) {
      return {
        success: false,
        error:
          "No vesting schedule found for this token and wallet combination",
        tokenAddress,
        beneficiary,
        vestingManagerAddress: VESTING_MANAGER_ADDRESS,
      };
    }
    return {
      success: false,
      error: `Failed to get vesting info: ${err.message || String(err)}`,
    };
  }
}

/**
 * Claim vested tokens
 */
export async function claimVestedTokens(
  password,
  tokenAddress,
  rpcUrl = DEFAULT_RPC_URL
) {
  if (!hasWallet()) {
    return {
      success: false,
      error: "No wallet found. Create a wallet first.",
    };
  }

  // Validate token address
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return {
      success: false,
      error: "Invalid token address",
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
    const vestingManager = new ethers.Contract(
      VESTING_MANAGER_ADDRESS,
      VESTING_MANAGER_ABI,
      wallet
    );
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    // Get token info
    let tokenName, tokenSymbol, decimals;
    try {
      [tokenName, tokenSymbol, decimals] = await Promise.all([
        token.name(),
        token.symbol(),
        token.decimals(),
      ]);
    } catch {
      tokenName = "Unknown";
      tokenSymbol = "UNKNOWN";
      decimals = 18n;
    }
    // Ensure decimals is a number for math operations - convert via string to avoid BigInt issues
    const decimalsNum =
      typeof decimals === "bigint"
        ? parseInt(decimals.toString(), 10)
        : Number(decimals);

    // Get vesting schedule using correct parameter order (beneficiary, token)
    let schedule;
    try {
      schedule = await vestingManager.getSchedule(wallet.address, tokenAddress);
    } catch (scheduleErr) {
      return {
        success: false,
        error: `Failed to fetch vesting schedule: ${scheduleErr.message}`,
        tokenAddress,
      };
    }
    // Convert all values to BigInt explicitly to handle different ethers.js return types
    const totalAmount = BigInt(schedule[0].toString());
    const releasedAmount = BigInt(schedule[1].toString());
    const releasableFromContract = BigInt(schedule[2].toString());
    const startTime = BigInt(schedule[3].toString());
    const endTime = BigInt(schedule[4].toString());

    if (totalAmount === 0n) {
      return {
        success: false,
        error: "No vesting schedule found for this token.",
        tokenAddress,
        tokenName,
        tokenSymbol,
      };
    }

    // Use releasable amount directly from contract (more accurate)
    const releasable = releasableFromContract;

    if (releasable <= 0n) {
      return {
        success: false,
        error:
          "No tokens available to claim. All vested tokens have already been claimed.",
        tokenAddress,
        tokenName,
        tokenSymbol,
      };
    }

    const formatAmount = (amount) => {
      // Safely handle BigInt conversion
      const amountStr = amount.toString();
      let formatted;
      if (amountStr.length <= decimalsNum) {
        const zeros = "0".repeat(decimalsNum - amountStr.length);
        formatted = parseFloat(`0.${zeros}${amountStr}`);
      } else {
        const intPart = amountStr.slice(0, amountStr.length - decimalsNum);
        const decPart = amountStr.slice(amountStr.length - decimalsNum);
        formatted = parseFloat(`${intPart}.${decPart}`);
      }
      return formatted.toLocaleString();
    };

    // Release tokens - correct parameter order (beneficiary, token)
    const tx = await vestingManager.release(wallet.address, tokenAddress);
    const receipt = await tx.wait();

    // Get new balance
    const newBalance = await token.balanceOf(wallet.address);

    return {
      success: true,
      message: `Successfully claimed ${formatAmount(
        releasable
      )} ${tokenSymbol}!`,
      token: {
        address: tokenAddress,
        name: tokenName,
        symbol: tokenSymbol,
      },
      claimed: {
        amount: formatAmount(releasable),
        rawAmount: releasable.toString(),
      },
      transaction: {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
      },
      newBalance: formatAmount(newBalance),
      vestingManagerAddress: VESTING_MANAGER_ADDRESS,
    };
  } catch (err) {
    if (
      err.message.includes("Unsupported state") ||
      err.message.includes("auth")
    ) {
      return {
        success: false,
        error: "Invalid password",
      };
    }
    if (
      err.message.includes("execution reverted") ||
      err.message.includes("call revert")
    ) {
      return {
        success: false,
        error:
          "Transaction reverted. No vesting schedule may exist or no tokens are available to claim.",
        tokenAddress,
      };
    }
    return {
      success: false,
      error: `Claim failed: ${err.message}`,
    };
  }
}

/**
 * Get all vesting schedules for the wallet
 * Requires a list of token addresses to check
 */
export async function getAllVestingInfo(
  tokenAddresses,
  rpcUrl = DEFAULT_RPC_URL
) {
  if (!Array.isArray(tokenAddresses) || tokenAddresses.length === 0) {
    return {
      success: false,
      error: "Token addresses array is required",
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
    vestingManagerAddress: VESTING_MANAGER_ADDRESS,
  };
}
