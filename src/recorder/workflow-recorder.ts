export interface RecordedAction {
  type: 'act' | 'extract' | 'observe' | 'goto' | 'scroll' | 'press';
  instruction?: string;
  url?: string;
  value?: string;
  timestamp: number;
  pageUrl: string;
  pageTitle: string;
}

export interface RecordedWorkflow {
  name: string;
  createdAt: string;
  steps: RecordedAction[];
}

/**
 * Records Sentinel actions and exports them as replayable workflows.
 */
export class WorkflowRecorder {
  private recording = false;
  private steps: RecordedAction[] = [];
  private workflowName: string;

  constructor(name = 'recorded-workflow') {
    this.workflowName = name;
  }

  startRecording(name?: string): void {
    if (name) this.workflowName = name;
    this.steps = [];
    this.recording = true;
    console.log(`[Recorder] 🔴 Recording started: "${this.workflowName}"`);
  }

  stopRecording(): RecordedWorkflow {
    this.recording = false;
    const workflow: RecordedWorkflow = {
      name: this.workflowName,
      createdAt: new Date().toISOString(),
      steps: [...this.steps],
    };
    console.log(`[Recorder] ⏹️  Recording stopped. ${this.steps.length} step(s) captured.`);
    return workflow;
  }

  record(action: Omit<RecordedAction, 'timestamp'>): void {
    if (!this.recording) return;
    this.steps.push({ ...action, timestamp: Date.now() });
  }

  isRecording(): boolean {
    return this.recording;
  }

  exportAsJSON(workflow: RecordedWorkflow): string {
    return JSON.stringify(workflow, null, 2);
  }

  exportAsCode(workflow: RecordedWorkflow): string {
    const lines: string[] = [
      `import { Sentinel } from '@isoldex/sentinel';`,
      `import * as dotenv from 'dotenv';`,
      `dotenv.config();`,
      ``,
      `// Recorded workflow: "${workflow.name}"`,
      `// Created: ${workflow.createdAt}`,
      ``,
      `async function run() {`,
      `  const sentinel = new Sentinel({`,
      `    apiKey: process.env.GEMINI_API_KEY!,`,
      `    headless: false,`,
      `    verbose: 1,`,
      `  });`,
      `  await sentinel.init();`,
      ``,
    ];

    for (const step of workflow.steps) {
      switch (step.type) {
        case 'goto':
          lines.push(`  await sentinel.goto('${step.url}');`);
          break;
        case 'act':
          lines.push(`  await sentinel.act('${step.instruction?.replace(/'/g, "\\'")}');`);
          break;
        case 'extract':
          lines.push(`  // await sentinel.extract('${step.instruction?.replace(/'/g, "\\'")}', schema);`);
          break;
        case 'observe':
          lines.push(`  await sentinel.observe(${step.instruction ? `'${step.instruction.replace(/'/g, "\\'")}'` : ''});`);
          break;
        case 'scroll':
          lines.push(`  await sentinel.act('${step.instruction?.replace(/'/g, "\\'")}');`);
          break;
        case 'press':
          lines.push(`  await sentinel.act('Press ${step.value}');`);
          break;
      }
    }

    lines.push(``, `  await sentinel.close();`, `}`, ``, `run();`);
    return lines.join('\n');
  }
}
