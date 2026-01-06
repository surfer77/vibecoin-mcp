# Security Model

This document explains how Vibecoin handles your private keys and sensitive data.

## TL;DR

- Your private key **never leaves your machine**
- Your password **never leaves your machine**
- Only signatures and public addresses are sent to our API
- All code is open source - verify it yourself

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     YOUR MACHINE (Local)                        │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    MCP Server                            │   │
│  │                                                          │   │
│  │  wallet.js:                                              │   │
│  │  ├─ createWallet()  → generates key, encrypts, stores   │   │
│  │  ├─ signMessage()   → decrypts key, signs, returns sig  │   │
│  │  ├─ transfer()      → decrypts key, sends transaction   │   │
│  │  └─ collectFees()   → decrypts key, signs or sends tx   │   │
│  │                                                          │   │
│  │  data/wallets.json:                                      │   │
│  │  └─ { encrypted_private_key, salt, iv, tag }            │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              │ Only sends:                      │
│                              │ - Public address                 │
│                              │ - Signatures                     │
│                              │ - Signed messages                │
│                              ▼                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     VIBECOIN API (Remote)                       │
│                                                                 │
│  Receives:                    Never receives:                   │
│  ✓ Wallet address (public)    ✗ Private key                    │
│  ✓ Signed messages            ✗ Password                       │
│  ✓ Signatures                 ✗ Encrypted key material         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## What Stays Local

| Data | Storage Location | Encryption |
|------|------------------|------------|
| Private key | `mcp/data/wallets.json` | AES-256-GCM |
| Password | Never stored | N/A |
| Salt/IV/Tag | `mcp/data/wallets.json` | Plaintext (safe) |

## What Gets Sent to API

| Data | Why | Risk |
|------|-----|------|
| Wallet address | Identify your account | Public info (safe) |
| Signature | Prove you own the wallet | Cannot derive private key |
| Message content | What you're signing | You control this |
| Timestamp | Prevent replay attacks | Public info (safe) |

## Encryption Details

### Key Derivation
```
Password → PBKDF2 (100,000 iterations, SHA-256) → 256-bit key
```

### Encryption
```
Private Key + Key + Random IV → AES-256-GCM → Encrypted blob + Auth tag
```

### Storage Format
```json
{
  "userId": {
    "address": "0x...",
    "encryptedKey": {
      "salt": "random 32 bytes (hex)",
      "iv": "random 16 bytes (hex)",
      "tag": "auth tag (hex)",
      "encrypted": "encrypted private key (hex)"
    },
    "createdAt": "ISO timestamp"
  }
}
```

### File Permissions
```
wallets.json: 0o600 (read/write owner only)
data directory: 0o700 (owner only)
```

## Verify It Yourself

### 1. Check wallet.js never sends private keys

Look at `mcp/lib/wallet.js`:

```javascript
// Line ~77: createWallet() - key is encrypted immediately
const encryptedKey = encrypt(wallet.privateKey, password);

// Line ~165: signMessage() - key is decrypted locally, only signature returned
const signature = await wallet.signMessage(message);
return { signature }; // Private key not included

// Line ~242: transfer() - transaction sent directly to blockchain
const tx = await wallet.sendTransaction({ to, value });

// Line ~313: collectFees() - either signs locally or sends tx directly
const signature = await wallet.signMessage(message);
// Signature sent to API, not the key
```

### 2. Check API requests

Look at `mcp/lib/launcher.js`:

```javascript
// Line ~45: Only signature and message sent
const response = await fetch(`${apiBaseUrl}/api/launch`, {
  method: 'POST',
  body: JSON.stringify({
    walletAddress,  // Public
    message,        // What you signed
    signature,      // Proof of ownership
    name,
    symbol
  })
});
```

### 3. Check API never requests private data

Look at `api/routes/launch.js`:

```javascript
// API only verifies signatures, never asks for keys
const { walletAddress, message, signature } = req.body;
if (!verifySignature(walletAddress, message, signature)) {
  return res.status(401).json({ error: "Invalid signature" });
}
```

## Signature Verification

We use Ethereum's `personal_sign` standard:

```javascript
// Signing (local)
const signature = await wallet.signMessage(message);

// Verification (API)
const recoveredAddress = ethers.verifyMessage(message, signature);
const isValid = recoveredAddress === walletAddress;
```

This proves you own the private key without revealing it.

## Threat Model

### What we protect against

| Threat | Protection |
|--------|------------|
| API stealing your key | Key never sent to API |
| Database breach | We don't store your key |
| Man-in-the-middle | Signatures are useless without key |
| Replay attacks | Timestamps expire after 5 minutes |
| Brute force password | PBKDF2 with 100k iterations |
| Local file theft | AES-256-GCM encryption |

### What you must protect

| Your Responsibility | Why |
|---------------------|-----|
| Choose strong password | Weak password = weak encryption |
| Secure your machine | Local malware can read decrypted keys |
| Don't share password | No recovery if compromised |
| Backup wallet file | Lost file = lost wallet |

## Password Recovery

**There is no password recovery.**

- We don't know your password
- We can't decrypt your wallet
- We can't help you recover funds

If you lose your password, your wallet and all funds in it are **permanently inaccessible**.

## Auditing

This code is open source. We encourage:

1. **Code review** - Read the source before using
2. **Security audits** - Professional review welcome
3. **Bug reports** - Open issues for vulnerabilities
4. **Contributions** - PRs to improve security

## Reporting Vulnerabilities

If you find a security issue:

1. **Do not** open a public issue
2. Email: [security contact]
3. Include steps to reproduce
4. Allow time for fix before disclosure

## FAQ

### Can Vibecoin steal my funds?

No. We never have access to your private key. We can only interact with your wallet through signed messages that you approve.

### What if your API is hacked?

Attackers cannot steal your funds because:
- Your private key is not on our servers
- They cannot forge your signature
- They cannot create valid transactions

### What if my computer is hacked?

If malware has access to your machine:
- It could read the encrypted wallet file
- With a weak password, it could brute force
- With keylogger, it could capture your password

Use a strong password and keep your machine secure.

### Can I verify the MCP isn't modified?

Yes:
1. Install from source (not prebuilt)
2. Compare code hashes with repository
3. Audit `wallet.js` before first use
4. Check npm package integrity

### Why not use hardware wallets?

We may add hardware wallet support in the future. Current design prioritizes:
- Simplicity for AI-first interaction
- No additional hardware required
- Works in any environment

For large amounts, consider transferring to a hardware wallet.
