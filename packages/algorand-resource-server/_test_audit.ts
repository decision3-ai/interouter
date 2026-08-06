/**
 * Ephemeral test — run audit logic directly, bypassing Express/payment middleware.
 * Delete after use.
 */
import { TOOL_CATALOG } from "./catalog.js";

const AUDIT_SYSTEM_PROMPT = `You are an AI agent tool auditor. Analyze the agent's current task and tools, then identify capability gaps and recommend tools from the provided catalog.

CRITICAL: Output ONLY valid JSON. No markdown code fences, no backticks, no explanatory text before or after. Your entire response must be parseable by JSON.parse().

Tool catalog — use ONLY the install_command and source_url values from this list. Do not invent or guess URLs or commands:
${JSON.stringify(TOOL_CATALOG, null, 2)}

Required output structure:
{
  "gaps_identified": [{ "capability_missing": "string", "reasoning": "string" }],
  "recommendations": [{ "name": "string", "category": "string", "recommend_when": "string", "install_command": "string", "source_url": "string" }],
  "confidence": "high | medium | low"
}

Rules:
1. gaps_identified must always have at least one entry. If no gap exists, explain why (e.g. { "capability_missing": "none", "reasoning": "tools already cover known categories" }).
2. recommendations must only contain tools from the catalog above. If no catalog tool addresses the gaps, set recommendations to [].
3. confidence: "high" if task and tools clearly reveal a gap, "medium" if ambiguous, "low" if insufficient context.`;

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY not set");
  process.exit(1);
}

const input = {
  task: "Implementing a new blockchain payment adapter from scratch — writing code, running tests, debugging failures",
  current_tools: [
    { name: "Bash", description: "Run shell commands" },
    { name: "Read", description: "Read files from disk" },
    { name: "Edit", description: "Edit source files" },
    { name: "Grep", description: "Search file contents" },
  ],
};

console.log("Input:", JSON.stringify(input, null, 2));
console.log("\nCalling DeepSeek...\n");

const dsRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "deepseek-chat",
    messages: [
      { role: "system", content: AUDIT_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ],
  }),
});

if (!dsRes.ok) {
  console.error("DeepSeek error:", dsRes.status, await dsRes.text());
  process.exit(1);
}

const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
const raw = data.choices[0]?.message.content ?? "";
const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

try {
  const audit = JSON.parse(stripped);
  console.log("Output:", JSON.stringify(audit, null, 2));
} catch {
  console.error("JSON parse failed. Raw response:");
  console.error(raw);
}
