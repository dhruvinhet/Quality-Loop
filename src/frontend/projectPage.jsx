import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Heading, Link, Stack, Text } from '@forge/react';
import { invoke } from '@forge/bridge';
import PageConfirmation from './PageConfirmation';
import { callPage, pollSampleReady, scanRecordPages } from './pageRunner';
import ProjectSearchSettings from './ProjectSearchSettings';

const call = (name, payload) => callPage(invoke, name, payload);

export function SamplePage() {
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
    <Heading size="small" as="h2">How to try this</Heading>
    <Text>1. Create the sample scenario below. Review the five issue writes and confirm.</Text>
    <Text>2. {ready ? <>Open the DEMO new NC <Link href={`/browse/${encodeURIComponent(ready.newNcKey)}`}>{ready.newNcKey}</Link>.</>
      : 'Wait for the sample to be ready, or use Check sample readiness. Then open the DEMO new NC.'} Open QualityLoop from the apps icon under the issue title and click Save.</Text>
    <Text>3. Review the DEMO CAPA-B match and any hints. Record an engineer decision with a reason.</Text>
    <ProjectSearchSettings />
    <Text>Creates five labelled DEMO issues in this project. It never edits existing issues.</Text>
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
    {reports.map((report, index) => <Text key={index}>{report}</Text>)}
    {dialog && <PageConfirmation title={dialog.title} lines={dialog.lines} onCancel={() => setDialog(null)} onConfirm={confirm} />}
  </Stack>;
}

ForgeReconciler.render(<SamplePage />);
