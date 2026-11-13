import React, { useEffect, useState } from 'react';
import { Button, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import EvidenceResults, { EvidenceHeading } from './EvidenceResults';
import HintResults from './HintResults';
import { excludeMatchedHints } from '../lib/hints';

export default function MatchView({ refresh = 0, readOnly = false, canEdit = !readOnly }) {
  const [state, setState] = useState({ loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setState((previous) => ({ ...previous, error: null, refreshing: true }));
    Promise.all([invoke('loadEvidence'), invoke('findHints')
      .catch(() => ({ error: 'Hints could not be loaded. Refresh evidence to try again.' })),
    invoke('getFailureModes').catch(() => null)]).then(([result, hints, catalogue]) => {
      if (active) setState({ result, hints, error: result?.error || (!result ? 'Evidence is unavailable with your current issue access.' : null), pairs: result?.pairs,
        failureModes: catalogue?.modes ?? [], catalogueError: !catalogue?.modes,
        decisionsError: result?.decisionsIncomplete ? 'Decision history and counts are incomplete. Refresh to try again.'
          : (!result?.pairs ? 'Decision history could not be loaded.' : null) });
    }).catch(() => {
      if (active) setState({ error: 'Closed CAPA evidence could not be loaded.' });
    });
    return () => { active = false; };
  }, [refresh, revision]);
  const retry = () => setRevision((value) => value + 1);
  if (state.loading || (state.refreshing && state.error == null && !state.result)) return <Stack space="space.200">
    <EvidenceHeading />
    <Spinner label="Searching closed CAPAs" />
    <Text>Searching closed CAPAs for this NC. Please wait to review the evidence.</Text>
  </Stack>;
  if (state.error) return <Stack space="space.200">
    <EvidenceHeading />
    <SectionMessage appearance="error"><Text>{state.error}</Text></SectionMessage>
    <Button onClick={retry}>Retry</Button>
  </Stack>;
  return <Stack space="space.200">
    {state.refreshing && <Text>Searching closed CAPAs and refreshing decisions. Please wait before recording a decision.</Text>}
    {state.decisionsError && <SectionMessage appearance="error"><Text>{state.decisionsError}</Text></SectionMessage>}
    {state.catalogueError && <SectionMessage appearance="warning"><Text>Failure-mode labels could not be loaded. Codes are shown; refresh to retry.</Text></SectionMessage>}
    <Button isDisabled={state.refreshing} onClick={retry}>Refresh evidence and decisions</Button>
    <EvidenceResults result={state.result} readOnly={readOnly} canEdit={canEdit} pairs={state.pairs} failureModes={state.failureModes}
      decisionsReady={!state.refreshing && !!state.pairs} onChanged={() => setRevision((value) => value + 1)} />
    <HintResults failureModes={state.failureModes} result={state.hints?.hints ? { ...state.hints,
      hints: excludeMatchedHints(state.hints.hints, state.result) } : state.hints} />
  </Stack>;
}
