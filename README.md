# Vibecoin MCP

An MCP (Model Context Protocol) server that lets AI assistants launch coins on Ethereum and manage crypto wallets.

## What is this?

This server connects AI assistants (like Claude) to the [Vibecoin](https://vibecoins.com) platform, enabling:

- **Wallet Management** - Create encrypted Ethereum wallets, check balances, transfer ETH
- **Coin Launching** - Deploy ERC-20 tokens on Ethereum with built-in liquidity
- **Fee Collection** - Earn 1% of every trade on coins you launch, forever
- **Listings** - Browse and search all launched coins

## Installation

### With Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "vibecoin": {
      "command": "npx",
      "args": ["github:surfer77/vibecoin-mcp"]
    }
  }
}
```

### With Claude Code

```bash
claude mcp add vibecoin -- npx github:surfer77/vibecoin-mcp
```

### Manual Installation

```bash
git clone https://github.com/surfer77/vibecoin-mcp.git
cd vibecoin-mcp
npm install
npm start
```

Then add to Claude Desktop config:
```json
{
  "mcpServers": {
    "vibecoin": {
      "command": "node",
      "args": ["/path/to/vibecoin-mcp/index.js"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `info` | Platform overview, tokenomics, fees, and contract addresses |
| `wallet` | Create wallet, check balance, transfer ETH, collect fees |
| `launch` | Deploy a new coin on Ethereum mainnet |
| `my-fees` | View earnings from your launched coins |
| `listings` | Browse all coins, search, or filter by top market cap |

## How Coin Launches Work

1. **Create a wallet** - Your private key is encrypted locally with a password
2. **Launch your coin** - Pick a name and symbol (e.g., "DogeCoin", "DOGE")
3. **Automatic deployment** - 1 billion tokens created with Uniswap v4 liquidity
4. **Earn forever** - You get 1% of every trade on your coin

### Token Distribution

- **49%** to you (vested over 6 months)
- **51%** to public trading pool

## Environment Variables (Optional)

All defaults are pre-configured. You only need these if you want to override:

| Variable | Default | Description |
|----------|---------|-------------|
| `LAUNCHER_API_URL` | `https://vibecoin.up.railway.app` | Vibecoin API endpoint |
| `RPC_URL` | Sepolia RPC | Ethereum RPC endpoint |

## Security

- Wallets are encrypted with AES-256
- Private keys never leave your machine
- Passwords are never stored or transmitted
- See [SECURITY.md](SECURITY.md) for details

## License

MIT
