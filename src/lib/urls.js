// New evidence must be HTTPS. allowHttp is only for identifying legacy HTTP
// values for warning/text display; callers must not use it to validate a write.
export function evidenceUrlError(value, { allowHttp = false } = {}) {
  const invalid = 'Enter a full https:// link.';
  if (typeof value !== 'string') return invalid;
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value.trim());
  if (authority?.[1].includes('@')) return 'Remove the user name and password from the link.';
  // Explicitly reject control characters; the URL parser silently strips some.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return invalid;
  if (value.trim() !== value) return 'Remove spaces before or after the link.';
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1].toLowerCase();
  if (scheme && scheme !== 'https' && !(allowHttp && scheme === 'http')) return 'Use an https:// link.';
  if (value.length > 2000 || /[\s\\]/.test(value)) return invalid;
  // Require an explicit, nonempty authority. URL() otherwise repairs missing
  // slashes/hosts and backslashes, and discards some control characters.
  if (!/^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.test(value)) return invalid;
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'Remove the user name and password from the link.';
    return (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) && url.hostname ? null : invalid;
  } catch { return invalid; }
}

export function validEvidenceUrl(value, options) {
  return evidenceUrlError(value, options) === null;
}
