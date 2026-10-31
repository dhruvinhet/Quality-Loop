import React from 'react';
import { Link, Stack, Text } from '@forge/react';
import { validEvidenceUrl } from '../lib/decisions';

export default function ReadOnlyCapture({ record }) {
  return <Stack space="space.100">
    <Text>You can view this record. Editing needs edit permission on this issue.</Text>
    {!record ? <Text>No saved quality details.</Text> : <>
      {[
        ['Record type', record.recordType], ['Part number', record.partOriginal],
        ['Failure mode', record.failureMode], ['Supplier', record.supplier], ['Line', record.line],
        ['Detected date', record.detectedDate], ['Closed date', record.closedDate],
        ['Root cause', record.rootCause], ['Actions taken', record.actionsTaken],
      ].map(([label, value]) => <Text key={label}>{`${label}: ${value || 'not recorded'}`}</Text>)}
      {validEvidenceUrl(record.effectivenessEvidenceUrl)
        ? <Text>Effectiveness evidence: <Link href={record.effectivenessEvidenceUrl} openNewTab>View evidence</Link></Text>
        : <Text>No effectiveness evidence recorded at closure</Text>}
    </>}
  </Stack>;
}
