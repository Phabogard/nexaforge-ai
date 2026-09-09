import type { ModelProvider } from './index';

/** Safe default: never fabricates an LLM response when no provider is configured. */
export class UnconfiguredModelProvider implements ModelProvider {
  async generate(): Promise<string> {
    throw new Error('MODEL_PROVIDER_NOT_CONFIGURED');
  }
}
