import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const html: string[] = cases.map((c) => parse(c.markdown));
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
