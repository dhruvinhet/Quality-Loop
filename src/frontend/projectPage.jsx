import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Link, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import PageConfirmation from './PageConfirmation';
import { callPage, pollSampleReady, scanRecordPages } from './pageRunner';

const call = (name, payload) => callPage(invoke, name, payload);

function SamplePage() {
  const [sample, setSample] = useState(null);
  const [busy, setBusy] = useState(true);
  const [dialog, setDialog] = useState(null);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(null);
  const [reports, setReports] = useState([]);
  const load = async () => setSample(await call('sampleStatus'));
  useEffect(() => { load().catch((error) => setMessage(error.message)).finally(() => setBusy(false)); }, []);

  async function run(fn) {
    setBusy(true);
    setMessage('');
    try { await fn(); }
    catch (error) { setMessage(error.message); }
    finally {
      try { await load(); } catch (error) { setMessage(error.message); }
      setBusy(false);
    }
  }
  async function checkReady() {
    setMessage('Waiting for Jira to index the three sample CAPAs (up to 30 seconds)...');
    const result = await pollSampleReady(() => call('sampleReadiness'));
    setReady(result.ready ? result : null);
    setMessage(result.ready ? '' : 'The sample was created, but Jira search was not ready within 30 seconds. Use Check sample readiness to try again.');
  }
  async function confirm() {
    const confirmed = dialog;
    setDialog(null);
    await run(async () => {
      setReady(null);
      setReports([]);
      if (confirmed.kind === 'create') {
        await call('startSample', { token: confirmed.token, confirmed: true });
        let done = false;
        while (!done) {
          setMessage('Creating the sample scenario...');
          done = (await call('advanceSample')).done;
        }
        await checkReady();
      } else {
        const payload = { token: confirmed.token, confirmed: true };
        await call('startSampleRemoval', payload);
        for (let index = 0; index < confirmed.keys.length; index += 1) {
          setMessage('Removing confirmed sample issues...');
          await call('removeSampleIssue', { ...payload, index });
        }
        setMessage('Removing app records for the deleted sample issues...');
        await scanRecordPages((entity, cursor) => call('cleanupSamplePage', { ...payload, entity, ...(cursor ? { cursor } : {}) }));
        const result = await call('finishSampleRemoval', payload);
        setReports(result.reports);
        setMessage(result.message);
      }
    });
  }
  return <Stack>
    <Text>Create an optional, isolated sample for reviewing QualityLoop. This page shows sample data only.</Text>
    <Button isDisabled={busy || !sample || sample.exists} onClick={() => run(async () => {
      const plan = await call('prepareSample');
      setDialog({ ...plan, kind: 'create', title: 'Create sample scenario (5 issues)' });
    })}>Create sample scenario (5 issues)</Button>
    <Button isDisabled={busy || !sample?.exists} onClick={() => run(async () => {
      const plan = await call('prepareSampleRemoval');
      setDialog({ ...plan, kind: 'remove', title: 'Remove sample scenario',
        lines: [...plan.keys, plan.note, ...(plan.warning ? [plan.warning] : [])] });
    })}>Remove sample scenario</Button>
    {sample?.issues?.map(({ key }) => <Text key={key}><Link href={`/browse/${encodeURIComponent(key)}`}>{key}</Link></Text>)}
    {sample?.notes?.map((note) => <Text key={note}>{note}</Text>)}
    {sample?.status === 'complete' && <Button isDisabled={busy} onClick={() => run(checkReady)}>Check sample readiness</Button>}
    {message && <Text>{message}</Text>}
    {ready && <Text>Ready. Open <Link href={`/browse/${encodeURIComponent(ready.newNcKey)}`}>{ready.newNcKey}</Link> and look at QualityLoop: it should show a signature match with DEMO CAPA-B, and that CAPA-B has no effectiveness evidence recorded.</Text>}
    {reports.map((report, index) => <Text key={index}>{report}</Text>)}
    {dialog && <PageConfirmation title={dialog.title} lines={dialog.lines} onCancel={() => setDialog(null)} onConfirm={confirm} />}
  </Stack>;
}

ForgeReconciler.render(<SamplePage />);
