import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import CaptureForm from './CaptureForm';
import ReadOnlyCapture from './ReadOnlyCapture';
import ProbePanel from './ProbePanel';
import MatchView from './MatchView';
import MatchCheck from './MatchCheck';
import { E1_PROBE, E2_CHECK } from '../config/devFlags';

const App = () => {
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [matchRefresh, setMatchRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    Promise.all([invoke('loadCapture'), invoke('getPanelAccess')]).then(([result, access]) => {
      if (active) setState({ loading: false, record: result?.record ?? null, canEdit: access?.canEdit === true,
        error: result?.error || access?.error || (!access ? 'Issue access could not be checked. Try loading again.' : null) });
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
      {state.canEdit ? <CaptureForm record={state.record} onSaved={() => setMatchRefresh((value) => value + 1)} />
        : <ReadOnlyCapture record={state.record} />}
      <MatchView refresh={matchRefresh} readOnly={!state.canEdit} />
      {state.canEdit && E1_PROBE && <ProbePanel />}
      {state.canEdit && E2_CHECK && <MatchCheck />}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
