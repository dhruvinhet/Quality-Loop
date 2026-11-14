import { DEFAULT_REVISION_PRESET, validRevisionPreset } from '../config/partPattern';

export const LOOKBACK_OPTIONS = [90, 365, 730, 1095];
export const SETTINGS_PERMISSION_MESSAGE = 'Administer Projects on this project or Jira administrator permission is required to change these settings.';
export const SEARCH_SCOPES = [
  { value: 'PROJECT', label: 'This project only' },
  { value: 'LISTED', label: 'This project + listed projects' },
  { value: 'ALL', label: 'All projects I can browse' },
];
export const defaultSearchSettings = () => ({ version: 0, scope: 'PROJECT', lookbackDays: 365, projectIds: [], revisionPreset: DEFAULT_REVISION_PRESET });
export function validSearchSettings(value) {
  return Number.isSafeInteger(value?.version) && value.version >= 0 && SEARCH_SCOPES.some((s) => s.value === value.scope)
    && LOOKBACK_OPTIONS.includes(value.lookbackDays) && Array.isArray(value.projectIds) && value.projectIds.length <= 20
    && value.projectIds.every((id) => typeof id === 'string' && /^\d+$/.test(id))
    && (value.revisionPreset === undefined || validRevisionPreset(value.revisionPreset));
}
export function listedProjectKeys(value) {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('Enter project keys separated by spaces or commas.');
  const keys = [...new Set(value.trim().toUpperCase().split(/[\s,]+/).filter(Boolean))];
  if (keys.length > 20) throw new Error('List at most 20 additional projects.');
  if (keys.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key))) throw new Error('Enter valid project keys separated by spaces or commas.');
  return keys;
}
export const scopeLabel = (scope) => ({ PROJECT: 'this project only', LISTED: 'this project + listed projects', ALL: 'all projects I can browse' }[scope]);
export const publicSearch = ({ scope, lookbackDays, revisionPreset = DEFAULT_REVISION_PRESET }) => ({ scope, lookbackDays, scopeLabel: scopeLabel(scope), revisionPreset });
export const searchDescription = ({ scope, lookbackDays }) => `Searching ${scopeLabel(scope)} · CAPAs closed 1–${lookbackDays} days before detection`;
export const inProjectScope = (projectId, projectIds) => projectIds == null || projectIds.includes(String(projectId));
