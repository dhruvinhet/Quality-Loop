import React from 'react';
import { SectionMessage, Stack, Text } from '@forge/react';
import EvidenceLink from './EvidenceLink';
import { failureModeLabel } from '../lib/failureModes';

export default function ReadOnlyCapture({ record, failureModes }) {
  return <Stack space="space.100">
    <SectionMessage title="Read-only" appearance="information">
      <Text>You can view quality details and evidence. Ask someone with Edit Issues permission to update details or record a decision.</Text>
    </SectionMessage>
    {!record ? <Text>Not a QualityLoop record yet. Ask someone with Edit Issues permission to set up this issue as an NC or CAPA.</Text> : <>
      {[
        ['Record type', record.recordType], ['Part number', record.partOriginal],
        ['Failure mode', failureModeLabel(record.failureMode, failureModes)], ['Supplier', record.supplier], ['Line', record.line],
        ['Detected date', record.detectedDate], ['Closed date', record.closedDate],
        ['Root cause', record.rootCause], ['Actions taken', record.actionsTaken],
      ].map(([label, value]) => <Text key={label}>{`${label}: ${value || 'not recorded'}`}</Text>)}
      {record.effectivenessEvidenceUrl != null && record.effectivenessEvidenceUrl !== ''
        ? <><Text>Effectiveness evidence:</Text><EvidenceLink url={record.effectivenessEvidenceUrl} /></>
        : <Text>No effectiveness evidence recorded at closure</Text>}
    </>}
  </Stack>;
}
