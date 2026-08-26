/**
 * Thin re-export of the pure issue-mapping helpers.
 *
 * @remarks
 * The implementations live in `features/issues.ts` so feature controllers can use them without
 * pulling in theme/UI modules.
 */
export {
  issueSet,
  mapProviderIssues,
  type IssueLevel,
  type IssueSet,
  type PanelIssue,
} from "../../features/issues.ts";
