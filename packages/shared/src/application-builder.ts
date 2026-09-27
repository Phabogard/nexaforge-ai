export type ApplicationProjectStatus =
  | 'draft'
  | 'building'
  | 'ready'
  | 'failed'
  | 'archived';

export interface ApplicationProject {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: ApplicationProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationProjectVersion {
  id: string;
  projectId: string;
  version: number;
  blueprint: Record<string, unknown>;
  createdAt: string;
}

export interface ApplicationArtifact {
  id: string;
  projectVersionId: string;
  path: string;
  kind: 'source' | 'config' | 'asset' | 'generated';
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}
