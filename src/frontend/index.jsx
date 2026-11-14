import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Heading, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import CaptureForm from './CaptureForm';
import ReadOnlyCapture from './ReadOnlyCapture';
import MatchView from './MatchView';

const App = () => {
  const [state, setState] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const [matchRefresh, setMatchRefresh] = useState(0);
  const [setupType, setSetupType] = useState('');
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    Promise.all([invoke('loadCapture'), invoke('getPanelAccess'), invoke('getFailureModes')]).then(([result, access, catalogue]) => {
      if (active) setState({ loading: false, record: result?.record ?? null, canEdit: access?.canEdit === true,
        failureModes: catalogue?.modes, revisionPreset: access?.revisionPreset,
        error: result?.error || access?.error || catalogue?.error || (!catalogue?.modes ? 'Failure modes could not be loaded. Try loading again.' : null)
          || (!access ? 'Issue access could not be checked. Try loading again.' : null) });
    }).catch(() => {
      if (active) setState({ loading: false, error: 'Quality details could not be loaded. Try again.' });
    });
    return () => { active = false; };
  }, [attempt]);
  if (state.loading) return <Stack space="space.100">
    <Spinner label="Loading quality details" />
    <Text>Loading QualityLoop details. Please wait.</Text>
  </Stack>;
  if (state.error) return <Stack space="space.200">
    <SectionMessage appearance="error"><Text>{state.error}</Text></SectionMessage>
    <Button onClick={() => setAttempt((value) => value + 1)}>Retry loading</Button>
  </Stack>;
  return (
    <Stack space="space.300">
      {state.canEdit ? (!state.record && !setupType ? <Stack space="space.200">
        <Heading size="small" as="h2">Not a QualityLoop record yet</Heading>
        <Text>Choose a record type, enter the quality details, then save this issue.</Text>
        <Button appearance="primary" onClick={() => setSetupType('NC')}>Set up as NC</Button>
        <Button onClick={() => setSetupType('CAPA')}>Set up as CAPA</Button>
      </Stack> : <CaptureForm record={state.record} failureModes={state.failureModes} revisionPreset={state.revisionPreset} initialRecordType={setupType} onSaved={(record) => {
        setState((previous) => ({ ...previous, record }));
        setMatchRefresh((value) => value + 1);
      }} />)
        : <ReadOnlyCapture record={state.record} failureModes={state.failureModes} />}
      {state.record && <MatchView refresh={matchRefresh} readOnly={!state.canEdit} />}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
