import { randomUUID } from 'node:crypto';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { defaultSearchSettings, validSearchSettings, listedProjectKeys, LOOKBACK_OPTIONS, SEARCH_SCOPES, publicSearch, SETTINGS_PERMISSION_MESSAGE } from '../lib/searchSettings';
import { pageDefine, projectContext } from './pageUtils';
import { checkJira } from './loadBudget';
import { DEFAULT_REVISION_PRESET, validRevisionPreset } from '../config/partPattern';

const headers = { Accept: 'application/json' };
const run = (budget, work) => budget ? budget.run(work) : work();
export async function readSearchSettings(projectId) {
  if (!/^\d+$/.test(String(projectId))) throw new Error('NC project is unavailable.');
  const stored = await kvs.get(`settings:${projectId}`);
  if (stored === undefined) return defaultSearchSettings();
  if (!validSearchSettings(stored)) throw new Error('Search settings are invalid.');
  return { ...stored, revisionPreset: stored.revisionPreset ?? DEFAULT_REVISION_PRESET };
}
async function browsableProject(ref, budget) {
  const response = await run(budget, () => api.asUser().requestJira(route`/rest/api/3/project/${ref}`, { headers }));
  if ([403, 404].includes(response.status)) return null;
  checkJira(response);
  const project = await run(budget, () => response.json());
  if (!/^\d+$/.test(project?.id) || typeof project.key !== 'string' || (/^\d+$/.test(ref) && String(project.id) !== ref)) return null;
  return { id: String(project.id), key: project.key };
}
async function visibleProjects(ids, budget) {
  const projects = [];
  for (let offset = 0; offset < ids.length; offset += 5) {
    const batch = await Promise.all(ids.slice(offset, offset + 5).map((id) => browsableProject(id, budget)));
    projects.push(...batch.filter(Boolean));
  }
  return projects;
}
export async function searchForIssue(issue, budget) {
  const projectId = String(issue?.fields?.project?.id ?? '');
  const settings = await run(budget, () => readSearchSettings(projectId));
  const listed = settings.scope === 'LISTED' ? await visibleProjects(settings.projectIds.filter((id) => id !== projectId), budget) : [];
  return { ...publicSearch(settings), projectIds: settings.scope === 'ALL' ? undefined : [...new Set([projectId, ...listed.map((p) => p.id)])] };
}
async function canAdminister(projectId) {
  const response = await api.asUser().requestJira(route`/rest/api/3/mypermissions?projectId=${projectId}&permissions=ADMINISTER_PROJECTS,ADMINISTER`, { headers });
  if ([403, 404].includes(response.status)) return false;
  checkJira(response);
  const permissions = (await response.json()).permissions;
  return permissions?.ADMINISTER_PROJECTS?.havePermission === true || permissions?.ADMINISTER?.havePermission === true;
}
async function view(project, settings) {
  const listed = settings.scope === 'LISTED' ? await visibleProjects(settings.projectIds) : [];
  return { settings: { version: settings.version, ...publicSearch(settings) }, listedProjectKeys: listed.map((p) => p.key).sort(),
    canAdmin: await canAdminister(project.id) };
}
export function registerSearchSettings(resolver) {
  pageDefine(resolver, 'getProjectSearchSettings', [], async (context) => {
    const project = await projectContext(context);
    if (!project) return null;
    return view(project, await readSearchSettings(project.id));
  });
  pageDefine(resolver, 'saveProjectSearchSettings', ['scope', 'lookbackDays', 'projectKeys', 'expectedVersion', 'revisionPreset'], async (context, payload) => {
    const project = await projectContext(context);
    if (!project) return null;
    if (!await canAdminister(project.id)) return { error: SETTINGS_PERMISSION_MESSAGE };
    if (payload.revisionPreset !== undefined && !validRevisionPreset(payload.revisionPreset)) return { error: 'Select a supported revision preset.' };
    if (!SEARCH_SCOPES.some((s) => s.value === payload.scope) || !LOOKBACK_OPTIONS.includes(payload.lookbackDays)) {
      return { error: 'Select a supported search scope and look-back window.' };
    }
    let keys;
    try { keys = payload.scope === 'LISTED' ? listedProjectKeys(payload.projectKeys) : []; }
    catch (error) { return { error: error.message }; }
    const projectIds = [];
    for (const key of keys) {
      const target = await browsableProject(key);
      if (!target) return { error: `Project ${key} was not found or you cannot browse it. Check the key.` };
      if (target.id !== project.id) projectIds.push(target.id);
    }
    const lock = `settings-lock:${project.id}`;
    const token = randomUUID();
    try { await kvs.set(lock, { token }, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { unit: 'MINUTES', value: 5 } }); }
    catch { return { error: 'Settings are busy or unavailable. Refresh before retrying.' }; }
    try {
      const current = await readSearchSettings(project.id);
      if (payload.expectedVersion !== current.version) return { error: 'Settings changed. Refresh before saving again.' };
      if (!await canAdminister(project.id)) return { error: SETTINGS_PERMISSION_MESSAGE };
      if ((await kvs.get(lock))?.token !== token) return { error: 'The settings lock was lost. Refresh before saving again.' };
      const next = { version: current.version + 1, scope: payload.scope, lookbackDays: payload.lookbackDays, projectIds: [...new Set(projectIds)],
        revisionPreset: payload.revisionPreset ?? current.revisionPreset };
      await kvs.set(`settings:${project.id}`, next);
      return view(project, next);
    } finally { if ((await kvs.get(lock))?.token === token) await kvs.delete(lock); }
  });
}
