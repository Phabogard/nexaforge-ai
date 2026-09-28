import type { ModelProvider } from './index.js';
import type { ProjectBlueprint } from './application-builder.js';

export interface ApplicationReviewIssue {
  severity: 'error' | 'warning';
  area: 'architecture' | 'security' | 'correctness' | 'testing' | 'runtime' | 'ux';
  message: string;
  suggestedFix?: string;
}
export interface ApplicationReviewResult {
  approved: boolean;
  summary: string;
  issues: ApplicationReviewIssue[];
}
export interface ApplicationReviewRequest {
  prompt: string;
  blueprint: ProjectBlueprint;
  codingEvidence: unknown;
  verificationEvidence?: unknown;
}

function parseReview(raw: string): ApplicationReviewResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_APPLICATION_REVIEW'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_APPLICATION_REVIEW');
  const value = parsed as Record<string, unknown>;
  const issues = Array.isArray(value.issues) ? value.issues.map((item): ApplicationReviewIssue => {
    if (!item || typeof item !== 'object') throw new Error('INVALID_APPLICATION_REVIEW_ISSUE');
    const issue = item as Record<string, unknown>;
    const severity = issue.severity === 'warning' ? 'warning' : issue.severity === 'error' ? 'error' : undefined;
    const area = ['architecture','security','correctness','testing','runtime','ux'].includes(String(issue.area))
      ? String(issue.area) as ApplicationReviewIssue['area'] : undefined;
    if (!severity || !area || typeof issue.message !== 'string' || !issue.message.trim()) throw new Error('INVALID_APPLICATION_REVIEW_ISSUE');
    return { severity, area, message: issue.message.trim(), suggestedFix: typeof issue.suggestedFix === 'string' ? issue.suggestedFix : undefined };
  }) : [];
  return {
    approved: value.approved === true && !issues.some(issue => issue.severity === 'error'),
    summary: typeof value.summary === 'string' ? value.summary : 'Application review completed.',
    issues
  };
}

export function createApplicationReviewer(model: ModelProvider) {
  return {
    async review(request: ApplicationReviewRequest): Promise<ApplicationReviewResult> {
      const raw = await model.generate({
        system: [
          'You are the NexaForge Application Reviewer.',
          'Review the generated application plan and execution evidence as an independent quality gate.',
          'Do not invent files, test results, runtime behavior, dependencies or tool results.',
          'Identify concrete blocking defects only when supported by evidence.',
          'Security concerns include secret leakage, unsafe commands, path traversal, and unnecessary privileges.',
          'Return ONLY JSON: {"approved":true|false,"summary":"...","issues":[{"severity":"error|warning","area":"architecture|security|correctness|testing|runtime|ux","message":"...","suggestedFix":"..."}]}',
          'An application may be approved with warnings when there is no evidence of a blocking defect.'
        ].join('\n'),
        messages: [{ role: 'user', content: [
          'REQUEST:', request.prompt,
          'BLUEPRINT:', JSON.stringify(request.blueprint),
          'CODING EVIDENCE:', JSON.stringify(request.codingEvidence).slice(0, 80000),
          'VERIFICATION EVIDENCE:', JSON.stringify(request.verificationEvidence ?? {}).slice(0, 50000)
        ].join('\n\n') }]
      });
      return parseReview(raw);
    }
  };
}
