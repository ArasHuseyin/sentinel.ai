import { describe, it, expect } from '@jest/globals';
import { WorkflowRecorder } from '../recorder/workflow-recorder.js';

describe('WorkflowRecorder', () => {
  it('starts and stops recording, returning a workflow', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording('My Workflow');
    recorder.record({ type: 'goto', url: 'https://example.com', pageUrl: 'https://example.com', pageTitle: 'Example' });
    recorder.record({ type: 'act', instruction: 'Click login', pageUrl: 'https://example.com', pageTitle: 'Example' });
    const workflow = recorder.stopRecording();

    expect(workflow.name).toBe('My Workflow');
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0]!.type).toBe('goto');
    expect(workflow.steps[1]!.type).toBe('act');
  });

  it('does not record steps when not recording', () => {
    const recorder = new WorkflowRecorder();
    recorder.record({ type: 'act', instruction: 'Click something', pageUrl: '', pageTitle: '' });
    recorder.startRecording();
    const workflow = recorder.stopRecording();

    expect(workflow.steps).toHaveLength(0);
  });

  it('exportAsJSON returns valid JSON with steps', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording('Test');
    recorder.record({ type: 'goto', url: 'https://test.com', pageUrl: 'https://test.com', pageTitle: 'Test' });
    const workflow = recorder.stopRecording();

    const json = recorder.exportAsJSON(workflow);
    const parsed = JSON.parse(json);

    expect(parsed.name).toBe('Test');
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps).toHaveLength(1);
  });

  it('exportAsCode returns TypeScript string containing goto url', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording('Code Export');
    recorder.record({ type: 'goto', url: 'https://example.com', pageUrl: 'https://example.com', pageTitle: '' });
    recorder.record({ type: 'act', instruction: 'Click submit', pageUrl: 'https://example.com', pageTitle: '' });
    const workflow = recorder.stopRecording();

    const code = recorder.exportAsCode(workflow);

    expect(code).toContain('https://example.com');
    expect(code).toContain('Click submit');
    expect(typeof code).toBe('string');
  });

  it('uses default name when none provided', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording();
    const workflow = recorder.stopRecording();

    expect(typeof workflow.name).toBe('string');
    expect(workflow.name.length).toBeGreaterThan(0);
  });

  it('records timestamp on each step', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording();
    recorder.record({ type: 'act', instruction: 'Click', pageUrl: '', pageTitle: '' });
    const workflow = recorder.stopRecording();

    expect(workflow.steps[0]).toHaveProperty('timestamp');
  });

  it('resets steps on new startRecording call', () => {
    const recorder = new WorkflowRecorder();
    recorder.startRecording('First');
    recorder.record({ type: 'act', instruction: 'Step 1', pageUrl: '', pageTitle: '' });
    recorder.stopRecording();

    recorder.startRecording('Second');
    recorder.record({ type: 'act', instruction: 'Step A', pageUrl: '', pageTitle: '' });
    recorder.record({ type: 'act', instruction: 'Step B', pageUrl: '', pageTitle: '' });
    const workflow = recorder.stopRecording();

    expect(workflow.name).toBe('Second');
    expect(workflow.steps).toHaveLength(2);
  });
});
