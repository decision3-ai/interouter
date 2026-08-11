#!/usr/bin/env node
/**
 * D3RCP MCP server — exposes POST /api/audit as an MCP tool.
 *
 * Handles the full AlgorandAdapter payment lifecycle internally (readState →
 * preparePayment → sign → submit → awaitFinality). The calling agent sees a
 * single tool call; payment is invisible.
 *
 * Install dependency (once):
 *   npm install @modelcontextprotocol/sdk
 *
 * Add to claude_desktop_config.json (or equivalent MCP config):
 *   {
 *     "mcpServers": {
 *       "d3rcp-audit": {
 *         "command": "npx",
 *         "args": ["tsx", "/absolute/path/to/mcp-audit-server.ts"],
 *         "env": {
 *           "ALGORAND_MNEMONIC": "<25-word buyer mnemonic>",
 *           "AUDIT_ENDPOINT": "http://<host>:4021/api/audit"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AlgorandAdapter } from "@decision3/interouter-core";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";

const AUDIT_ENDPOINT = process.env.AUDIT_ENDPOINT;
const ALGOD_URL = process.env.ALGOD_URL ?? "https://mainnet-api.algonode.cloud";

if (!AUDIT_ENDPOINT) {
  console.error("AUDIT_ENDPOINT is not set — set it in the MCP server env config");
  process.exit(1);
}

// ── MCP server setup ──────────────────────────────────────────────────────
const server = new Server(
  { name: "d3rcp-audit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── Tool: audit_agent_tools ───────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "audit_agent_tools",
      description:
        "Analyze what an AI agent is currently doing and what tools it has. " +
        "Identifies capability gaps and recommends tools from the D3RCP catalog. " +
        "Costs 0.01 USDC on Algorand mainnet per call — paid automatically from the configured wallet.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task: {
            type: "string",
            description: "One sentence describing what the agent is currently doing or trying to accomplish.",
          },
          current_tools: {
            type: "array",
            description: "Tools the agent currently has available.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
              },
              required: ["name", "description"],
            },
          },
          context: {
            type: "string",
            description: "Optional: additional context about the agent's environment or constraints.",
          },
        },
        required: ["task", "current_tools"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "audit_agent_tools") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const mnemonic = process.env.ALGORAND_MNEMONIC;
  if (!mnemonic) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: "ALGORAND_MNEMONIC is not set in MCP server environment" }) }],
      isError: true,
    };
  }

  const { task, current_tools, context } = request.params.arguments as {
    task: string;
    current_tools: Array<{ name: string; description: string }>;
    context?: string;
  };

  const adapter = new AlgorandAdapter({
    mnemonic,
    resourceEndpoint: AUDIT_ENDPOINT!,
    algodUrl: ALGOD_URL,
    network: ALGORAND_MAINNET_CAIP2,
    requestMethod: "POST",
    requestBody: {
      task,
      current_tools,
      ...(context !== undefined ? { context } : {}),
    },
  });

  const ctx = { path: "/api/audit", params: {} };

  try {
    // Stage 1 — probe endpoint, retrieve 402 payment requirement
    const { paymentRequired } = await adapter.readState(ctx);
    if (!paymentRequired) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Endpoint did not return a payment requirement — check AUDIT_ENDPOINT" }) }],
        isError: true,
      };
    }

    // Stages 2–4 — prepare, sign, submit
    const payload = await adapter.preparePayment(paymentRequired);
    const signed  = await adapter.sign(payload);
    const submission = await adapter.submit(signed, ctx);

    if (!submission.accepted) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Payment not accepted by facilitator" }) }],
        isError: true,
      };
    }

    // Stage 5 — await on-chain finality (audit data already in responseData)
    await adapter.awaitFinality(submission);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(submission.responseData) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
