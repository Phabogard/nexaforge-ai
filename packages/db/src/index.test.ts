import { describe, expect, it } from 'vitest';
import { createTaskRepository } from './index.js';

describe('packages/db createTaskRepository', () => {
  it('returns null when DATABASE_URL is not provided', () => {
    const repo = createTaskRepository('');
    expect(repo).toBeNull();
  });
});

import { createPermissionRepository, createApplicationRepository } from './index.js';

describe('packages/db repositories without database URL', () => {
  it('returns null when database URL is missing', () => {
    expect(createPermissionRepository('')).toBeNull();
    expect(createApplicationRepository('')).toBeNull();
  });
});
