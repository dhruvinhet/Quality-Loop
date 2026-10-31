import { buildCapture } from './capture';

export const SAMPLE_LABEL = 'qualityloop-sample';

export function selectSampleIssueType(issueTypes) {
  const standard = issueTypes.filter((type) => type.id && type.subtask === false);
  return standard.find((type) => type.name === 'Task') ?? standard[0];
}

export function sampleDefinitions(today = new Date().toISOString().slice(0, 10)) {
  const ago = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const definitions = [
    { name: 'DEMO CAPA-A', recordType: 'CAPA', partNumber: 'DEMO-4471-A', failureMode: 'FM-01', supplier: 'S-03',
      closedDate: ago(30), effectivenessEvidenceUrl: 'https://example.com/qualityloop/sample-evidence',
      rootCause: 'Fixture clamping stress initiated cracks at the mounting hole.',
      actionsTaken: 'Reduced clamp force and added a fixture setup check.' },
    { name: 'DEMO CAPA-B', recordType: 'CAPA', partNumber: 'DEMO-5520-A', failureMode: 'FM-07', supplier: 'S-05',
      closedDate: ago(45), rootCause: 'Weld current drift caused incomplete fusion.',
      actionsTaken: 'Recalibrated the welder and added a start-of-shift parameter check.' },
    { name: 'DEMO decoy CAPA', recordType: 'CAPA', partNumber: 'DEMO-5520-A', failureMode: 'FM-03',
      closedDate: ago(20) },
    { name: 'DEMO historical NC', recordType: 'NC', partNumber: 'DEMO-4471-A', failureMode: 'FM-01',
      supplier: 'S-03', detectedDate: ago(40) },
    { name: 'DEMO new NC', recordType: 'NC', partNumber: 'DEMO-5520-A', failureMode: 'FM-07',
      supplier: 'S-05', detectedDate: today },
  ];
  return definitions.map(({ name, ...input }) => ({ name, capture: buildCapture(input, `${today}T00:00:00.000Z`) }));
}

// Both conditions are required, even if a caller fetched extra Jira issues.
export function removableSample(storedIds, issue) {
  return storedIds.includes(String(issue?.id)) && issue?.fields?.labels?.includes(SAMPLE_LABEL) === true;
}

export function sampleCreationLines(definitions) {
  return definitions.map(({ name, capture: c }) => `${name}: ${c.recordType}, part ${c.partOriginal}, ${c.failureMode}, supplier ${c.supplier || 'not recorded'}, ${c.recordType === 'CAPA' ? `QualityLoop closure date ${c.closedDate}` : `detected ${c.detectedDate}`}. Effectiveness evidence: ${c.effectivenessEvidenceUrl || 'none'}.${c.rootCause ? ` Root cause: ${c.rootCause}` : ''}${c.actionsTaken ? ` Actions: ${c.actionsTaken}` : ''}`);
}
