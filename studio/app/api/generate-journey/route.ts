import { NextResponse } from 'next/server';
import { getSession } from '@/shared/auth/session';
import { parseGeneratedJourney, SYSTEM_PROMPT } from './generatedJourney';
import { parseModelConfig, type ModelConfig } from './modelConfig';
import { createRateLimiter, parseRateLimits, type RateLimits } from './rateLimit';

const MAX_PROMPT_LENGTH = 2000;

// Long enough for a model to write a journey, short enough that the modal does not spin on.
const MODEL_TIMEOUT_MS = 60_000;

// Per process: each replica counts on its own, and a restart clears the counts.
const rateLimiter = createRateLimiter();

function rateLimits(): RateLimits | null {
  try {
    return parseRateLimits(process.env);
  } catch (error) {
    console.error("AI journey generation has an invalid rate limit:", error);
    return null;
  }
}

function parsePrompt(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const prompt = (body as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string") return null;
  const trimmed = prompt.trim();
  return trimmed !== "" && trimmed.length <= MAX_PROMPT_LENGTH ? trimmed : null;
}

// The message text of an OpenAI-compatible chat completion.
function replyContent(reply: unknown): string {
  const choices = (reply as { choices?: unknown } | null)?.choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
  const content = first?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Model reply has no message content.");
  }
  return content;
}

async function askModel(config: ModelConfig, prompt: string): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0.1
    }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });

  // Only the status: some providers echo a masked copy of the key in the error body.
  if (!response.ok) {
    throw new Error(`Model endpoint returned ${response.status}.`);
  }
  return replyContent(await response.json());
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

function failure(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Every failure returns a fixed message. The detail, which may hold the provider's error text,
// goes only to the server log.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return failure(401, "Unauthorized");
  }

  const prompt = parsePrompt(await req.json().catch(() => null));
  if (prompt === null) {
    return failure(400, `Prompt must be text of at most ${MAX_PROMPT_LENGTH} characters.`);
  }

  const config = parseModelConfig(process.env);
  if (!config) {
    console.error("AI journey generation needs OPENAI_API_KEY, OPENAI_API_BASE, and LLM_MODEL.");
    return failure(503, "AI generation is not configured.");
  }

  const limits = rateLimits();
  if (!limits) {
    return failure(503, "AI generation is not configured.");
  }

  // Counted before the model call, so a call that fails or times out still uses the quota.
  const decision = rateLimiter.take(session.userId, limits);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Too many AI generation requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
    );
  }

  let content: string;
  try {
    content = await askModel(config, prompt);
  } catch (error) {
    console.error("The model call for AI journey generation failed:", error);
    return isTimeout(error)
      ? failure(504, "The model took too long to answer. Try again.")
      : failure(502, "The model could not generate a journey. Try again later.");
  }

  try {
    return NextResponse.json(parseGeneratedJourney(content));
  } catch (error) {
    console.error("The model returned a journey that is not valid:", error, content);
    return failure(502, "The model returned a journey that is not valid. Try again or rephrase the prompt.");
  }
}
