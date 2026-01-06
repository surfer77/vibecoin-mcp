#!/usr/bin/env node

import 'dotenv/config';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createWallet, getWalletAddress, getBalance, transfer, collectFees } from "./lib/wallet.js";
import { launchCoin, getApiStatus } from "./lib/launcher.js";
import { getVestingInfo, claimVestedTokens } from "./lib/vesting.js";

// API endpoints - all on the Ponder indexer server
const API_BASE_URL = process.env.LAUNCHER_API_URL || 'http://localhost:42069';
const GRAPHQL_URL = process.env.GRAPHQL_URL || 'http://localhost:42069/graphql';

// Helper to query GraphQL
async function queryGraphQL(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0].message);
  }
  return result.data;
}

// Format wei to ETH with nice display
function formatEth(wei) {
  if (!wei) return '0 ETH';
  // Safely convert BigInt to number by using string conversion
  const weiStr = typeof wei === 'bigint' ? wei.toString() : String(wei);
  const eth = parseFloat(weiStr) / 1e18;
  if (eth === 0 || isNaN(eth)) return '0 ETH';
  if (eth < 0.0001) return `${eth.toExponential(2)} ETH`;
  if (eth < 1) return `${eth.toFixed(4)} ETH`;
  return `${eth.toFixed(2)} ETH`;
}

// JSON replacer to handle BigInt serialization
function jsonReplacer(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

// Safe JSON stringify that handles BigInt
function safeStringify(obj, indent = 2) {
  return JSON.stringify(obj, jsonReplacer, indent);
}

// Format timestamp to readable date
function formatTimestamp(ts) {
  if (!ts) return 'Never';
  // Handle BigInt timestamps safely
  const tsNum = typeof ts === 'bigint' ? parseInt(ts.toString(), 10) : Number(ts);
  const date = new Date(tsNum * 1000);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Format price (stored as scaled integer)
function formatPrice(price) {
  if (!price) return '$0.00';
  // Safely convert BigInt to number by using string conversion
  const priceStr = typeof price === 'bigint' ? price.toString() : String(price);
  const p = parseFloat(priceStr) / 1e18;
  if (p === 0) return '$0.00';
  if (p < 0.000001) return `$${p.toExponential(2)}`;
  if (p < 0.01) return `$${p.toFixed(6)}`;
  if (p < 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(2)}`;
}

// Format USD value for display
function formatUsd(value) {
  if (!value) return '$0.00';
  const valStr = typeof value === 'bigint' ? value.toString() : String(value);
  const v = parseFloat(valStr);
  if (v === 0 || isNaN(v)) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  if (v < 1000000) return `$${(v / 1000).toFixed(2)}K`;
  return `$${(v / 1000000).toFixed(2)}M`;
}

// Format a token for nice display
function formatToken(token, index = null) {
  const prefix = index !== null ? `${index + 1}. ` : '';
  const nameDisplay = token.name && token.symbol
    ? `${token.name} (${token.symbol})`
    : `${token.id.slice(0, 10)}...${token.id.slice(-8)}`;

  const lines = [
    `${prefix}${nameDisplay}`,
    `   Volume: ${formatUsd(token.totalVolumeUsd)} | Swaps: ${token.totalSwapCount}`,
    `   Price: ${formatUsd(token.currentPriceUsd)}`,
    `   Last Trade: ${formatTimestamp(token.lastSwapTimestamp)}`,
    `   Launched: ${formatTimestamp(token.launchTimestamp)}`,
  ];
  return lines.join('\n');
}

// Create server instance
const server = new Server(
  {
    name: "billionaire-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const TOOLS = [
  {
    name: "info",
    description: `Get information about Billionaire - the platform for launching coins on the Ethereum world computer.

Actions:
- platform: Overview of Billionaire, how it works, and why use it
- tokenomics: Token distribution, vesting, and supply details
- fees: Fee structure for launching and trading
- contracts: Smart contract addresses and chain info`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["platform", "tokenomics", "fees", "contracts"],
          description: "What info to retrieve: platform (overview), tokenomics (token details), fees (fee structure), contracts (addresses)",
        },
      },
      required: [],
    },
  },
  {
    name: "wallet",
    description: `Manage your local Ethereum wallet. This wallet receives your trading fees and signs transactions.

IMPORTANT: Your wallet is encrypted with a password. This is the ONLY way to access your wallet. If you lose your password, your wallet and funds are UNRECOVERABLE.

Actions:
- create: Create a new wallet (requires password you'll remember forever)
- get: Get your wallet address (no password needed)
- balance: Check your ETH balance
- transfer: Send ETH to another address (IRREVERSIBLE - shows warning before sending)
- collect-fees: Claim accumulated trading fees from the contract

INSTRUCTIONS FOR AI: A wallet is REQUIRED before launching a coin. If no wallet exists, don't ask the user if they want to create one - just prompt them for a password to create it. Explain that this password encrypts their wallet and must never be forgotten.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "balance", "transfer", "collect-fees"],
          description: "Action to perform",
        },
        password: {
          type: "string",
          description: "Wallet password (required for: create, transfer, collect-fees)",
        },
        toAddress: {
          type: "string",
          description: "Destination address (required for: transfer)",
        },
        amount: {
          type: "string",
          description: "Amount in ETH (required for: transfer)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "launch",
    description: `Deploy a new coin/token on Ethereum mainnet.

What happens:
1. Your coin is deployed with 1 billion total supply
2. You receive 49% (vested over 6 months)
3. 51% goes to the public trading pool
4. You earn 1% of every trade forever

Requirements:
- Must have a wallet (use wallet tool first)
- Password to sign the launch transaction
- Coin name
- Trading symbol (e.g., DOGE, PEPE)

Optional (but encouraged):
- URL: Project website
- GitHub: Source code repository
- Description: What your project does

INSTRUCTIONS FOR AI: When a user wants to launch a coin, ALWAYS prompt them for ALL fields in a friendly conversational way:
1. First ask for the coin name and symbol (required)
2. Then ask for the website URL (can be left empty)
3. Then ask for the GitHub repo (can be left empty)
4. Then ask for a brief description (can be left empty)
5. Finally, ask for their wallet password to sign the transaction

Make it clear which fields are optional and that they can skip them by leaving them empty. Be encouraging and helpful throughout the process.`,
    inputSchema: {
      type: "object",
      properties: {
        password: {
          type: "string",
          description: "Wallet password to sign the launch",
        },
        name: {
          type: "string",
          description: "Coin name",
        },
        symbol: {
          type: "string",
          description: "Trading symbol",
        },
        url: {
          type: "string",
          description: "Project website URL (optional but encouraged)",
        },
        github: {
          type: "string",
          description: "GitHub repository URL (optional but encouraged)",
        },
        description: {
          type: "string",
          description: "Brief description of your project (optional but encouraged)",
        },
      },
      required: ["password", "name", "symbol"],
    },
  },
  {
    name: "my-fees",
    description: `View your earnings from coin launches and trading.

Actions:
- summary: Total earnings across all your coins
- by-coin: Breakdown of earnings per coin you've launched`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "by-coin"],
          description: "View type: summary (totals) or by-coin (per-coin breakdown)",
        },
      },
      required: [],
    },
  },
  {
    name: "listings",
    description: `Browse coins launched on Billionaire.

Actions:
- all: View most active tokens in the past 24 hours (default)
- mine: View only your launched coins
- top: View top 10 coins by trading volume
- search: Search coins by token address`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["all", "mine", "top", "search"],
          description: "Browse mode: all (most active 24h), mine (your coins), top (by volume), search (by address)",
        },
        query: {
          type: "string",
          description: "Token address to search for (required for: search)",
        },
      },
      required: [],
    },
  },
  {
    name: "vesting",
    description: `Check and claim your vested tokens from coin launches.

When you launch a coin, you receive 49% of the total supply vested over 6 months. Use this tool to:
- Check how many tokens have vested and are available to claim
- Check how many tokens are still locked
- Claim your vested tokens

Actions:
- check: View vesting status for a specific token (requires tokenAddress)
- claim: Claim all available vested tokens (requires tokenAddress and password)

The vesting schedule releases tokens linearly over 6 months from the coin launch date.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["check", "claim"],
          description: "Action to perform: check (view vesting status) or claim (claim vested tokens)",
        },
        tokenAddress: {
          type: "string",
          description: "The token contract address to check or claim from",
        },
        password: {
          type: "string",
          description: "Wallet password (required for: claim)",
        },
      },
      required: ["action", "tokenAddress"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "info": {
        const { action = "platform" } = args;

        const infoData = {
          platform: {
            name: "Billionaire",
            website: "https://billionaires.com",
            tagline: "Launch your coin on Ethereum. Earn forever.",
            description: "Deploy your project's coin on Ethereum mainnet. Anyone can discover it, trade it, and support your project. You earn 1% of every trade, forever.",
            howItWorks: [
              "1. Create a wallet - this stores your private key locally and receives your trading fees",
              "2. Launch your coin - choose a name and symbol, sign the transaction",
              "3. Deployment - your coin is deployed to Ethereum mainnet with a bonding curve",
              "4. Discovery - the metaverse can find and trade your coin immediately",
              "5. Earn - you receive 1% of every trade, sent directly to your wallet"
            ],
            quickStart: "Use the 'wallet' tool to create a wallet, then 'launch' to deploy your coin."
          },
          tokenomics: {
            totalSupply: "1,000,000,000 (1 billion tokens)",
            distribution: {
              creator: "49% (490,000,000 tokens)",
              publicPool: "51% (510,000,000 tokens)"
            },
            vesting: {
              creatorTokens: "6 months linear vesting",
              releaseSchedule: "Tokens unlock proportionally each block over 6 months",
              claim: "Use wallet collect-fees action to claim vested tokens"
            },
            bondingCurve: {
              phase1: "First 250M tokens at fixed $0.01 per token",
              phase2: "Remaining tokens on bonding curve (price increases with demand)"
            }
          },
          fees: {
            launchFee: "Free (we pay gas)",
            tradingFee: "2% per trade",
            creatorShare: "1% of each trade goes to you (the creator)",
            platformShare: "1% goes to Billionaire platform",
            collection: "Fees accumulate on-chain. Use wallet collect-fees to claim.",
            gasForCollection: "If you have no ETH, we'll pay gas to collect your fees"
          },
          contracts: {
            network: "Ethereum Mainnet",
            chainId: 1,
            factoryAddress: "Deployed after mainnet launch",
            feeHookAddress: "Deployed after mainnet launch",
            uniswapV4Integration: "Coins launch with native Uniswap v4 liquidity",
            verified: "All contracts verified on Etherscan"
          }
        };

        const result = infoData[action] || infoData.platform;
        return {
          content: [{ type: "text", text: safeStringify(result) }],
        };
      }

      case "wallet": {
        const { action, password } = args;

        switch (action) {
          case "create": {
            if (!password) {
              return {
                content: [
                  {
                    type: "text",
                    text: safeStringify({
                        success: false,
                        error: "Password required to create wallet. This password encrypts your wallet where fees will be sent. IMPORTANT: Choose a password you will NEVER forget - there is NO recovery option. If you lose your password, your wallet and funds are gone forever!",
                      }),
                  },
                ],
                isError: true,
              };
            }
            const result = await createWallet(password);
            return {
              content: [
                { type: "text", text: safeStringify(result) },
              ],
            };
          }
          case "get": {
            const result = getWalletAddress();
            return {
              content: [
                { type: "text", text: safeStringify(result) },
              ],
            };
          }
          case "balance": {
            const result = await getBalance();
            return {
              content: [
                { type: "text", text: safeStringify(result) },
              ],
            };
          }
          case "transfer": {
            if (!password) {
              return {
                content: [
                  {
                    type: "text",
                    text: safeStringify({
                        success: false,
                        error: "Password required to transfer funds",
                      }),
                  },
                ],
                isError: true,
              };
            }
            const { toAddress, amount } = args;
            if (!toAddress || !amount) {
              return {
                content: [
                  {
                    type: "text",
                    text: safeStringify({
                        success: false,
                        error: "toAddress and amount are required for transfer",
                      }),
                  },
                ],
                isError: true,
              };
            }
            // Return warning first, requiring confirmation
            const transferResult = await transfer(password, toAddress, amount);
            if (transferResult.success) {
              transferResult.warning = "⚠️ This transfer is IRREVERSIBLE. The funds have been sent and cannot be recovered.";
            }
            return {
              content: [
                { type: "text", text: safeStringify(transferResult) },
              ],
            };
          }
          case "collect-fees": {
            if (!password) {
              return {
                content: [
                  {
                    type: "text",
                    text: safeStringify({
                        success: false,
                        error: "Password required to collect fees",
                      }),
                  },
                ],
                isError: true,
              };
            }
            const collectResult = await collectFees(password, GRAPHQL_URL);
            return {
              content: [
                { type: "text", text: safeStringify(collectResult) },
              ],
            };
          }
          default:
            return {
              content: [
                {
                  type: "text",
                  text: safeStringify({ error: `Unknown action: ${action}` }),
                },
              ],
              isError: true,
            };
        }
      }

      case "launch": {
        const { password, name: coinName, symbol, url, github, description } = args;

        if (!password) {
          return {
            content: [
              {
                type: "text",
                text: safeStringify({
                    success: false,
                    error: "Password required to sign launch request",
                  }),
              },
            ],
            isError: true,
          };
        }

        const result = await launchCoin({
          password,
          name: coinName,
          symbol,
          url,
          github,
          description,
        });

        // Add API status info
        const apiStatus = await getApiStatus();
        result.apiStatus = apiStatus;

        return {
          content: [{ type: "text", text: safeStringify(result) }],
        };
      }

      case "my-fees": {
        const { action = "summary" } = args;

        // Get wallet address
        const walletResult = getWalletAddress();
        if (!walletResult.success || !walletResult.address) {
          return {
            content: [{ type: "text", text: safeStringify({ success: false, error: "No wallet found. Create a wallet first." }) }],
            isError: true,
          };
        }

        const creatorAddress = walletResult.address.toLowerCase();

        try {
          // Query tokens created by this user with fee data, plus ETH price
          const data = await queryGraphQL(`
            query MyFees($creator: String!) {
              tokens(
                where: { creator: $creator }
                orderBy: "totalEthFeesAccumulated"
                orderDirection: "desc"
                limit: 100
              ) {
                items {
                  id
                  name
                  symbol
                  totalEthFeesAccumulated
                  totalFeesCollected
                  totalSwapCount
                  totalVolumeUsd
                }
              }
              ethPriceCache(id: "current") {
                priceUsd
                lastUpdated
              }
            }
          `, { creator: creatorAddress });

          const tokens = data.tokens?.items || [];
          const ethPrice = data.ethPriceCache?.priceUsd || 0;

          // Helper to convert ETH (wei) to USD
          const ethToUsd = (weiAmount) => {
            if (!weiAmount || !ethPrice) return null;
            const weiStr = typeof weiAmount === 'bigint' ? weiAmount.toString() : String(weiAmount);
            const eth = parseFloat(weiStr) / 1e18;
            return eth * ethPrice;
          };

          // Calculate totals
          let totalAccumulated = BigInt(0);
          let totalCollected = BigInt(0);
          let totalSwaps = 0;

          const coinBreakdown = tokens.map(token => {
            const accumulated = BigInt(token.totalEthFeesAccumulated || '0');
            const collected = BigInt(token.totalFeesCollected || '0');
            const pending = accumulated - collected;

            totalAccumulated += accumulated;
            totalCollected += collected;
            // Safely convert BigInt to number
            const swapCount = token.totalSwapCount || 0;
            totalSwaps += typeof swapCount === 'bigint' ? parseInt(swapCount.toString(), 10) : Number(swapCount);

            const tokenName = token.name && token.symbol
              ? `${token.name} (${token.symbol})`
              : token.id;

            const result = {
              token: tokenName,
              tokenAddress: token.id,
              totalEarned: formatEth(accumulated.toString()),
              collected: formatEth(collected.toString()),
              pending: formatEth(pending.toString()),
              swapCount: token.totalSwapCount,
              volume: formatUsd(token.totalVolumeUsd)
            };

            // Add USD values if ETH price is available
            if (ethPrice) {
              result.totalEarnedUsd = formatUsd(ethToUsd(accumulated));
              result.collectedUsd = formatUsd(ethToUsd(collected));
              result.pendingUsd = formatUsd(ethToUsd(pending));
            }

            return result;
          });

          const totalPending = totalAccumulated - totalCollected;

          let result;
          if (action === "by-coin") {
            result = {
              success: true,
              action: "by-coin",
              description: "Earnings breakdown by coin",
              wallet: walletResult.address,
              coins: coinBreakdown,
              totalCoins: tokens.length
            };
            if (ethPrice) {
              result.ethPriceUsd = ethPrice;
            }
          } else {
            result = {
              success: true,
              action: "summary",
              description: "Total earnings summary",
              wallet: walletResult.address,
              totalEarned: formatEth(totalAccumulated.toString()),
              totalCollected: formatEth(totalCollected.toString()),
              pendingFees: formatEth(totalPending.toString()),
              totalCoins: tokens.length,
              totalTrades: totalSwaps,
              note: "Use action='by-coin' to see per-coin breakdown. Use wallet collect-fees to claim pending fees."
            };
            // Add USD values if ETH price is available
            if (ethPrice) {
              result.totalEarnedUsd = formatUsd(ethToUsd(totalAccumulated));
              result.totalCollectedUsd = formatUsd(ethToUsd(totalCollected));
              result.pendingFeesUsd = formatUsd(ethToUsd(totalPending));
              result.ethPriceUsd = ethPrice;
            }
          }

          return {
            content: [{ type: "text", text: safeStringify(result) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: safeStringify({ success: false, error: `Failed to fetch fees: ${err.message}` }) }],
            isError: true,
          };
        }
      }

      case "listings": {
        const { action = "all", query } = args;

        try {
          // Calculate 24h ago timestamp
          const twentyFourHoursAgo = Math.floor(Date.now() / 1000) - 86400;

          let tokens = [];
          let title = '';
          let description = '';

          switch (action) {
            case "mine": {
              // Get wallet address
              const walletResult = getWalletAddress();
              if (!walletResult.success || !walletResult.address) {
                return {
                  content: [{
                    type: "text",
                    text: safeStringify({
                      success: false,
                      error: "No wallet found. Create a wallet first."
                    })
                  }],
                  isError: true,
                };
              }

              const creatorAddress = walletResult.address.toLowerCase();
              const data = await queryGraphQL(`
                query MyTokens($creator: String!) {
                  tokens(
                    where: { creator: $creator }
                    orderBy: "launchTimestamp"
                    orderDirection: "desc"
                    limit: 50
                  ) {
                    items {
                      id
                      name
                      symbol
                      creator
                      launchTimestamp
                      totalVolumeUsd
                      totalSwapCount
                      lastSwapTimestamp
                      currentPriceUsd
                      totalEthFeesAccumulated
                      totalFeesCollected
                    }
                  }
                }
              `, { creator: creatorAddress });

              tokens = data.tokens?.items || [];
              title = 'YOUR LAUNCHED TOKENS';
              description = `Wallet: ${walletResult.address}`;
              break;
            }

            case "top": {
              const data = await queryGraphQL(`
                query TopTokens {
                  tokens(
                    orderBy: "totalVolumeUsd"
                    orderDirection: "desc"
                    limit: 10
                  ) {
                    items {
                      id
                      name
                      symbol
                      creator
                      launchTimestamp
                      totalVolumeUsd
                      totalSwapCount
                      lastSwapTimestamp
                      currentPriceUsd
                    }
                  }
                }
              `);

              tokens = data.tokens?.items || [];
              title = 'TOP 10 TOKENS BY VOLUME';
              description = 'Ranked by all-time trading volume';
              break;
            }

            case "search": {
              if (!query) {
                return {
                  content: [{
                    type: "text",
                    text: safeStringify({
                      success: false,
                      error: "query (token address) is required for 'search' action"
                    })
                  }],
                  isError: true,
                };
              }

              const searchAddr = query.toLowerCase();
              const data = await queryGraphQL(`
                query SearchToken($id: String!) {
                  token(id: $id) {
                    id
                    name
                    symbol
                    creator
                    launchTimestamp
                    totalVolumeUsd
                    totalSwapCount
                    lastSwapTimestamp
                    currentPriceUsd
                    totalEthFeesAccumulated
                    totalFeesCollected
                  }
                }
              `, { id: searchAddr });

              tokens = data.token ? [data.token] : [];
              title = 'SEARCH RESULTS';
              description = `Query: ${query}`;
              break;
            }

            case "all":
            default: {
              // Get tokens with activity in the last 24 hours, ordered by most recent activity
              const data = await queryGraphQL(`
                query ActiveTokens {
                  tokens(
                    where: { lastSwapTimestamp_gte: "${twentyFourHoursAgo}" }
                    orderBy: "lastSwapTimestamp"
                    orderDirection: "desc"
                    limit: 20
                  ) {
                    items {
                      id
                      name
                      symbol
                      creator
                      launchTimestamp
                      totalVolumeUsd
                      totalSwapCount
                      lastSwapTimestamp
                      currentPriceUsd
                    }
                  }
                }
              `);

              tokens = data.tokens?.items || [];
              title = 'MOST ACTIVE TOKENS (24H)';
              description = tokens.length > 0
                ? `${tokens.length} tokens with trading activity in the last 24 hours`
                : 'No trading activity in the last 24 hours';
              break;
            }
          }

          // Format the output nicely
          const output = [];
          output.push('═'.repeat(50));
          output.push(`  ${title}`);
          output.push('═'.repeat(50));
          output.push(description);
          output.push('');

          if (tokens.length === 0) {
            output.push('  No tokens found.');
          } else {
            tokens.forEach((token, idx) => {
              output.push(formatToken(token, idx));
              output.push('');
            });
          }

          output.push('─'.repeat(50));
          output.push(`Total: ${tokens.length} token(s)`);

          return {
            content: [{ type: "text", text: output.join('\n') }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: safeStringify({
                success: false,
                error: `Failed to fetch listings: ${err.message}`
              })
            }],
            isError: true,
          };
        }
      }

      case "vesting": {
        const { action, tokenAddress, password } = args;

        if (!tokenAddress) {
          return {
            content: [{
              type: "text",
              text: safeStringify({
                success: false,
                error: "tokenAddress is required. Use the 'listings' tool with action='mine' to see your launched tokens."
              })
            }],
            isError: true,
          };
        }

        switch (action) {
          case "check": {
            const result = await getVestingInfo(tokenAddress);
            return {
              content: [{ type: "text", text: safeStringify(result) }],
            };
          }
          case "claim": {
            if (!password) {
              return {
                content: [{
                  type: "text",
                  text: safeStringify({
                    success: false,
                    error: "Password required to claim vested tokens"
                  })
                }],
                isError: true,
              };
            }
            const result = await claimVestedTokens(password, tokenAddress);
            return {
              content: [{ type: "text", text: safeStringify(result) }],
            };
          }
          default:
            return {
              content: [{
                type: "text",
                text: safeStringify({ error: `Unknown vesting action: ${action}. Use 'check' or 'claim'.` })
              }],
              isError: true,
            };
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: safeStringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: safeStringify({ error: error.message }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Billionaire MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
