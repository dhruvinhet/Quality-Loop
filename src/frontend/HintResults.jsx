import React, { useState } from 'react';
import { Box, Button, Link, Stack, Text } from '@forge/react';

export default function HintResults({ result }) {
  const [expanded, setExpanded] = useState(false);
  if (!result?.applicable && !result?.error) return null;
  return <Stack space="space.200">
    <Button appearance="subtle" isSelected={expanded} onClick={() => setExpanded((value) => !value)}>
      Not matched — check these
    </Button>
    {expanded && <Stack space="space.200">
      <Text>These are hints for checking recorded details. They are not possible recurrences.</Text>
      {result.incomplete && <Text>The hint time budget was reached. Only completed checks are shown; more hints may exist.</Text>}
      {result.error ? <Text>{result.error}</Text> : <>
        <Text>Showing up to 3 hints from a limited search of records you can browse (checks up to 50 recently closed CAPAs).</Text>
        {!result.hints.length && <Text>No hints found in the checked records.</Text>}
        {result.hints.map((hint) => <Box key={hint.id || hint.key} padding="space.200" backgroundColor="color.background.neutral">
          <Stack space="space.100">
            <Text><Link href={`/browse/${encodeURIComponent(hint.key)}`}>{hint.key}</Link>{` ${hint.summary ?? ''}`}</Text>
            <Text>{`Part number (as stored): "${hint.partOriginal}"`}</Text>
            <Text>{`Failure mode (as stored): "${hint.failureMode}"`}</Text>
            <Text>{`QualityLoop closure date: ${hint.closedDate || 'not recorded'}`}</Text>
            <Text>{hint.reason}</Text>
          </Stack>
        </Box>)}
      </>}
    </Stack>}
  </Stack>;
}
