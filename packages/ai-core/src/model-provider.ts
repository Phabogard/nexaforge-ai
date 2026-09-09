import type { ModelProvider } from './index';

export class UnconfiguredModelProvider implements ModelProvider {
  async generate(): Promise<string> {
    throw new Error('MODEL_PROVIDER_NOT_CONFIGURED');
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly options: { baseUrl: string; apiKey: string; model: string; timeoutMs?: number }) {}

  async generate(input: { system: string; messages: Array<{ role: string; content: string }> }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);
    try {
      const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            { role: 'system', content: input.system },
            ...input.messages.map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }))
          ],
          temperature: 0
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`MODEL_HTTP_${response.status}`);
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('MODEL_EMPTY_RESPONSE');
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createConfiguredModelProvider(): ModelProvider {
  const baseUrl = process.env.MODEL_BASE_URL;
  const apiKey = process.env.MODEL_API_KEY;
  const model = process.env.MODEL_NAME;
  if (!baseUrl || !apiKey || !model) throw new Error('MODEL_PROVIDER_NOT_CONFIGURED');
  return new OpenAICompatibleProvider({ baseUrl, apiKey, model });
}
