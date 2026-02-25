#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SimplePool, nip19, type Event } from 'nostr-tools';
import WebSocket from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}

type NostrTag = string[];
type TrackReference =
  | { sourceTag: NostrTag; pointerType: 'e'; id: string }
  | { sourceTag: NostrTag; pointerType: 'a' | 'naddr'; kind: number; pubkey: string; identifier: string };

type ArtistSummary = {
  pubkey: string;
  mention: string;
};

type NormalizedTrack = {
  id: string;
  kind: number;
  created_at: number;
  pubkey: string;
  d: string | null;
  title: string;
  hasVideo: boolean;
  mention: string;
  tags: string[][];
  content: string;
};

export type FetchPlaylistConfig = {
  playlistAddress: string;
  articleDir: string;
  relays?: string[];
};

const DEFAULT_RELAYS = [
  'wss://nos.lol/',
  'wss://relay.damus.io/',
  'wss://relay.snort.social/',
];

function uniqueById<T extends { id?: string }>(events: T[]): T[] {
  const map = new Map<string, T>();
  for (const event of events) {
    if (!event?.id) continue;
    if (!map.has(event.id)) map.set(event.id, event);
  }
  return [...map.values()];
}

function readArg(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function cleanNostrUri(value: string): string {
  if (value.startsWith('nostr:')) return value.slice('nostr:'.length);
  return value;
}

function decodeAddressPointer(input: string) {
  const candidate = cleanNostrUri(input);
  const decoded = nip19.decode(candidate);

  if (decoded.type !== 'naddr') {
    throw new Error(`Expected naddr input, got ${decoded.type}`);
  }

  const { kind, pubkey, identifier } = decoded.data;
  if (!kind || !pubkey || typeof identifier !== 'string') {
    throw new Error('Decoded naddr did not contain kind/pubkey/identifier');
  }

  return {
    type: decoded.type,
    kind,
    pubkey,
    identifier,
    relays: decoded.data.relays || [],
    raw: input,
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function addressKey(kind: number, pubkey: string, identifier: string): string {
  return `${kind}:${pubkey}:${identifier}`;
}

function referenceKey(reference: TrackReference): string {
  if ('id' in reference) {
    return `e:${reference.id}`;
  }

  return `a:${addressKey(reference.kind, reference.pubkey, reference.identifier)}`;
}

function eventAddressKey(event: Event): string | null {
  const identifier = getTagValue(event, 'd');
  if (!identifier) {
    return null;
  }

  return addressKey(event.kind, event.pubkey, identifier);
}

function extractReferences(playlistEvent: Event): TrackReference[] {
  const references: TrackReference[] = [];

  for (const tag of playlistEvent.tags || []) {
    if (!Array.isArray(tag) || tag.length < 2) continue;

    const [name, value] = tag;
    if (name === 'a' && value) {
      const [kindText, pubkey, ...identifierParts] = value.split(':');
      const kind = Number.parseInt(kindText, 10);
      const identifier = identifierParts.join(':');

      if (Number.isFinite(kind) && pubkey && identifier) {
        references.push({
          sourceTag: tag,
          pointerType: 'a',
          kind,
          pubkey,
          identifier,
        });
      }
    }

    if (name === 'e' && value) {
      references.push({
        sourceTag: tag,
        pointerType: 'e',
        id: value,
      });
    }

    if (name === 'naddr' && value) {
      try {
        const pointer = decodeAddressPointer(value);
        references.push({
          sourceTag: tag,
          pointerType: 'naddr',
          kind: pointer.kind,
          pubkey: pointer.pubkey,
          identifier: pointer.identifier,
        });
      } catch {
      }
    }
  }

  return references;
}

function eventHasVideo(event: Event): boolean {
  const tags = event.tags || [];

  const hasVideoTag = tags.some((tag) => {
    if (!Array.isArray(tag) || tag.length === 0) return false;
    const name = (tag[0] || '').toLowerCase();
    if (name !== 'video') return false;
    const value = `${tag[1] || ''}`.trim();
    return value.length > 0 ? value !== '0' && value !== 'false' : true;
  });

  if (hasVideoTag) return true;

  const mediaHints = tags.some((tag) => {
    if (!Array.isArray(tag) || tag.length < 2) return false;
    const [name, value] = tag;
    const lowerName = `${name || ''}`.toLowerCase();
    const lowerValue = `${value || ''}`.toLowerCase();

    if (lowerName === 'm' && lowerValue.startsWith('video/')) return true;
    if (lowerName === 'imeta') return /\bvideo\//.test(lowerValue);
    if (lowerName === 'url' || lowerName === 'r') return /\.(mp4|webm|mov)(\?|$)/.test(lowerValue);

    return false;
  });

  return mediaHints;
}

function getTagValue(event: Event, key: string): string | null {
  for (const tag of event.tags || []) {
    if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
      return tag[1];
    }
  }
  return null;
}

function pickTitle(event: Event): string {
  return (
    getTagValue(event, 'title') ||
    getTagValue(event, 'name') ||
    getTagValue(event, 'subject') ||
    (typeof event.content === 'string' ? event.content.slice(0, 120).trim() : '') ||
    '(untitled track)'
  );
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function hashArtistAlias(pubkey: string): string {
  return `artist_${crypto.createHash('sha1').update(pubkey).digest('hex').slice(0, 10)}`;
}

function ensureRequiredConfig(config: FetchPlaylistConfig): void {
  if (!config.playlistAddress) throw new Error('Missing playlistAddress');
  if (!config.articleDir) throw new Error('Missing articleDir');
}

export async function fetchPlaylistTracks(config: FetchPlaylistConfig): Promise<void> {
  ensureRequiredConfig(config);

  const pool = new SimplePool();
  const playlistAddress = config.playlistAddress;
  const articleDir = path.resolve(config.articleDir);
  const relays = (config.relays && config.relays.length ? config.relays : DEFAULT_RELAYS)
    .map((relay) => relay.trim())
    .filter(Boolean);

  const pointer = decodeAddressPointer(playlistAddress);

  console.log(`Resolving playlist ${pointer.kind}:${pointer.pubkey}:${pointer.identifier}`);
  console.log(`Relays: ${relays.join(', ')}`);

  const playlistFilter = {
    kinds: [pointer.kind],
    authors: [pointer.pubkey],
    '#d': [pointer.identifier],
    limit: 10,
  };

  const playlistEvents = await pool.querySync(relays, playlistFilter, { maxWait: 8000 });
  const playlistEvent = uniqueById(playlistEvents).sort((left, right) => right.created_at - left.created_at)[0];

  if (!playlistEvent) {
    throw new Error('Could not resolve playlist event from provided relays.');
  }

  const references = extractReferences(playlistEvent);
  if (!references.length) {
    throw new Error('Playlist event resolved, but no track references (a/e/naddr tags) were found.');
  }

  const eventIdPointers = [...new Set(references.filter((reference) => 'id' in reference).map((reference) => reference.id))];
  const addressPointers = references.filter(
    (reference): reference is Extract<TrackReference, { kind: number; pubkey: string; identifier: string }> =>
      'kind' in reference && 'pubkey' in reference && 'identifier' in reference
  );

  let trackEvents: Event[] = [];

  for (const idsChunk of chunk(eventIdPointers, 50)) {
    const events = await pool.querySync(
      relays,
      {
        ids: idsChunk,
        limit: idsChunk.length,
      },
      { maxWait: 8000 }
    );
    trackEvents.push(...events);
  }

  for (const pointerChunk of chunk(addressPointers, 20)) {
    const grouped = new Map<string, { kind: number; pubkey: string; identifiers: string[] }>();

    for (const pointerItem of pointerChunk) {
      const key = `${pointerItem.kind}:${pointerItem.pubkey}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          kind: pointerItem.kind,
          pubkey: pointerItem.pubkey,
          identifiers: [],
        });
      }
      grouped.get(key)?.identifiers.push(pointerItem.identifier);
    }

    for (const group of grouped.values()) {
      const events = await pool.querySync(
        relays,
        {
          kinds: [group.kind],
          authors: [group.pubkey],
          '#d': [...new Set(group.identifiers)],
          limit: 200,
        },
        { maxWait: 8000 }
      );
      trackEvents.push(...events);
    }
  }

  trackEvents = uniqueById(trackEvents);

  const byEventId = new Map<string, Event>();
  const byAddress = new Map<string, Event>();

  for (const event of trackEvents) {
    byEventId.set(event.id, event);

    const key = eventAddressKey(event);
    if (!key) continue;

    const existing = byAddress.get(key);
    if (!existing || event.created_at > existing.created_at) {
      byAddress.set(key, event);
    }
  }

  const orderedTrackEvents: Event[] = [];
  const usedEventIds = new Set<string>();
  const seenReferenceKeys = new Set<string>();

  for (const reference of references) {
    const key = referenceKey(reference);
    if (seenReferenceKeys.has(key)) {
      continue;
    }
    seenReferenceKeys.add(key);

    const event = 'id' in reference
      ? byEventId.get(reference.id)
      : byAddress.get(addressKey(reference.kind, reference.pubkey, reference.identifier));

    if (!event || usedEventIds.has(event.id)) {
      continue;
    }

    orderedTrackEvents.push(event);
    usedEventIds.add(event.id);
  }

  const unmatchedTrackEvents = trackEvents
    .filter((event) => !usedEventIds.has(event.id))
    .sort((left, right) => left.created_at - right.created_at);

  trackEvents = [...orderedTrackEvents, ...unmatchedTrackEvents];

  const tracksDir = path.join(articleDir, 'data', 'tracks');
  ensureDirectory(tracksDir);

  const artists = new Map<string, ArtistSummary>();
  const normalizedTracks: NormalizedTrack[] = trackEvents.map((event) => {
    const artistPubkey = event.pubkey;
    if (!artists.has(artistPubkey)) {
      artists.set(artistPubkey, {
        pubkey: artistPubkey,
        mention: `@${hashArtistAlias(artistPubkey)}`,
      });
    }

    return {
      id: event.id,
      kind: event.kind,
      created_at: event.created_at,
      pubkey: event.pubkey,
      d: getTagValue(event, 'd'),
      title: pickTitle(event),
      hasVideo: eventHasVideo(event),
      mention: artists.get(artistPubkey)?.mention || `@${hashArtistAlias(artistPubkey)}`,
      tags: event.tags,
      content: event.content,
    };
  });

  for (const event of trackEvents) {
    const trackPath = path.join(tracksDir, `${event.id}.json`);
    fs.writeFileSync(trackPath, JSON.stringify(event, null, 2));
  }

  const currentTrackFiles = new Set(trackEvents.map((event) => `${event.id}.json`));
  const existingTrackFiles = fs
    .readdirSync(tracksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .filter((name) => name !== 'index.json');

  for (const fileName of existingTrackFiles) {
    if (currentTrackFiles.has(fileName)) continue;
    fs.rmSync(path.join(tracksDir, fileName));
  }

  const playlistEventPath = path.join(articleDir, 'data', 'playlist-event.json');
  fs.writeFileSync(playlistEventPath, JSON.stringify(playlistEvent, null, 2));

  const indexPath = path.join(tracksDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(normalizedTracks, null, 2));

  const artistsPath = path.join(articleDir, 'data', 'artists.json');
  fs.writeFileSync(artistsPath, JSON.stringify([...artists.values()], null, 2));

  const summary = {
    generatedAt: new Date().toISOString(),
    playlist: {
      rawAddress: playlistAddress,
      kind: pointer.kind,
      pubkey: pointer.pubkey,
      identifier: pointer.identifier,
      eventId: playlistEvent.id,
      title: pickTitle(playlistEvent),
    },
    relays,
    counts: {
      references: references.length,
      trackEvents: normalizedTracks.length,
      artists: artists.size,
      tracksWithVideo: normalizedTracks.filter((track) => track.hasVideo).length,
    },
    files: {
      playlistEvent: path.relative(process.cwd(), playlistEventPath),
      tracksIndex: path.relative(process.cwd(), indexPath),
      artists: path.relative(process.cwd(), artistsPath),
    },
  };

  const summaryPath = path.join(articleDir, 'data', 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`Saved ${normalizedTracks.length} track events to ${path.relative(process.cwd(), tracksDir)}`);
  console.log(`Summary: ${path.relative(process.cwd(), summaryPath)}`);

  pool.close(relays);
}

function parseCliConfig(): FetchPlaylistConfig {
  const playlistAddress = readArg('--playlist');
  const articleDir = readArg('--article-dir');
  const relaysArg = readArg('--relays');

  if (!playlistAddress || !articleDir) {
    throw new Error(
      'Usage: tsx scripts/music/fetch-playlist-tracks.ts --playlist=nostr:naddr1... --article-dir=docs/articles/... [--relays=wss://...,wss://...]'
    );
  }

  return {
    playlistAddress,
    articleDir,
    relays: relaysArg
      ? relaysArg
          .split(',')
          .map((relay) => relay.trim())
          .filter(Boolean)
      : undefined,
  };
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  fetchPlaylistTracks(parseCliConfig()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
