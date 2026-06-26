/**
 * Ollama REST API client
 * Connects to the Ollama instance on Pi 5 (localhost:11434)
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const FAST_MODEL = process.env.OLLAMA_FAST_MODEL || 'qwen2.5:3b';

export interface OllamaRequest {
  model?: string;
  prompt?: string;
  system?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
  format?: 'json';
  keep_alive?: string;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    num_ctx?: number;
    repeat_penalty?: number;
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
    keep_alive: '10m',
    options: {
      temperature: temperature ?? 0.8,
      num_predict: maxTokens ?? 256,
      num_ctx: 4096,
      repeat_penalty: 1.12,
      top_k: 40,
      top_p: 0.92,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as OllamaResponse;
  return data.response || '';
}

/** Streaming generation — calls onChunk for each token as it arrives, returns full text */
export async function generateStream(params: {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  onChunk: (chunk: string) => void;
  timeoutMs?: number;
}): Promise<string> {
  const { prompt, system, model, temperature, maxTokens, onChunk, timeoutMs = 60_000 } = params;

  const body = {
    model: model || DEFAULT_MODEL,
    prompt,
    system,
    stream: true,
    keep_alive: '10m',
    options: {
      temperature: temperature ?? 0.8,
      num_predict: maxTokens ?? 200,
      num_ctx: 4096,
      repeat_penalty: 1.12,
      top_k: 40,
      top_p: 0.92,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let full = '';
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) throw new Error(`Ollama stream error: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { response?: string; done?: boolean };
          if (parsed.response) {
            full += parsed.response;
            onChunk(parsed.response);
          }
          if (parsed.done) break;
        } catch (_) { /* skip malformed lines */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return full;
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
    keep_alive: '10m',
    options: {
      temperature: temperature ?? 0.8,
      num_predict: maxTokens ?? 256,
      num_ctx: 4096,
      repeat_penalty: 1.12,
      top_k: 40,
      top_p: 0.92,
    },
  };

  const chatController = new AbortController();
  const chatTimeout = setTimeout(() => chatController.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: chatController.signal,
    });
  } finally {
    clearTimeout(chatTimeout);
  }

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
