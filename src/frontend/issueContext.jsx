import React from 'react';
import ForgeReconciler, { Stack } from '@forge/react';
import MatchView from './MatchView';
import SecuritySelfTest from './SecuritySelfTest';
import { SEC_TEST } from '../config/devFlags';

ForgeReconciler.render(<React.StrictMode><Stack space="space.300">
  <MatchView readOnly />
  {SEC_TEST && <SecuritySelfTest />}
</Stack></React.StrictMode>);
