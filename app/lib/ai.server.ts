import Anthropic from "@anthropic-ai/sdk";
import db from "../db.server";

/**
 * Single entry point for model calls. Server-only (.server.ts): the API key never reaches the browser.
 * - structured JSON output
 * - every call logged per shop: prompt version, tokens, latency, error
 * - per-shop daily cost cap
 * - mock mode without ANTHROPIC_API_KEY
 */

const MODEL = process.env.LLM_MODEL || "claude-opus-5-5";
const PRICE = { input: 4, output: 20 }; // USD / 1M tokens
const DAILY_CAP = Number(process.env.AI_DAILY_BUDGET_USD_PER_SHOP || 2);

export class AiError extends Error {
  constructor(message: string, public kind: "budget" | "refusal" | "api" | "invalid_output") {
    super(message);
  }
}

export const isMockMode = () => !process.env.ANTHROPIC_API_KEY;
let client: Anthropic | null = null;

export async function spentToday(shopId: string) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const r = await db.aiCall.aggregate({ where: { shopId, createdAt: { gte: start } }, _sum: { costUsd: true } });
  return r._sum.costUsd ?? 0;
}

export const dailyCap = () => DAILY_CAP;

export async function callJson<T>(args: {
  shopId: string;
  promptId: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  mock: () => T;
}): Promise<T> {
  const started = Date.now();
  const log = (data: { inputTokens: number; outputTokens: number; error?: string; mode: "live" | "mock" }) =>
    db.aiCall.create({
      data: {
        shopId: args.shopId,
        promptId: args.promptId,
        promptVersion: args.promptVersion,
        model: MODEL,
        mode: data.mode,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        costUsd: (data.inputTokens * PRICE.input + data.outputTokens * PRICE.output) / 1_000_000,
        latencyMs: Date.now() - started,
        error: data.error,
      },
    });

  if (isMockMode()) {
    const out = args.mock();
    await log({ inputTokens: 0, outputTokens: 0, mode: "mock" });
    return out;
  }
  if ((await spentToday(args.shopId)) >= DAILY_CAP) {
    await log({ inputTokens: 0, outputTokens: 0, mode: "live", error: "daily_budget_exceeded" });
    throw new AiError("Today's AI limit for this store is reached. Try again tomorrow.", "budget");
  }

  let usage = { input_tokens: 0, output_tokens: 0 };
  try {
    client ??= new Anthropic();
    const msg = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: args.schema } },
        system: args.system,
        messages: [{ role: "user", content: args.user }],
      })
      .finalMessage();
    usage = msg.usage;
    if (msg.stop_reason === "refusal") throw new AiError("The AI declined this request.", "refusal");
    if (msg.stop_reason === "max_tokens") throw new AiError("The AI response was cut off.", "invalid_output");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new AiError("The AI returned an unreadable answer.", "invalid_output");
    }
    await log({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, mode: "live" });
    return parsed;
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError((err as Error).message, "api");
    await log({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, mode: "live", error: `${e.kind}: ${e.message}` });
    throw e;
  }
}
