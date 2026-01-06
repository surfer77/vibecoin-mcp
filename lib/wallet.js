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
export async function getBalance(rpcUrl = 'https://eth.llamarpc.com') {
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
export async function transfer(password, toAddress, amount, rpcUrl = 'https://eth.llamarpc.com') {
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
 * Collect accumulated fees from the fee contract
 */
export async function collectFees(password, apiBaseUrl, rpcUrl = 'https://eth.llamarpc.com') {
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

    // FeeHook contract ABI
    const FEE_HOOK_ABI = [
      'function claimFees(address recipient) external returns (uint256)'
    ];

    // Get fee hook address from API
    const configResponse = await fetch(`${apiBaseUrl}/api/config`);
    if (!configResponse.ok) {
      return {
        success: false,
        error: 'Failed to fetch contract config from API'
      };
    }
    const config = await configResponse.json();

    if (!config.feeHookAddress) {
      return {
        success: false,
        error: 'Fee hook contract address not configured'
      };
    }

    const feeHook = new ethers.Contract(config.feeHookAddress, FEE_HOOK_ABI, wallet);
    const tx = await feeHook.claimFees(wallet.address);
    const receipt = await tx.wait();

    return {
      success: true,
      message: 'Fees collected from contract',
      transactionHash: receipt.hash,
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
      error: `Fee collection failed: ${err.message}`
    };
  }
}
