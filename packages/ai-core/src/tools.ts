import type { Tool } from './index.js';

export const timeTool: Tool<{ timezone?: string }, { iso: string; timezone: string }> = {
  name: 'time.now',
  description: 'Return the current server time. Does not access external systems. Input: optional timezone string.',
  risk: 'low',
  async execute(input) {
    const timezone = input?.timezone ?? 'UTC';
    return { iso: new Date().toISOString(), timezone };
  }
};

type EchoInput = { text?: string; message?: string };

export const echoTool: Tool<EchoInput, { text: string }> = {
  name: 'text.echo',
  description: 'Echo validated text for pipeline and integration tests. Input must contain a string in text or message.',
  risk: 'low',
  async execute(input) {
    const text = typeof input?.text === 'string' ? input.text : input?.message;
    if (typeof text !== 'string' || text.length > 20000) throw new Error('INVALID_TEXT');
    return { text };
  }
};
