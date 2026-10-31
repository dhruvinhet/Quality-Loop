import React, { useState } from 'react';
import { Box, Button, Heading, Link, Stack, Text } from '@forge/react';
import { FAILURE_MODES } from '../config/failureModes';
import { lookbackDays } from '../config/matching';

function evidenceUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; } catch { return null; }
}

function EvidenceCard({ match, classification }) {
  const mode = FAILURE_MODES.find(({ value }) => value === match.failureMode)?.label ?? match.failureMode;
  const url = evidenceUrl(match.effectivenessEvidenceUrl);
  return <Box padding="space.200" backgroundColor="color.background.neutral">
    <Stack space="space.100">
      <Text><Link href={`/browse/${encodeURIComponent(match.key)}`}>{match.key}</Link>{` ${match.summary}`}</Text>
      <Text>{classification === 'strong'
        ? `Signature match: part ${match.partOriginal} and failure mode ${mode}, ${match.daysSinceClosure} days after closure`
        : classification === 'relatedRevision'
          ? `Related: same part base, different revision (${match.partRevision ?? 'not recorded'})`
          : `Related: part ${match.partOriginal}; failure mode ${mode}`}</Text>
      <Text>{`Closed: ${match.closedDate}; Jira status: ${match.status || 'not recorded'}`}</Text>
      {match.supportingFacts.length ? match.supportingFacts.map((fact) => <Text key={fact}>{fact}</Text>) : <Text>No additional supporting facts recorded.</Text>}
      <Text>{`Root cause: ${match.rootCause.trim() || 'not recorded'}`}</Text>
      <Text>{`Actions taken: ${match.actionsTaken.trim() || 'not recorded'}`}</Text>
      {url ? <Text>Effectiveness evidence: <Link href={url} openNewTab>View evidence</Link></Text>
        : <Text>No effectiveness evidence recorded at closure</Text>}
    </Stack>
  </Box>;
}

export default function EvidenceResults({ result, readOnly = false }) {
  const [showOther, setShowOther] = useState(false);
  if (!result) return <Text>Evidence is unavailable. Save quality details or check your issue access.</Text>;
  if (!result.applicable) return <Text>Evidence matching applies to an NC with a recorded detected date.</Text>;
  const { strong, relatedRevision, otherRelated } = result;
  return <Stack space="space.200">
    <Heading size="small" as="h2">Possible recurrence evidence</Heading>
    <Text>Matches reflect recorded fields and dates. Engineer review is required to confirm recurrence.</Text>
    {!strong.length && !relatedRevision.length && <Text>{`No closed CAPA with the same signature in the last ${lookbackDays} days.`}</Text>}
    {strong.map((match) => <EvidenceCard key={match.id} match={match} classification="strong" />)}
    {relatedRevision.map((match) => <EvidenceCard key={match.id} match={match} classification="relatedRevision" />)}
    {readOnly ? <Text>{`Other related records (${otherRelated.length})`}</Text>
      : <Button appearance="subtle" isSelected={showOther} onClick={() => setShowOther((value) => !value)}>{`Other related records (${otherRelated.length})`}</Button>}
    {(readOnly || showOther) && otherRelated.map((match) => <EvidenceCard key={match.id} match={match} classification="otherRelated" />)}
  </Stack>;
}
