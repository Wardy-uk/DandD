/**
 * Ollama REST API client
 * Connects to the Ollama instance on Pi 5 (localhost:11434)
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL || 'qwen2.5:3b';

export interface OllamaRequest {
  model?: string;
  prompt?: string;
  system?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
  format?: 'json';
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaResponse {
  model: string;
  response?: string;
  message?: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

/** Generate a completion (non-chat mode) */
export async function generate(params: {
  prompt: string;
  system?: string;
  model?: string;
  format?: 'json';
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { prompt, system, model, format, temperature, maxTokens } = params;

  const body: OllamaRequest = {
    model: model || DEFAULT_MODEL,
    prompt,
    system,
    stream: false,
    format,
    options: {
      temperature: temperature ?? 0.8,
      num_predict: maxTokens ?? 1024,
    },
  };

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as OllamaResponse;
  return data.response || '';
}

/** Chat completion (multi-turn) */
export async function chat(params: {
  messages: { role: string; content: string }[];
  model?: string;
  format?: 'json';
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const { messages, model, format, temperature, maxTokens } = params;

  const body: OllamaRequest = {
    model: model || DEFAULT_MODEL,
    messages,
    stream: false,
    format,
    options: {
      temperature: temperature ?? 0.8,
      num_predict: maxTokens ?? 1024,
    },
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as OllamaResponse;
  return data.message?.content || '';
}

/** Quick generation with the fast/small model (for simple decisions) */
export async function quickGenerate(prompt: string, system?: string): Promise<string> {
  return generate({ prompt, system, model: FAST_MODEL, maxTokens: 256 });
}

/** Check if Ollama is reachable */
export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

/** List available models */
export async function listModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json() as { models: { name: string }[] };
    return data.models.map(m => m.name);
  } catch {
    return [];
  }
}
