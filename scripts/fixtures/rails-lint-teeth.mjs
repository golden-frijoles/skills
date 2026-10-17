// The rails lint's teeth (template-scripts-consumer-gates D2): CI lints this file with --no-ignore and expects it to
// FAIL. The unused import below is the defect consumers' gates caught twice; if this ever lints clean, the gate is off.
import { readFileSync } from 'node:fs';
