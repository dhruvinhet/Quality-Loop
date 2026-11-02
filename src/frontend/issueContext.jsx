import React, { useEffect, useState } from 'react';
import ForgeReconciler, { SectionMessage, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import MatchView from './MatchView';

export function IssueContext() {
  const [access, setAccess] = useState(null);
  useEffect(() => {
    let active = true;
    invoke('getPanelAccess').then((result) => {
      if (active) setAccess(typeof result?.canEdit === 'boolean' ? result : { error: true });
    }).catch(() => {
      if (active) setAccess({ error: true });
    });
    return () => { active = false; };
  }, []);
  return <Stack space="space.300">
    <SectionMessage title="Read-only evidence view" appearance="information">
      <Text>{access?.canEdit === true
        ? 'This side view is read-only. To update details or record a decision, open QualityLoop from the apps icon under the issue title.'
        : access?.canEdit === false
          ? 'You can view quality details and evidence. Ask someone with Edit Issues permission to update details or record a decision.'
          : access?.error ? 'Issue access could not be checked. Reopen this side view to try again.' : 'Checking issue access...'}</Text>
    </SectionMessage>
    <MatchView readOnly canEdit={access?.canEdit ?? null} />
  </Stack>;
}

ForgeReconciler.render(<React.StrictMode><IssueContext /></React.StrictMode>);
