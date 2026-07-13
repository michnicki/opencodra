// REV-M-4: Keep the subset of Bitbucket API values Codra emits in one module so the shared
// validators and adapter body builders cannot drift. Atlassian's current OpenAPI confirms BUG is
// accepted for Code Insights reports. Codra emits only terminal PASSED/FAILED report results; the
// upstream API's PENDING value is intentionally outside this phase's create/update contract.
export const REPORT_TYPE = 'BUG' as const;
export const REPORT_TYPE_VALUES = [REPORT_TYPE] as const;
export const REPORT_RESULT = ['PASSED', 'FAILED'] as const;

// LINE_TYPES describes Codra's internal anchor classification. The REST client translates it to
// Bitbucket's documented `inline.to` (added/context) or `inline.from` (removed) wire fields.
export const LINE_TYPES = ['context', 'added', 'removed'] as const;

// Codra emits the three states needed by its review lifecycle. Bitbucket also documents STOPPED,
// which is not produced by this workflow and is therefore intentionally excluded.
export const BUILD_STATUS_STATE = ['SUCCESSFUL', 'FAILED', 'INPROGRESS'] as const;
