import React, { useEffect, useRef, useState } from 'react';
import { DynamicTable, Frame, Heading, LoadingButton, Stack, Text } from '@forge/react';
import { events, invoke, view } from '@forge/bridge';
import { runProbes } from './probeRunner';
import { formatResults, summarise } from '../lib/probeResults';

export function CopyResults({ text }) {
  // Events are broadcast; isolate every panel instance with its own channel.
  const [channel, setChannel] = useState(null);
  const latest = useRef(text);
  latest.current = text;
  const [ready, setReady] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    let active = true;
    view.getContext().then(({ localId }) => {
      if (active) setChannel(`qualityloop-e1-${localId}`);
    }).catch(() => { if (active) setCopyError('Copy control could not load. Reopen the panel and retry.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!channel) return;
    let active = true;
    const subscription = events.on(`${channel}:ready`, async () => {
      if (active) {
        setReady(true);
        await events.emit(`${channel}:results`, { text: latest.current });
      }
    });
    subscription.catch(() => { if (active) setCopyError('Copy control could not load. Reopen the panel and retry.'); });
    return () => {
      active = false;
      subscription.then((sub) => sub.unsubscribe()).catch(() => {});
    };
  }, [channel]);
  useEffect(() => {
    if (ready) events.emit(`${channel}:results`, { text }).catch(() => {});
  }, [channel, ready, text]);
  if (copyError) return <Text>{copyError}</Text>;
  return channel ? <Frame resource="probe-clipboard" /> : <Text>Preparing copy control…</Text>;
}

export default function ProbePanel() {
  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setRows([]);
    try {
      await runProbes({
        invoke,
        cancelled: () => !alive.current,
        onRow: (row) => {
          if (alive.current) setRows((previous) => [...previous.filter((item) => item.run !== row.run), row]);
        },
      });
    } finally {
      busy.current = false;
      if (alive.current) setRunning(false);
    }
  };
  const summary = summarise(rows);
  return <Stack space="space.200">
    <Heading size="small" as="h2">E1 indexing timing probe</Heading>
    <Text>Writes qualityloop-probe on this issue. Keep this panel open. Twenty sequential runs can take up to 20 minutes.</Text>
    <Text>Write ms measures the resolver PUT. Search-hit ms starts at the frontend write acknowledgement and includes readback, polling and bridge latency. Poll interval: 1 s; deadline: 60 s. API errors are reported separately from misses.</Text>
    <LoadingButton isLoading={running} isDisabled={running} onClick={run}>Run 20 probes</LoadingButton>
    {rows.length > 0 && <>
      <Text>{`${rows.filter((row) => row.searchHitMs !== null).length}/20 runs complete${running ? ' — running' : ''}`}</Text>
      <DynamicTable caption="E1 probe results" head={{ cells: [
        { key: 'run', content: 'Run' }, { key: 'write', content: 'Write ms' },
        { key: 'read', content: 'Readback ok' }, { key: 'search', content: 'Search-hit ms' },
        { key: 'error', content: 'Error' },
      ] }} rows={rows.map((row) => ({
        key: String(row.run),
        cells: [row.run, row.writeMs ?? 'pending', row.readbackOk === null ? 'pending' : String(row.readbackOk), row.searchHitMs ?? 'pending', row.error ?? '']
          .map((content) => ({ content: String(content) })),
      }))} />
      {!running && <>
        <Text>{`Search-hit ms: min ${summary.min ?? 'n/a'}, median ${summary.median ?? 'n/a'}, max ${summary.max ?? 'n/a'}; misses ${summary.misses}; errors ${summary.errors}.`}</Text>
        <CopyResults text={formatResults(rows)} />
      </>}
    </>}
  </Stack>;
}
