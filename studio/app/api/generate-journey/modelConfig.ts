export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

type Env = Record<string, string | undefined>;

// AI generation is configured only when all three are set.
export function parseModelConfig(env: Env): ModelConfig | null {
  const apiKey = env.OPENAI_API_KEY;
  const baseUrl = env.OPENAI_API_BASE;
  const model = env.LLM_MODEL;
  return apiKey && baseUrl && model ? { apiKey, baseUrl, model } : null;
}
