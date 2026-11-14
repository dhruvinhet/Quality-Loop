import React, { useState } from 'react';
import { Box, Button, Heading, Link, SectionMessage, Stack, Text } from '@forge/react';
import { failureModeLabel } from '../lib/failureModes';
import DecisionDetails from './DecisionDetails';
import EvidenceLink from './EvidenceLink';
import { plural } from '../lib/plural';

export function EvidenceHeading() {
  return <Stack space="space.100">
    <Heading size="small" as="h2">Possible recurrence evidence</Heading>
    <Text size="small" color="color.text.subtle">Matches use exact part number and failure mode, CAPAs closed 1–365 days before detection. Engineer review is required.</Text>
  </Stack>;
}

export function EvidenceCard({ match, classification, data, readOnly, ready, onChanged, failureModes }) {
  const mode = failureModeLabel(match.failureMode, failureModes);
  const part = `${match.partOriginal}${classification !== 'otherRelated' && match.partNorm && match.partOriginal !== match.partNorm
    ? ` (matched as ${match.partNorm})` : ''}`;
  return <Box padding="space.200" backgroundColor="color.background.neutral">
    <Stack space="space.100">
      <Text><Link href={`/browse/${encodeURIComponent(match.key)}`}>{match.key}</Link>{` ${match.summary}`}</Text>
      <Text>{classification === 'strong'
        ? `Exact signature: part ${part}; failure mode ${mode}`
        : classification === 'relatedRevision'
          ? `Related revision: part ${part}; failure mode ${mode}; different revision (${match.partRevision ?? 'not recorded'})`
          : `Related: part ${match.partOriginal}; failure mode ${mode}`}</Text>
      <Text>{`QualityLoop closure date: ${match.closedDate} · ${match.daysSinceClosure} ${plural(match.daysSinceClosure, 'day')} after closure`}</Text>
      {classification !== 'otherRelated' && match.statusCategory !== 'done' && <SectionMessage appearance="warning">
        <Text>{`Recorded closure date ${match.closedDate}, but the Jira status is ${match.status || 'unavailable'} (not Done). Check whether this CAPA was reopened.`}</Text>
      </SectionMessage>}
      {match.effectivenessEvidenceUrl != null && match.effectivenessEvidenceUrl !== ''
        ? <><Text>Effectiveness evidence:</Text><EvidenceLink url={match.effectivenessEvidenceUrl} /></>
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

export default function EvidenceResults({ result, readOnly = false, canEdit = !readOnly, pairs = {}, decisionsReady = false, onChanged, failureModes }) {
  const [showOther, setShowOther] = useState(false);
  if (!result) return <Stack space="space.200"><EvidenceHeading /><Text>Evidence is unavailable. Refresh evidence and check your issue access.</Text></Stack>;
  if (!result.applicable) return <Stack space="space.200">
    <EvidenceHeading />
    <Text>{canEdit === false ? 'Evidence matching needs a saved NC with a detected date. Open an NC, or ask someone with Edit Issues permission to complete its quality details.'
      : 'Evidence matching needs a saved NC with a detected date. Open an NC, complete its quality details and save to search closed CAPAs.'}</Text>
    <HistoricalDecisions pairs={pairs} canRecover={!readOnly && canEdit && decisionsReady} onChanged={onChanged} />
  </Stack>;
  const { strong, relatedRevision, otherRelated } = result;
  return <Stack space="space.200">
    <EvidenceHeading />
    {result.matchesIncomplete && <SectionMessage appearance="warning"><Text>Signature search is incomplete: checked up to 200 candidates. More closed CAPAs may match.</Text></SectionMessage>}
    {result.otherRelatedIncomplete && <SectionMessage appearance="warning"><Text>Other related search is limited to 20 candidates per query. More related records may exist.</Text></SectionMessage>}
    {result.incomplete && <SectionMessage appearance="warning"><Text>The loading time budget was reached or some evidence is incomplete. Only completed results are shown. Refresh to try again.</Text></SectionMessage>}
    {!strong.length && <>
      <Text>{result.matchesIncomplete || result.incomplete || result.uncheckedCandidates ? 'No exact signature match found in the completed checks.' : 'No closed CAPA with this part and failure mode in the last 365 days'}</Text>
      <Text>{canEdit === false ? 'Check the saved quality details. Ask someone with Edit Issues permission to correct them if needed, then refresh evidence.'
        : 'Check the saved part number, failure mode and detected date, then refresh evidence.'}</Text>
      {!!relatedRevision.length && <Text>Related revisions are shown separately below. They are not exact signature matches.</Text>}
    </>}
    {strong.map((match) => <EvidenceCard key={match.id} match={match} classification="strong"
      data={pairs[match.id]} readOnly={readOnly} ready={decisionsReady} onChanged={onChanged} failureModes={failureModes} />)}
    {!!result.notShown?.strong && <Text>{`${result.notShown.strong} more ${plural(result.notShown.strong, 'candidate')} not checked (most recent 25 verified matches shown).`}</Text>}
    {!!result.verifiedNotShown?.strong && <Text>{`${result.verifiedNotShown.strong} more verified ${plural(result.verifiedNotShown.strong, 'match', 'matches')} not shown (most recent 25 shown)`}</Text>}
    {relatedRevision.map((match) => <EvidenceCard key={match.id} match={match} classification="relatedRevision"
      data={pairs[match.id]} readOnly={readOnly} ready={decisionsReady} onChanged={onChanged} failureModes={failureModes} />)}
    {!!result.notShown?.relatedRevision && <Text>{`${result.notShown.relatedRevision} more ${plural(result.notShown.relatedRevision, 'candidate')} not checked (most recent 25 verified matches shown).`}</Text>}
    {!!result.verifiedNotShown?.relatedRevision && <Text>{`${result.verifiedNotShown.relatedRevision} more verified ${plural(result.verifiedNotShown.relatedRevision, 'match', 'matches')} not shown (most recent 25 shown)`}</Text>}
    <HistoricalDecisions canRecover={!readOnly && canEdit && decisionsReady} onChanged={onChanged} pairs={Object.fromEntries(Object.entries(pairs)
      .filter(([id]) => ![...strong, ...relatedRevision].some((match) => match.id === id)))} />
    {readOnly ? <Text>{`Other related ${plural(otherRelated.length, 'record')} (${otherRelated.length})`}</Text>
      : <Button appearance="subtle" isSelected={showOther} onClick={() => setShowOther((value) => !value)}>{`Other related ${plural(otherRelated.length, 'record')} (${otherRelated.length})`}</Button>}
    {(readOnly || showOther) && otherRelated.map((match) => <EvidenceCard key={match.id} match={match} classification="otherRelated" failureModes={failureModes} />)}
  </Stack>;
}

function HistoricalDecisions({ pairs, canRecover, onChanged }) {
  return <Stack space="space.200">{Object.entries(pairs).map(([id, data]) => <Box key={id} padding="space.200">
    <Stack space="space.100">
      <Text><Link href={`/browse/${encodeURIComponent(data.capaKey)}`}>{data.capaKey}</Link>{` ${data.capaSummary ?? ''}`}</Text>
      <Text>Earlier decision history; this CAPA is not in the current strong or related revision results.</Text>
      <DecisionDetails match={{ id }} data={data} readOnly canRecover={canRecover} onChanged={onChanged} />
    </Stack>
  </Box>)}</Stack>;
}
