#!/usr/bin/env node
/** Executable entry point of the `adispatch` binary. */
import { HUB_SOCKET_ENV } from '../core/index.js';
import { createHashPasswordHandler } from './auth.js';
import { createConfigValidateHandler } from './config-validate.js';
import { createConfigReloadHandler, createSchedulerHandler, createShutdownHandler, createStatusHandler } from './control.js';
import { createHubGlobalHandler, createHubInitHandler, createHubStartHandler, createHubStatusHandler, createHubValidateHandler, createHubWorkspaceHandler } from './hub.js';
import { createInitHandler } from './init.js';
import { createProgram, processIo } from './program.js';
import { createServiceInstallHandler, createServiceStatusHandler, createServiceUninstallHandler } from './service.js';
import { createStartHandler } from './start.js';
import { createWorkflowDryRunHandler } from './workflow-dry-run.js';

// A workspace started by a hub writes its log to a pipe of the hub. If the hub dies, the pipe breaks; the
// workspace must keep running (its runs are not ours to kill), so a broken pipe is ignored (log lines are lost).
if (process.env[HUB_SOCKET_ENV]) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err;
    });
  }
}

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
    hubInit: createHubInitHandler(processIo),
    hubValidate: createHubValidateHandler(processIo),
    hubStart: createHubStartHandler(processIo),
    hubStatus: createHubStatusHandler(processIo),
    hubPause: createHubGlobalHandler('pause', processIo),
    hubResume: createHubGlobalHandler('resume', processIo),
    hubStopAll: createHubGlobalHandler('stop-all', processIo),
    hubDrainAll: createHubGlobalHandler('drain-all', processIo),
    hubWorkspace: {
      start: createHubWorkspaceHandler('start', processIo),
      stop: createHubWorkspaceHandler('stop', processIo),
      restart: createHubWorkspaceHandler('restart', processIo),
      drain: createHubWorkspaceHandler('drain', processIo),
    },
  },
  processIo,
).parseAsync(process.argv);
