#!/usr/bin/env node

import path from 'node:path';
import { fetchPlaylistTracks } from './fetch-playlist-tracks.ts';

const articleDir = path.resolve(process.cwd(), 'docs', 'articles', 'music-february-2026');

fetchPlaylistTracks({
  playlistAddress:
    'nostr:naddr1qvzqqqy9tvpzpy5am98xej9xvetxtg0plszrj5kqznqkc9e4278rgdkdg5gtr6pfqy88wumn8ghj7mn0wvhxcmmv9uq32amnwvaz7tmjv4kxz7fwv3sk6atn9e5k7tcpr9mhxue69uhhyetvv9ujuumwdae8gtnnda3kjctv9uq35amnwvaz7tmjd93x7tn9w5hxummnw3exjcfwv9c8qtcqrdnx2cnjw4shy7fdxgcryd3dxymnwv3sxycrqwpjxvmnjdg05nr',
  articleDir,
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
