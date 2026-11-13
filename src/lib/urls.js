// New evidence must be HTTPS. allowHttp is only for identifying legacy HTTP
// values for warning/text display; callers must not use it to validate a write.
export function validEvidenceUrl(value, { allowHttp = false } = {}) {
  if (typeof value !== 'string' || value.length > 2000 || value.trim() !== value ||
      /[\s\u0000-\u001f\u007f-\u009f\\]/.test(value)) return false;
  // Require an explicit, nonempty authority. URL() otherwise repairs missing
  // slashes/hosts and backslashes, and discards some control characters.
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(value);
  if (!authority || authority[1].includes('@')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) &&
      !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
