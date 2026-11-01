import React from 'react';
import ForgeReconciler, { SectionMessage, Stack, Text } from '@forge/react';
import MatchView from './MatchView';

ForgeReconciler.render(<React.StrictMode><Stack space="space.300">
  <SectionMessage title="Read-only evidence view" appearance="information">
    <Text>Review evidence here. To update quality details or record a decision, open the qualityloop issue panel with Edit Issues permission.</Text>
  </SectionMessage>
  <MatchView readOnly />
</Stack></React.StrictMode>);
