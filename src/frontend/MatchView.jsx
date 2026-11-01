import React, { useEffect, useState } from 'react';
import { Button, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import EvidenceResults from './EvidenceResults';
import HintResults from './HintResults';
import { excludeMatchedHints } from '../lib/hints';

export default function MatchView({ refresh = 0, readOnly = false }) {
  const [state, setState] = useState({ loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState((previous) => ({ ...previous, refreshing: true }));
    Promise.all([invoke('findMatches'), invoke('getDecisions'), invoke('findHints')
      .catch(() => ({ error: 'Hints could not be loaded. Refresh evidence to try again.' }))]).then(([result, decisions, hints]) => {
      if (active) setState({ result, hints, error: result?.error, pairs: decisions?.pairs,
        decisionsError: decisions?.error || (!decisions?.pairs ? 'Decision history could not be loaded.' : null) });
    }).catch(() => {
      if (active) setState({ error: 'Evidence could not be loaded. Reopen the issue view to try again.' });
    });
    return () => { active = false; };
  }, [refresh, revision]);
  if (state.loading) return <Spinner label="Finding closed CAPA evidence" />;
  if (state.error) return <SectionMessage appearance="error"><Text>{state.error}</Text></SectionMessage>;
  return <Stack space="space.200">
    {state.decisionsError && <SectionMessage appearance="error"><Text>{state.decisionsError}</Text></SectionMessage>}
    <Button isDisabled={state.refreshing} onClick={() => setRevision((value) => value + 1)}>Refresh evidence and decisions</Button>
    <EvidenceResults result={state.result} readOnly={readOnly} pairs={state.pairs}
      decisionsReady={!state.refreshing && !state.decisionsError} onChanged={() => setRevision((value) => value + 1)} />
    <HintResults result={state.hints?.hints ? { ...state.hints,
      hints: excludeMatchedHints(state.hints.hints, state.result) } : state.hints} />
  </Stack>;
}
