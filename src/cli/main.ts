#!/usr/bin/env node
/** Executable entry point of the `adispatch` binary. */
import { createHashPasswordHandler } from './auth.js';
import { createConfigValidateHandler } from './config-validate.js';
import { createConfigReloadHandler, createSchedulerHandler, createShutdownHandler, createStatusHandler } from './control.js';
import { createInitHandler } from './init.js';
import { createProgram, processIo } from './program.js';
import { createServiceInstallHandler, createServiceStatusHandler, createServiceUninstallHandler } from './service.js';
import { createStartHandler } from './start.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

await createProgram(
  {
    init: createInitHandler(processIo),
    start: createStartHandler(processIo),
    configValidate: createConfigValidateHandler(processIo),
    configReload: createConfigReloadHandler(processIo),
    workflowDryRun: createWorkflowDryRunHandler(processIo),
    status: createStatusHandler(processIo),
    pause: createSchedulerHandler('pause', processIo),
    resume: createSchedulerHandler('resume', processIo),
    drain: createShutdownHandler('drain', processIo),
    cancelAll: createShutdownHandler('cancel-all', processIo),
    serviceInstall: createServiceInstallHandler(processIo),
    serviceStatus: createServiceStatusHandler(processIo),
    serviceUninstall: createServiceUninstallHandler(processIo),
    authHashPassword: createHashPasswordHandler(processIo),
  },
  processIo,
).parseAsync(process.argv);
