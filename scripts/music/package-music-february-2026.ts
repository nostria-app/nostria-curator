#!/usr/bin/env node

import path from 'node:path';
import { packageArticle } from './package-article.ts';

const articleDir = path.resolve(process.cwd(), 'docs', 'articles', 'music-february-2026');
const outZip = path.join(articleDir, 'music-february-2026.zip');

packageArticle({
  articleDir,
  outZip,
  eventFile: path.join(articleDir, 'nostr-event.unsigned.json'),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
