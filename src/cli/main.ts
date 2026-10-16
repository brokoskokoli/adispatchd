#!/usr/bin/env node
/** Executable entry point of the `agent-orchestrator` binary. */
import { createConfigValidateHandler } from './config-validate.js';
import { createProgram, processIo } from './program.js';

await createProgram({ configValidate: createConfigValidateHandler(processIo) }, processIo).parseAsync(process.argv);
