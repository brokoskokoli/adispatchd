#!/usr/bin/env node
/** Executable entry point of the `agent-orchestrator` binary. */
import { createConfigValidateHandler } from './config-validate.js';
import { createProgram, processIo } from './program.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

await createProgram(
  {
    configValidate: createConfigValidateHandler(processIo),
    workflowDryRun: createWorkflowDryRunHandler(processIo),
  },
  processIo,
).parseAsync(process.argv);
