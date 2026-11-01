import { randomUUID } from 'node:crypto';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

export const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
export const userJira = (path, options = {}) => api.asUser().requestJira(path, { headers, ...options });

export function pageDefine(resolver, name, fields, fn) {
  resolver.define(name, async (req) => {
    try {
      const payload = req.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !fields.includes(key))) {
        return { error: 'Invalid request fields.' };
      }
      if (!req.context?.accountId) return null;
      return await fn(req.context, payload);
    } catch {
      console.error(`QualityLoop ${name} failed.`);
      return { error: 'QualityLoop could not complete this operation. Refresh the page and check the result before retrying.' };
    }
  });
}

export async function projectContext(context) {
  const projectId = String(context.extension?.project?.id ?? '');
  if (context.extension?.type !== 'jira:projectPage' || !/^\d+$/.test(projectId)) return null;
  const response = await userJira(route`/rest/api/3/project/${projectId}`);
  if ([403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Project read returned HTTP ${response.status}`);
  const project = await response.json();
  return String(project.id) === projectId ? project : null;
}

export async function requireAdmin(context) {
  if (context.extension?.type !== 'jira:adminPage') return false;
  const response = await userJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  if (!response.ok) return false;
  return (await response.json()).permissions?.ADMINISTER?.havePermission === true;
}

export async function saveTicket(prefix, context, value) {
  const token = randomUUID();
  await kvs.set(`${prefix}:${token}`, { ...value, accountId: context.accountId, expiresAt: Date.now() + 3600000 }, { ttl: { unit: 'HOURS', value: 1 } });
  return token;
}
export async function readTicket(prefix, token, context) {
  if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) return null;
  const ticket = await kvs.get(`${prefix}:${token}`);
  return ticket?.accountId === context.accountId && ticket.expiresAt > Date.now() ? ticket : null;
}
export function validCursor(cursor) {
  return cursor === undefined || (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 10000);
}
