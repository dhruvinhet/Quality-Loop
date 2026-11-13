import React, { useEffect, useState } from 'react';
import { Box, Button, Link, SectionMessage, Stack, Text } from '@forge/react';
import { HINT_CANDIDATE_LIMIT, HINT_LIMIT } from '../lib/hints';

export default function HintResults({ result }) {
  const hasHints = (result?.hints?.length ?? 0) > 0;
  const [expanded, setExpanded] = useState(hasHints);
  useEffect(() => { setExpanded(hasHints); }, [hasHints]);
  if (!result?.applicable && !result?.error) return null;
  const notices = <>
    {result.error && <SectionMessage appearance="error"><Text>{result.error}</Text></SectionMessage>}
    {result.truncated && <Text>{`The hint searches check at most ${HINT_CANDIDATE_LIMIT} candidates each; more may exist.`}</Text>}
    {result.budgetExceeded && <Text>The hint time budget was reached. Only completed checks are shown; more hints may exist.</Text>}
  </>;
  if (!hasHints) return result.error || result.truncated || result.budgetExceeded
    ? <Stack space="space.200">{notices}</Stack> : null;
  return <Stack space="space.200">
    <SectionMessage appearance="information">
      <Text>{`Up to ${HINT_LIMIT} hints, from limited searches (at most ${HINT_CANDIDATE_LIMIT} candidates each): near-identical part numbers, same part with no closed date, and older precedents. These are not matches.`}</Text>
      <Text>These records do not meet the matching rules, but may still be worth a manual review. Only records you can browse are shown.</Text>
    </SectionMessage>
    {notices}
    <Button appearance="subtle" isSelected={expanded} onClick={() => setExpanded((value) => !value)}>
      Not matched — check these
    </Button>
    {expanded && <Stack space="space.200">
        {result.hints.map((hint) => <Box key={hint.id || hint.key} padding="space.200" backgroundColor="color.background.neutral">
          <Stack space="space.100">
            <Text><Link href={`/browse/${encodeURIComponent(hint.key)}`}>{hint.key}</Link>{` ${hint.summary ?? ''}`}</Text>
            <Text>{`Part number (as stored): "${hint.partOriginal}"`}</Text>
            <Text>{`Failure mode (as stored): "${hint.failureMode}"`}</Text>
            <Text>{`QualityLoop closure date: ${hint.closedDate || 'not recorded'}`}</Text>
            <Text>{hint.reason}</Text>
          </Stack>
        </Box>)}
    </Stack>}
  </Stack>;
}
