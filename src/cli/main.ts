#!/usr/bin/env node
/** Executable entry point of the `agent-orchestrator` binary. */
import { createProgram } from './program.js';

await createProgram().parseAsync(process.argv);
