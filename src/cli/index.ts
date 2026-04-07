#!/usr/bin/env node
import * as dotenv from 'dotenv';
dotenv.config();

import { buildProgram } from './program.js';

buildProgram().parseAsync(process.argv).catch(err => {
  if (err.code !== 'commander.helpDisplayed') {
    console.error(err.message);
    process.exit(1);
  }
});
