#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';

export type PackageArticleConfig = {
  articleDir: string;
  outZip: string;
  eventFile?: string;
};

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.svg',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mkv',
  '.avi',
]);

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function walkFilesRecursive(rootDir: string, ignoredDirNames: Set<string>): string[] {
  const result: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirNames.has(entry.name)) continue;
        stack.push(absolute);
      } else if (entry.isFile()) {
        result.push(absolute);
      }
    }
  }

  return result;
}

function isMediaFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(extension);
}

function pickEventInputFile(articleDir: string, explicitFile?: string): string {
  if (explicitFile) {
    const resolved = path.resolve(explicitFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configured event file does not exist: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [
    path.join(articleDir, 'event.json'),
    path.join(articleDir, 'nostr-event.json'),
    path.join(articleDir, 'nostr-event.unsigned.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find event JSON in ${articleDir}. Expected one of: event.json, nostr-event.json, nostr-event.unsigned.json`
  );
}

function makeUniqueBaseName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let index = 2;

  while (true) {
    const candidate = `${stem}-${index}${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function ensureRequiredConfig(config: PackageArticleConfig): void {
  if (!config.articleDir) throw new Error('Missing articleDir');
  if (!config.outZip) throw new Error('Missing outZip');
}

export async function packageArticle(config: PackageArticleConfig): Promise<void> {
  ensureRequiredConfig(config);

  const articleDir = path.resolve(config.articleDir);
  const outZip = path.resolve(config.outZip);

  if (!fs.existsSync(articleDir)) {
    throw new Error(`Article directory does not exist: ${articleDir}`);
  }

  const eventInputFile = pickEventInputFile(articleDir, config.eventFile);
  const eventRaw = fs.readFileSync(eventInputFile);

  const zip = new AdmZip();
  zip.addFile('event.json', eventRaw);

  const zipStem = path.basename(outZip, path.extname(outZip));
  const ignoredDirNames = new Set<string>(['data', zipStem]);
  const allFiles = walkFilesRecursive(articleDir, ignoredDirNames);
  const mediaFiles = allFiles.filter((filePath) => {
    if (path.resolve(filePath) === path.resolve(eventInputFile)) return false;
    if (path.resolve(filePath) === path.resolve(outZip)) return false;
    return isMediaFile(filePath);
  });

  const usedNames = new Set<string>(['event.json']);
  const mapping: Array<{ source: string; zipName: string }> = [];

  for (const mediaFile of mediaFiles) {
    const baseName = path.basename(mediaFile);
    const zipName = makeUniqueBaseName(baseName, usedNames);
    zip.addLocalFile(mediaFile, '', zipName);
    mapping.push({
      source: path.relative(process.cwd(), mediaFile),
      zipName,
    });
  }

  ensureDirectory(path.dirname(outZip));
  zip.writeZip(outZip);

  console.log(`Wrote ${path.relative(process.cwd(), outZip)}`);
  console.log(`Included event.json from ${path.relative(process.cwd(), eventInputFile)}`);
  console.log(`Included ${mapping.length} media file(s) in flat structure.`);

  const manifestPath = path.join(articleDir, 'data', 'package-manifest.json');
  ensureDirectory(path.dirname(manifestPath));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        zipFile: path.relative(process.cwd(), outZip),
        eventInputFile: path.relative(process.cwd(), eventInputFile),
        mediaCount: mapping.length,
        media: mapping,
      },
      null,
      2
    )
  );

  console.log(`Wrote ${path.relative(process.cwd(), manifestPath)}`);
}

function parseCliConfig(): PackageArticleConfig {
  const articleDir = readArg('--article-dir');
  const outZip = readArg('--out-zip');
  const eventFile = readArg('--event-file') || undefined;

  if (!articleDir || !outZip) {
    throw new Error(
      'Usage: tsx scripts/music/package-article.ts --article-dir=docs/articles/... --out-zip=docs/articles/.../publish.zip [--event-file=docs/articles/.../nostr-event.unsigned.json]'
    );
  }

  return {
    articleDir,
    outZip,
    eventFile,
  };
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  packageArticle(parseCliConfig()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
