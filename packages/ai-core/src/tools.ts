import type { Tool } from './index';

export const timeTool: Tool<{ timezone?: string }, { iso: string; timezone: string }> = {
  name: 'time.now',
  description: 'Return the current server time. Does not access external systems.',
  risk: 'low',
  async execute(input) {
    const timezone = input?.timezone ?? 'UTC';
    return { iso: new Date().toISOString(), timezone };
  }
};

export const echoTool: Tool<{ text: string }, { text: string }> = {
  name: 'text.echo',
  description: 'Echo validated text for pipeline and integration tests.',
  risk: 'low',
  async execute(input) {
    if (!input || typeof input.text !== 'string' || input.text.length > 20000) throw new Error('INVALID_TEXT');
    return { text: input.text };
  }
};
