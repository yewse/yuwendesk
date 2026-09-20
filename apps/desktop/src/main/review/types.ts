export type ReviewSeverity = 'blocking' | 'fix' | 'teacher_review' | 'info';

export type ReturnModule =
  | 'M01'
  | 'M02'
  | 'M03'
  | 'M04'
  | 'M05'
  | 'M06'
  | 'M07'
  | 'M08'
  | 'M09'
  | 'M10'
  | 'M11'
  | 'M12';

export interface ReviewIssue {
  issue_id: string;
  severity: ReviewSeverity;
  rule_id: string;
  object_ids: string[];
  message: string;
  evidence: string;
  return_module: ReturnModule;
  verification_type: 'deterministic' | 'model_assisted' | 'human_observation';
  status: 'open' | 'fixed' | 'accepted_with_limit';
}

export interface ReviewReport {
  report_id: string;
  plan_revision_id: string;
  issues: ReviewIssue[];
  disposition: 'ready_for_teacher' | 'needs_fix' | 'blocked';
  executed_checks: string[];
  not_executed_checks: string[];
  is_effectiveness_proof: false;
}

export interface ReviewIds {
  reportId(): string;
  issueId(ruleId: string, objectIds: string[]): string;
}

export interface ReviewOptions {
  ids: ReviewIds;
  modelIssues?: ReviewIssue[];
}
