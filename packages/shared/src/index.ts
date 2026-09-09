export type AgentMode =
  | 'auto' | 'research' | 'fact-check' | 'deep-research' | 'vision'
  | 'browser' | 'computer-use' | 'trading' | 'chart' | 'probability'
  | 'simulation' | 'documents' | 'code' | 'news' | 'monitoring'
  | 'study' | 'custom';

export type TaskStatus = 'queued' | 'planning' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type Confidence = 'confirmed' | 'likely' | 'uncertain' | 'unsupported' | 'contradicted';

export interface AgentTask {
  id: string;
  workspaceId: string;
  prompt: string;
  mode: AgentMode;
  status: TaskStatus;
  maxIterations: number;
  budgetCents?: number;
}

export interface ToolCall {
  id: string;
  taskId: string;
  tool: string;
  input: unknown;
  output?: unknown;
  status: 'proposed' | 'approved' | 'running' | 'completed' | 'failed' | 'blocked';
}

export interface Evidence {
  id: string;
  sourceId: string;
  claimId?: string;
  excerpt: string;
  retrievedAt: string;
}

export interface Source {
  id: string;
  url: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  reliabilityScore?: number;
}
