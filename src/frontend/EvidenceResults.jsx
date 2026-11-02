import React, { useState } from 'react';
import { Box, Button, Heading, Link, Stack, Text } from '@forge/react';
import { FAILURE_MODES } from '../config/failureModes';
import DecisionDetails from './DecisionDetails';

function evidenceUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) ? value : null; } catch { return null; }
}

export function EvidenceHeading() {
  return <Stack space="space.100">
    <Heading size="small" as="h2">Possible recurrence evidence</Heading>
    <Text size="small" color="color.text.subtle">Matches use exact part number and failure mode, CAPAs closed 1–365 days before detection. Engineer review is required.</Text>
  </Stack>;
}

function EvidenceCard({ match, classification, data, readOnly, ready, onChanged }) {
  const mode = FAILURE_MODES.find(({ value }) => value === match.failureMode)?.label ?? match.failureMode;
  const url = evidenceUrl(match.effectivenessEvidenceUrl);
  return <Box padding="space.200" backgroundColor="color.background.neutral">
    <Stack space="space.100">
      <Text><Link href={`/browse/${encodeURIComponent(match.key)}`}>{match.key}</Link>{` ${match.summary}`}</Text>
      <Text>{classification === 'strong'
        ? `Exact signature: part ${match.partOriginal}; failure mode ${mode}`
        : classification === 'relatedRevision'
          ? `Related revision: part ${match.partOriginal}; failure mode ${mode}; different revision (${match.partRevision ?? 'not recorded'})`
          : `Related: part ${match.partOriginal}; failure mode ${mode}`}</Text>
      <Text>{`QualityLoop closure date: ${match.closedDate} · ${match.daysSinceClosure} days after closure`}</Text>
      {url ? <Text>Effectiveness evidence: <Link href={url} openNewTab>View evidence</Link></Text>
        : <Text>No effectiveness evidence recorded at closure</Text>}
      <Text>{`Root cause: ${match.rootCause.trim() || 'not recorded'}`}</Text>
      <Text>{`Actions taken: ${match.actionsTaken.trim() || 'not recorded'}`}</Text>
      <Text weight="semibold">Supporting facts</Text>
      <Text>{`Jira status: ${match.status || 'not recorded'}`}</Text>
      {match.supportingFacts.length ? match.supportingFacts.map((fact) => <Text key={fact}>{fact}</Text>) : <Text>No additional supporting facts recorded.</Text>}
      {classification !== 'otherRelated' && <DecisionDetails match={match} data={data} readOnly={readOnly}
        ready={ready && !!data} onChanged={onChanged} />}
    </Stack>
  </Box>;
}

export default function EvidenceResults({ result, readOnly = false, canEdit = !readOnly, pairs = {}, decisionsReady = false, onChanged }) {
  const [showOther, setShowOther] = useState(false);
  if (!result) return <Stack space="space.200"><EvidenceHeading /><Text>Evidence is unavailable. Refresh evidence and check your issue access.</Text></Stack>;
  if (!result.applicable) return <Stack space="space.200">
    <EvidenceHeading />
    <Text>{canEdit === false ? 'Evidence matching needs a saved NC with a detected date. Open an NC, or ask someone with Edit Issues permission to complete its quality details.'
      : 'Evidence matching needs a saved NC with a detected date. Open an NC, complete its quality details and save to search closed CAPAs.'}</Text>
    <HistoricalDecisions pairs={pairs} />
  </Stack>;
  const { strong, relatedRevision, otherRelated } = result;
  return <Stack space="space.200">
    <EvidenceHeading />
    {!strong.length && <>
      <Text>No closed CAPA with this part and failure mode in the last 365 days</Text>
      <Text>{canEdit === false ? 'Check the saved quality details. Ask someone with Edit Issues permission to correct them if needed, then refresh evidence.'
        : 'Check the saved part number, failure mode and detected date, then refresh evidence.'}</Text>
      {!!relatedRevision.length && <Text>Related revisions are shown separately below. They are not exact signature matches.</Text>}
    </>}
    {strong.map((match) => <EvidenceCard key={match.id} match={match} classification="strong"
      data={pairs[match.id]} readOnly={readOnly} ready={decisionsReady} onChanged={onChanged} />)}
    {relatedRevision.map((match) => <EvidenceCard key={match.id} match={match} classification="relatedRevision"
      data={pairs[match.id]} readOnly={readOnly} ready={decisionsReady} onChanged={onChanged} />)}
    <HistoricalDecisions pairs={Object.fromEntries(Object.entries(pairs)
      .filter(([id]) => ![...strong, ...relatedRevision].some((match) => match.id === id)))} />
    {readOnly ? <Text>{`Other related records (${otherRelated.length})`}</Text>
      : <Button appearance="subtle" isSelected={showOther} onClick={() => setShowOther((value) => !value)}>{`Other related records (${otherRelated.length})`}</Button>}
    {(readOnly || showOther) && otherRelated.map((match) => <EvidenceCard key={match.id} match={match} classification="otherRelated" />)}
  </Stack>;
}

function HistoricalDecisions({ pairs }) {
  return <Stack space="space.200">{Object.entries(pairs).map(([id, data]) => <Box key={id} padding="space.200">
    <Stack space="space.100">
      <Text><Link href={`/browse/${encodeURIComponent(data.capaKey)}`}>{data.capaKey}</Link>{` ${data.capaSummary ?? ''}`}</Text>
      <Text>Earlier decision history; this CAPA is not in the current strong or related revision results.</Text>
      <DecisionDetails match={{ id }} data={data} readOnly />
    </Stack>
  </Box>)}</Stack>;
}
