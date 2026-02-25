#!/usr/bin/env node

import path from 'node:path';
import { buildArticle } from './build-article.ts';

const articleDir = path.resolve(process.cwd(), 'docs', 'articles', 'music-february-2026');

buildArticle({
  articleDir,
  title: 'Music February 2026',
  identifier: 'music-february-2026',
  curatorNpub: 'npub1j2wajnnveznxv4n958slcppe2tqpfstvzu640r35xmx52y93aq5sc8rsr8',
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
