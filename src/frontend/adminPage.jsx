import React, { useState } from 'react';
import ForgeReconciler, { Button, Heading, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import { callPage, scanRecordPages } from './pageRunner';
import GettingStarted from './GettingStarted';

const call = (name, payload) => callPage(invoke, name, payload);

function DataPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  async function find() {
    setBusy(true);
    setResult(null);
    setMessage('Checking app records for issues you can browse...');
    try {
      const scan = await call('startOrphanScan');
      const summary = { scanned: 0, backfilled: 0, backfillPending: 0 };
      await scanRecordPages(async (entity, cursor) => {
        const page = await call('findOrphanPage', { token: scan.token, entity, ...(cursor ? { cursor } : {}) });
        summary.scanned += page.scanned;
        summary.backfilled += page.backfilled;
        summary.backfillPending += page.backfillPending;
        return page;
      });
      setResult(summary);
      setMessage(summary.backfillPending ? 'Scan complete. Some index updates need another attempt; scan again.' : 'Scan complete.');
    } catch { setMessage('App records could not be checked. Refresh the page and try again.'); }
    finally { setBusy(false); }
  }
  return <Stack space="space.300">
    <GettingStarted />
    <Heading size="small" as="h2">App data maintenance</Heading>
    <Text>Scan app records for NCs and CAPAs you can browse and update their legacy indexes.</Text>
    <Text>Manual orphan deletion is unavailable because Jira cannot distinguish missing issues from issues you cannot browse. Issue deletion events and confirmed sample removal still clean up associated app records.</Text>
    <Button isDisabled={busy} onClick={find}>Scan accessible app records</Button>
    {message && <Text>{message}</Text>}
    {result && <Text>{`Accessible app records checked: ${result.scanned}. Indexes updated: ${result.backfilled}. Updates pending: ${result.backfillPending}.`}</Text>}
  </Stack>;
}

ForgeReconciler.render(<DataPage />);
