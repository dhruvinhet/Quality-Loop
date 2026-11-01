import React, { useEffect, useState } from 'react';
import { Button, Heading, Link, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { callPage } from './pageRunner';

export default function GettingStarted() {
  const [state, setState] = useState({ loading: true, keys: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true, keys: [] });
    async function load() {
      const keys = new Set();
      const cursors = new Set();
      let cursor;
      do {
        const page = await callPage(invoke, 'sampleNcLinks', cursor ? { cursor } : {});
        page.keys.forEach((key) => keys.add(key));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Sample links could not be refreshed.');
        cursors.add(cursor);
      } while (cursor);
      if (active) setState({ keys: [...keys], loading: false });
    }
    load().catch(() => {
      if (active) setState({ loading: false, keys: [], error: true });
    });
    return () => { active = false; };
  }, [attempt]);
  return <Stack space="space.200">
    <Heading size="small" as="h2">Getting started</Heading>
    <Text>1. Create sample scenario: open a Jira project, select QualityLoop, then Create sample scenario (5 issues). Review the listed writes and confirm.</Text>
    <Text>2. Open the sample NC: follow a link below and open its qualityloop issue panel.</Text>
    {state.loading && <Stack space="space.100"><Spinner label="Loading sample NC links" /><Text>Checking sample NC links you can browse. Please wait.</Text></Stack>}
    {state.error && <SectionMessage appearance="error"><Text>Sample NC links could not be loaded. Retry to check again.</Text></SectionMessage>}
    {state.keys.map((key) => <Text key={key}><Link href={`/browse/${encodeURIComponent(key)}`}>{`Open sample NC ${key}`}</Link></Text>)}
    {!state.loading && !state.error && !state.keys.length && <Text>No sample NC is available to you yet. Create the scenario in a project you can browse, then refresh sample links.</Text>}
    <Button isDisabled={state.loading} onClick={() => setAttempt((value) => value + 1)}>{state.error ? 'Retry' : 'Refresh sample links'}</Button>
    <Text>3. Record a decision: review the Possible recurrence evidence, choose Engineer-confirmed recurrence, Not a recurrence or Effectiveness concern, enter a reason and evidence, then select Record decision.</Text>
  </Stack>;
}
