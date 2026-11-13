import React from 'react';
import { Link, Stack, Text } from '@forge/react';
import { validEvidenceUrl } from '../lib/urls';

// Shared rendering for capture evidence and decision history. Invalid values
// never reach a Link or echo potentially embedded credentials into the UI.
export default function EvidenceLink({ url, label = 'View evidence' }) {
  if (validEvidenceUrl(url)) return <Text><Link href={url} openNewTab>{label}</Link></Text>;
  if (validEvidenceUrl(url, { allowHttp: true })) return <Stack space="space.050">
    <Text>Not a secure link (http)</Text>
    <Text>{url}</Text>
  </Stack>;
  return <Text>Invalid evidence link</Text>;
}
