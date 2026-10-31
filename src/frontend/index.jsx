import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import CaptureForm from './CaptureForm';
import ProbePanel from './ProbePanel';
import { E1_PROBE } from '../config/devFlags';

const App = () => {
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    invoke('loadCapture').then((result) => {
      if (active) setState({ loading: false, record: result?.record ?? null, error: result?.error });
    }).catch(() => {
      if (active) setState({ loading: false, error: 'Quality details could not be loaded. Try again.' });
    });
    return () => { active = false; };
  }, [attempt]);
  if (state.loading) return <Spinner label="Loading quality details" />;
  if (state.error) return <Stack space="space.200">
    <SectionMessage appearance="error"><Text>{state.error}</Text></SectionMessage>
    <Button onClick={() => setAttempt((value) => value + 1)}>Retry loading</Button>
  </Stack>;
  return (
    <Stack space="space.300">
      <CaptureForm record={state.record} />
      {E1_PROBE && <ProbePanel />}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
