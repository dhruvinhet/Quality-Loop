import React, { useEffect, useRef, useState } from 'react';
import { Heading, LoadingButton, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { CopyResults } from './ProbePanel';
import { runMatchCheck } from './matchCheckRunner';

export default function MatchCheck() {
  const [state, setState] = useState({});
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ running: true, progress: 0 });
    try {
      const result = await runMatchCheck({ invoke, cancelled: () => !alive.current,
        onProgress: (progress) => setState({ running: true, progress }) });
      if (alive.current) setState({ result });
    } catch (error) {
      if (alive.current) setState({ error: error.message });
    } finally { busy.current = false; }
  };
  return <Stack space="space.100">
    <Heading size="small" as="h2">E2 matching check</Heading>
    <LoadingButton isLoading={state.running} isDisabled={state.running} onClick={run}>Run match 20x</LoadingButton>
    {state.running && <Text>{`${state.progress}/20 complete`}</Text>}
    {state.error && <Text>{state.error}</Text>}
    {state.result && <>
      <Text>{`All 20 results identical: ${state.result.identical ? 'yes' : 'no'}; elapsedMs min/median/max: ${state.result.min}/${state.result.median}/${state.result.max}`}</Text>
      <CopyResults text={JSON.stringify(state.result, null, 2)} />
    </>}
  </Stack>;
}
