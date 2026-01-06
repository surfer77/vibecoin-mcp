import { ethers } from 'ethers';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');

// Default wallet key (single wallet per installation)
const DEFAULT_KEY = 'default';

// Encryption settings
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadWallet() {
  ensureDataDir();
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }
  const data = fs.readFileSync(WALLET_FILE, 'utf8');
  return JSON.parse(data);
}

function saveWallet(wallet) {
  ensureDataDir();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 0o600 });
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(text, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    encrypted
  };
}

function decrypt(encryptedData, password) {
  const salt = Buffer.from(encryptedData.salt, 'hex');
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const tag = Buffer.from(encryptedData.tag, 'hex');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Create a new wallet
 */
export async function createWallet(password) {
  const existing = loadWallet();

  if (existing) {
    return {
      success: false,
      error: 'Wallet already exists. Use "get" to retrieve it.',
      address: existing.address
    };
  }

  // Generate new Ethereum wallet
  const wallet = ethers.Wallet.createRandom();

  // Encrypt the private key
  const encryptedKey = encrypt(wallet.privateKey, password);

  // Store wallet data
  saveWallet({
    address: wallet.address,
    encryptedKey,
    createdAt: new Date().toISOString()
  });

  return {
    success: true,
    address: wallet.address,
    message: 'Wallet created! This is where your fees from coin launches will be sent.',
    warning: 'CRITICAL: Your password is the ONLY way to access this wallet. There is NO recovery option. If you lose your password, your wallet and all funds are permanently lost!'
  };
}

/**
 * Get wallet address (no password needed)
 */
export function getWalletAddress() {
  const wallet = loadWallet();

  if (!wallet) {
    return {
      success: false,
      error: 'No wallet found. Create one first with action="create" and a password. This wallet is where your fees from coin launches will be sent. Choose a password you will NEVER forget - there is no recovery option!'
    };
  }

  return {
    success: true,
    address: wallet.address,
    createdAt: wallet.createdAt,
    note: 'This is where your fees from coin launches are sent.'
  };
}

/**
 * Get wallet balance
 */
export async function getBalance(rpcUrl = process.env.RPC_URL || 'https://eth.llamarpc.com') {
  const wallet = loadWallet();

  if (!wallet) {
    return {
      success: false,
      error: 'No wallet found'
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(wallet.address);

    return {
      success: true,
      address: wallet.address,
      balance: ethers.formatEther(balance),
      unit: 'ETH'
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to get balance: ${err.message}`
    };
  }
}

/**
 * Sign a message with the wallet
 */
export async function signMessage(password, message) {
  const walletData = loadWallet();

  if (!walletData) {
    return {
      success: false,
      error: 'No wallet found'
    };
  }

  try {
    const privateKey = decrypt(walletData.encryptedKey, password);
    const wallet = new ethers.Wallet(privateKey);
    const signature = await wallet.signMessage(message);

    return {
      success: true,
      address: wallet.address,
      message,
      signature
    };
  } catch (err) {
    if (err.message.includes('Unsupported state') || err.message.includes('auth')) {
      return {
        success: false,
        error: 'Invalid password'
      };
    }
    return {
      success: false,
      error: `Signing failed: ${err.message}`
    };
  }
}

/**
 * Get decrypted wallet instance (for internal use)
 */
export function getDecryptedWallet(password) {
  const walletData = loadWallet();

  if (!walletData) {
    return {
      success: false,
      error: 'No wallet found'
    };
  }

  try {
    const privateKey = decrypt(walletData.encryptedKey, password);
    const wallet = new ethers.Wallet(privateKey);

    return {
      success: true,
      wallet,
      address: wallet.address
    };
  } catch (err) {
    return {
      success: false,
      error: 'Invalid password'
    };
  }
}

/**
 * Check if wallet exists
 */
export function hasWallet() {
  return loadWallet() !== null;
}

/**
 * Transfer ETH to another address
 * WARNING: This is irreversible!
 */
export async function transfer(password, toAddress, amount, rpcUrl = process.env.RPC_URL || 'https://eth.llamarpc.com') {
  const walletData = loadWallet();

  if (!walletData) {
    return {
      success: false,
      error: 'No wallet found'
    };
  }

  // Validate address
  if (!ethers.isAddress(toAddress)) {
    return {
      success: false,
      error: 'Invalid destination address'
    };
  }

  try {
    const privateKey = decrypt(walletData.encryptedKey, password);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // Get current balance
    const balance = await provider.getBalance(wallet.address);
    const amountWei = ethers.parseEther(amount);

    if (balance < amountWei) {
      return {
        success: false,
        error: `Insufficient balance. You have ${ethers.formatEther(balance)} ETH but tried to send ${amount} ETH`
      };
    }

    // Send transaction
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountWei
    });

    // Wait for confirmation
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.hash,
      from: wallet.address,
      to: toAddress,
      amount: amount,
      unit: 'ETH',
      blockNumber: receipt.blockNumber
    };
  } catch (err) {
    if (err.message.includes('Unsupported state') || err.message.includes('auth')) {
      return {
        success: false,
        error: 'Invalid password'
      };
    }
    return {
      success: false,
      error: `Transfer failed: ${err.message}`
    };
  }
}

/**
 * Collect accumulated fees from the hook contract
 *
 * The VibecoinHook.collectFees(poolId) function:
 * - Requires minimum 0.1 ETH accumulated fees
 * - Automatically converts any token fees to ETH first
 * - Splits fees: collector gets 0.002 ETH reward, rest split 50/50 between owner and creator
 */
export async function collectFees(password, graphqlUrl, rpcUrl = process.env.RPC_URL || 'https://eth.llamarpc.com') {
  const walletData = loadWallet();

  if (!walletData) {
    return {
      success: false,
      error: 'No wallet found'
    };
  }

  try {
    const privateKey = decrypt(walletData.encryptedKey, password);
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const creatorAddress = wallet.address.toLowerCase();

    // Query GraphQL to get user's tokens with pool key components
    const query = `
      query GetUserTokens($creator: String!) {
        tokens(
          where: { creator: $creator }
          limit: 100
        ) {
          items {
            id
            name
            symbol
            poolCurrency0
            poolCurrency1
            poolFee
            poolTickSpacing
            poolHooks
            totalEthFeesAccumulated
            totalTokenFeesAccumulated
          }
        }
      }
    `;

    const graphqlResponse = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { creator: creatorAddress } }),
    });

    if (!graphqlResponse.ok) {
      return {
        success: false,
        error: 'Failed to fetch token data from GraphQL'
      };
    }

    const graphqlResult = await graphqlResponse.json();
    if (graphqlResult.errors) {
      return {
        success: false,
        error: `GraphQL error: ${graphqlResult.errors[0].message}`
      };
    }

    const tokens = graphqlResult.data?.tokens?.items || [];

    if (tokens.length === 0) {
      return {
        success: false,
        error: 'No tokens found for this wallet. Launch a token first to earn fees.'
      };
    }

    // Compute pool ID from pool key components
    // PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
    function computePoolId(token) {
      return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'address', 'uint24', 'int24', 'address'],
          [token.poolCurrency0, token.poolCurrency1, token.poolFee, token.poolTickSpacing, token.poolHooks]
        )
      );
    }

    // VibecoinHook ABI for collectFees
    const HOOK_ABI = [
      'function collectFees(bytes32 poolId) external',
      'function getPoolFees(bytes32 poolId) external view returns (uint256)',
      'function getPoolTokenFees(bytes32 poolId) external view returns (uint256)'
    ];

    // Hook address (Sepolia deployment)
    const hookAddress = process.env.HOOK_ADDRESS || '0x500A0B76CF4771ccdC3fca7D9955B2590e277A44';
    const hook = new ethers.Contract(hookAddress, HOOK_ABI, wallet);

    const results = [];
    const MIN_FEE_COLLECTION = ethers.parseEther('0.1');

    for (const token of tokens) {
      const poolId = computePoolId(token);

      try {
        // Check accumulated fees (ETH + pending token fees)
        const ethFees = await hook.getPoolFees(poolId);
        const tokenFees = await hook.getPoolTokenFees(poolId);

        // Note: collectFees will convert token fees automatically
        // But we estimate if total would meet minimum
        if (ethFees < MIN_FEE_COLLECTION && tokenFees === 0n) {
          results.push({
            poolId,
            tokenAddress: token.id,
            tokenName: token.name,
            tokenSymbol: token.symbol,
            status: 'skipped',
            reason: `Insufficient fees: ${ethers.formatEther(ethFees)} ETH (minimum 0.1 ETH required)`
          });
          continue;
        }

        // Collect fees (automatically converts token fees first)
        const tx = await hook.collectFees(poolId);
        const receipt = await tx.wait();

        results.push({
          poolId,
          tokenAddress: token.id,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          status: 'collected',
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          ethFees: ethers.formatEther(ethFees),
          tokenFeesPending: ethers.formatEther(tokenFees)
        });

      } catch (poolErr) {
        results.push({
          poolId,
          tokenAddress: token.id,
          tokenName: token.name,
          tokenSymbol: token.symbol,
          status: 'error',
          error: poolErr.message
        });
      }
    }

    const collected = results.filter(r => r.status === 'collected');
    const skipped = results.filter(r => r.status === 'skipped');
    const errors = results.filter(r => r.status === 'error');

    return {
      success: true,
      message: `Processed ${tokens.length} token(s)`,
      summary: {
        collected: collected.length,
        skipped: skipped.length,
        errors: errors.length
      },
      results,
      note: 'Fees require minimum 0.1 ETH to collect. Collector receives 0.002 ETH reward, rest split between platform and creator.'
    };

  } catch (err) {
    if (err.message.includes('Unsupported state') || err.message.includes('auth')) {
      return {
        success: false,
        error: 'Invalid password'
      };
    }
    return {
      success: false,
      error: `Fee collection failed: ${err.message}`
    };
  }
}
