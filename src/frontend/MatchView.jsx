import React, { useEffect, useState } from 'react';
import { SectionMessage, Spinner, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import EvidenceResults from './EvidenceResults';

export default function MatchView({ refresh = 0, readOnly = false }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    invoke('findMatches').then((result) => {
      if (active) setState({ result, error: result?.error });
    }).catch(() => {
      if (active) setState({ error: 'Evidence could not be loaded. Reopen the issue view to try again.' });
    });
    return () => { active = false; };
  }, [refresh]);
  if (state.loading) return <Spinner label="Finding closed CAPA evidence" />;
  if (state.error) return <SectionMessage appearance="error"><Text>{state.error}</Text></SectionMessage>;
  return <EvidenceResults key={refresh} result={state.result} readOnly={readOnly} />;
}
