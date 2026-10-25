#!/usr/bin/env node
// Harness adapter only. Replace this process so existing Docker clients exercise the AOT executable.
import fs from 'node:fs';
const executable = process.env.P6_AOT_BINARY || '/opt/p6-artifact/openclaw';
if (typeof process.execve !== 'function') throw new Error('P6 adapter requires Node process.execve');
fs.accessSync(executable, fs.constants.X_OK);
process.execve(executable, [executable, ...process.argv.slice(2)], process.env);
