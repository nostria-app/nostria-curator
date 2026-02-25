#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nip19, SimplePool, type Event } from 'nostr-tools';
import WebSocket from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}

type NostrTag = string[];

type PlaylistSummary = {
    rawAddress: string;
    kind: number;
    pubkey: string;
    identifier: string;
};

type Summary = {
    playlist: PlaylistSummary;
};

type Track = {
    id: string;
    kind: number;
    created_at: number;
    pubkey: string;
    d: string | null;
    title: string;
    hasVideo: boolean;
    mention: string;
    tags: NostrTag[];
    content: string;
};

type Artist = {
    pubkey: string;
    npub: string;
    mention: string;
    displayName: string;
    shortNote: string;
    relayHints: string[];
};

type ProfileMetadata = {
    name?: string;
    display_name?: string;
    displayName?: string;
    username?: string;
    nip05?: string;
    picture?: string;
    about?: string;
    lud16?: string;
    lud06?: string;
};

type ResolvedProfile = {
    pubkey: string;
    profileEventId: string;
    displayName: string | null;
    metadata: ProfileMetadata;
    outboxRelays: string[];
};

export type BuildArticleConfig = {
    articleDir: string;
    title: string;
    identifier: string;
    curatorNpub: string;
    indexerRelays?: string[];
};

const DEFAULT_INDEXER_RELAYS = [
    'wss://discovery.eu.nostria.app/',
    'wss://indexer.coracle.social/',
];
const DEFAULT_PROFILE_FALLBACK_RELAYS = [
    'wss://nos.lol/',
    'wss://relay.damus.io/',
];
const MAX_TRACK_RELAY_HINTS = 3;
const PREFERRED_RELAY_HINTS = [
    'wss://relay.damus.io/',
    'wss://relay.primal.net/',
    'wss://nos.lol/',
    'wss://relay.wavlake.com/',
];
const EXCLUDED_RELAY_HINTS = new Set([
    'wss://purplepag.es/',
    'wss://indexer.coracle.social/',
    'wss://relay.nostr.band/',
    'wss://offchain.pub/',
]);

function readArg(name: string): string | null {
    const prefix = `${name}=`;
    const found = process.argv.find((argument) => argument.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function readJson<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function getTagValue(tags: NostrTag[] | undefined, key: string): string | null {
    if (!Array.isArray(tags)) return null;
    for (const tag of tags) {
        if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === 'string') {
            return tag[1];
        }
    }
    return null;
}

function shortenNpub(npub: string): string {
    if (npub.length < 18) return npub;
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

function stripLeadingAt(value: string): string {
    return value.replace(/^@+/, '');
}

function formatNostrNpub(npub: string): string {
    const cleaned = npub.replace(/^nostr:/i, '').trim();
    return `nostr:${cleaned}`;
}

function ensureDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true });
}

const DEFAULT_ARTICLE_NOTES_TEMPLATE = [
    '# Curator notes',
    '',
    'Write this issue like a human conversation with readers, not a technical changelog.',
    '',
    '- Start with the mood/theme of this month\'s playlist.',
    '- Mention 2-4 standout moments or tracks and why they hit.',
    '- Keep the tone warm, personal, and concise.',
    '- Close with a friendly call to zap and support artists on Nostr.',
    '',
].join('\n');

function ensureArticleNotesFile(articleDir: string): string {
    const notesPath = path.join(articleDir, 'article-notes.md');
    if (!fs.existsSync(notesPath)) {
        fs.writeFileSync(notesPath, DEFAULT_ARTICLE_NOTES_TEMPLATE);
    }

    return notesPath;
}

function readArticleNotes(articleDir: string): string {
    const notesPath = ensureArticleNotesFile(articleDir);
    return fs.readFileSync(notesPath, 'utf8').trim();
}

function normalizeCuratorNotesForArticle(rawNotes: string): string {
    if (!rawNotes.trim()) {
        return 'Add your editorial voice in `article-notes.md`, then run `npm run music:build` again to include it here.';
    }

    const lines = rawNotes.split(/\r?\n/);
    let startIndex = 0;
    if (lines.length > 0 && /^#\s*curator\s+notes\s*$/i.test(lines[0].trim())) {
        startIndex = 1;
    }

    const body = lines.slice(startIndex).join('\n').trim();
    if (!body) {
        return 'Add your editorial voice in `article-notes.md`, then run `npm run music:build` again to include it here.';
    }

    const looksLikeLegacyTemplate =
        /Write your editorial story here/i.test(body) ||
        /Optional:\s/i.test(body);

    if (looksLikeLegacyTemplate) {
        return [
            'This month has a strong mix of moods — from reflective moments to high-energy cuts — and it really shows how wide the creative range on Nostr has become.',
            '',
            'If you\'re new to these artists, start with a couple of tracks that immediately catch your ear, then follow and zap the creators you connect with most.',
        ].join('\n');
    }

    return body;
}

function buildHumanLead(tracks: Track[]): string {
    const withVideo = tracks.filter((track) => track.hasVideo).length;
    const total = tracks.length;

    return `This month\'s selection feels like a journey across scenes and styles on Nostr: ${total} tracks from independent artists, with ${withVideo} track${withVideo === 1 ? '' : 's'} carrying video metadata for a richer in-app listening experience.`;
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const titlePattern = new RegExp(`^#\\s+${escapedTitle}\\s*\\r?\\n+`, 'i');
    const withoutTitle = markdown.replace(titlePattern, '');
    return withoutTitle.trimStart();
}

function findMediaByStem(articleDir: string, stem: string): string | null {
    const mediaExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];
    const candidates: string[] = [];

    for (const ext of mediaExtensions) {
        candidates.push(path.join(articleDir, 'media', `${stem}${ext}`));
        candidates.push(path.join(articleDir, `${stem}${ext}`));
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return path.basename(candidate);
        }
    }

    return null;
}

function normalizeRelayUrl(url: string): string {
    return `${url.trim().replace(/\/+$/, '')}/`;
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function capRelayHints(relays: string[], maxHints = MAX_TRACK_RELAY_HINTS): string[] {
    return unique(relays).slice(0, Math.max(0, maxHints));
}

function isValidRelayHint(relay: string): boolean {
    if (!relay) return false;
    if (!/^wss?:\/\//i.test(relay)) return false;
    if (/\s/.test(relay)) return false;
    if (relay.includes('%20')) return false;
    if (relay.includes(' avatar ')) return false;
    return true;
}

function selectRelayHints(relays: string[], maxHints = MAX_TRACK_RELAY_HINTS): string[] {
    const normalized = unique(relays.map(normalizeRelayUrl))
        .filter((relay) => isValidRelayHint(relay))
        .filter((relay) => !EXCLUDED_RELAY_HINTS.has(relay));
    const preferredNormalized = PREFERRED_RELAY_HINTS.map(normalizeRelayUrl);
    const preferred = preferredNormalized.filter((relay) => normalized.includes(relay));
    const remainder = normalized.filter((relay) => !preferred.includes(relay));
    return capRelayHints([...preferred, ...remainder], maxHints);
}

function parseProfileMetadata(event: Event): ProfileMetadata {
    try {
        const parsed = JSON.parse(event.content) as ProfileMetadata;
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch {
    }
    return {};
}

function pickProfileName(metadata: ProfileMetadata): string | null {
    const candidates = [
        metadata.display_name,
        metadata.displayName,
        metadata.name,
        metadata.username,
        metadata.nip05,
    ];

    for (const value of candidates) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }

    return null;
}

function buildArtistShortNote(displayName: string, metadata: ProfileMetadata | null | undefined): string {
    const about = typeof metadata?.about === 'string' ? metadata.about : '';
    const rawSegments = about
        .split(/::|\r?\n+/)
        .map((segment) => segment.trim())
        .filter(Boolean);

    const normalized = about
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/["“”'’]/g, '')
        .replace(/#[\w-]+/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();

    if (!normalized) {
        return `${displayName} brings a distinct sound and perspective to this curated set.`;
    }

    if (/moonlit forests|sunlit riverbanks|indie duo/.test(normalized) && /budapest|hungary/.test(normalized)) {
        return `${displayName} channels moonlit, nature-soaked indie songwriting as a duo rooted in Budapest.`;
    }

    if (/belgian|couple|off-?grid|portugal|consciousness|transformation/.test(normalized)) {
        return `${displayName} brings an intimate, off-grid creative energy with a strong sense of transformation.`;
    }

    if (/v4v|decentralized|independent artist|independent artists|cannabis records|management/.test(normalized)) {
        return `${displayName} leans into the independent, decentralized spirit that defines this month’s mix.`;
    }

    if (/developer|relations|wiki|bridge|app|soapbox|nostrnests|yakbak|zaptrax|podstr/.test(normalized)) {
        return `${displayName} brings a builder’s mindset to music culture, blending creation and community.`;
    }

    if (/basspistol|co-?founder|planet|public key|choomscroll/.test(normalized)) {
        return `${displayName} adds a bold DIY edge with deep roots in Nostr-native music communities.`;
    }

    if (/purple pill|orange pill|bitcoin/.test(normalized)) {
        return `${displayName} adds playful Bitcoin-native energy and personality to the playlist flow.`;
    }

    if (/dj|producer|electronic|ambient|techno|house|soundtrack|experimental/.test(normalized)) {
        return `${displayName} brings a crafted sonic identity that expands the texture of this issue.`;
    }

    const firstSegment = rawSegments[0]
        ?.replace(/https?:\/\/\S+/gi, '')
        .replace(/["“”'’]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (firstSegment && firstSegment.length >= 8) {
        const concise = firstSegment.length > 110
            ? `${firstSegment.slice(0, 107).trimEnd()}...`
            : firstSegment;
        return `${displayName} brings ${concise.charAt(0).toLowerCase()}${concise.slice(1)}.`;
    }

    return `${displayName} adds a distinct voice to this month’s curation.`;
}

function extractOutboxRelaysFrom10002(event: Event): string[] {
    const result: string[] = [];

    for (const tag of event.tags) {
        if (!Array.isArray(tag) || tag[0] !== 'r') continue;
        const relay = tag[1];
        const marker = tag[2];
        if (typeof relay !== 'string' || relay.trim().length === 0) continue;

        if (!marker || marker === 'write') {
            result.push(normalizeRelayUrl(relay));
        }
    }

    return unique(result);
}

function pickLatestEvent(events: Event[]): Event | null {
    if (!events.length) return null;
    return [...events].sort((left, right) => right.created_at - left.created_at)[0] || null;
}

async function resolveOutboxRelaysByPubkey(
    pool: SimplePool,
    pubkeys: string[],
    indexerRelays: string[]
): Promise<Map<string, string[]>> {
    const outboxByPubkey = new Map<string, string[]>();
    const events = await pool.querySync(
        indexerRelays,
        {
            kinds: [10002],
            authors: pubkeys,
            limit: Math.max(pubkeys.length * 2, 100),
        },
        { maxWait: 8000 }
    );

    const latestByAuthor = new Map<string, Event>();
    for (const event of events) {
        const existing = latestByAuthor.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
            latestByAuthor.set(event.pubkey, event);
        }
    }

    for (const pubkey of pubkeys) {
        const event = latestByAuthor.get(pubkey);
        const outboxRelays = event ? extractOutboxRelaysFrom10002(event) : [];
        outboxByPubkey.set(pubkey, outboxRelays);
    }

    return outboxByPubkey;
}

async function resolveProfilesByOutbox(
    pool: SimplePool,
    pubkeys: string[],
    outboxByPubkey: Map<string, string[]>,
    indexerRelays: string[],
    fallbackProfileRelays: string[]
): Promise<Map<string, ResolvedProfile>> {
    const resolved = new Map<string, ResolvedProfile>();

    for (const pubkey of pubkeys) {
        const outboxRelays = outboxByPubkey.get(pubkey) || [];
        const primaryRelays = unique([...outboxRelays, ...indexerRelays]);
        const fallbackRelays = unique([...fallbackProfileRelays, ...indexerRelays]);

        let profileEvents: Event[] = [];
        if (primaryRelays.length) {
            profileEvents = await pool.querySync(
                primaryRelays,
                {
                    kinds: [0],
                    authors: [pubkey],
                    limit: 10,
                },
                { maxWait: 7000 }
            );
        }

        if (!profileEvents.length && fallbackRelays.length) {
            profileEvents = await pool.querySync(
                fallbackRelays,
                {
                    kinds: [0],
                    authors: [pubkey],
                    limit: 10,
                },
                { maxWait: 7000 }
            );
        }

        const latest = pickLatestEvent(profileEvents);
        if (!latest) {
            continue;
        }

        const metadata = parseProfileMetadata(latest);
        const displayName = pickProfileName(metadata);

        resolved.set(pubkey, {
            pubkey,
            profileEventId: latest.id,
            displayName,
            metadata,
            outboxRelays,
        });
    }

    return resolved;
}

function buildArtistList(tracks: Track[], profilesByPubkey: Map<string, ResolvedProfile>): Artist[] {
    const artistMap = new Map<string, Artist>();

    for (const track of tracks) {
        if (!track?.pubkey) continue;

        if (!artistMap.has(track.pubkey)) {
            const npub = nip19.npubEncode(track.pubkey);
            const artistName = getTagValue(track.tags, 'artist');
            const resolvedProfile = profilesByPubkey.get(track.pubkey);
            const profileName = resolvedProfile?.displayName || null;
            artistMap.set(track.pubkey, {
                pubkey: track.pubkey,
                npub,
                mention: npub,
                displayName: profileName || artistName || shortenNpub(npub),
                shortNote: buildArtistShortNote(profileName || artistName || shortenNpub(npub), resolvedProfile?.metadata),
                relayHints: selectRelayHints(resolvedProfile?.outboxRelays || []),
            });
        }
    }

    return [...artistMap.values()];
}

function buildTrackLines(tracks: Track[], artistByPubkey: Map<string, Artist>): string[] {
    return tracks.map((track, index) => {
        const artist = artistByPubkey.get(track.pubkey);
        if (!artist) {
            throw new Error(`Could not find artist for pubkey ${track.pubkey}`);
        }

        const dTag = track.d || getTagValue(track.tags, 'd') || '';
        const relayHints = artist.relayHints;
        const naddr = dTag
            ? `nostr:${nip19.naddrEncode({ kind: track.kind, pubkey: track.pubkey, identifier: dTag, relays: relayHints })}`
            : `nostr:${nip19.neventEncode({ id: track.id, author: track.pubkey, relays: relayHints })}`;

        const displayNamePattern = new RegExp(`^${artist.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i');
        const shortNote = artist.shortNote.replace(displayNamePattern, '').trim();

        const lines = [
            `**${track.title}**`,
            '',
            `${formatNostrNpub(artist.npub)} (${artist.displayName}) ${shortNote}`,
        ];

        if (track.hasVideo) {
            lines.push('', 'This track includes a music video.');
        }

        lines.push('', naddr);

        return lines.join('\n');
    });
}

function buildMarkdown(params: {
    title: string;
    playlistAddress: string;
    articleWebUrl: string;
    tracks: Track[];
    artists: Artist[];
    playerScreenshotFileName: string | null;
    curatorNotes: string;
}): string {
    const { title, playlistAddress, articleWebUrl, tracks, artists, playerScreenshotFileName, curatorNotes } = params;
    const artistByPubkey = new Map(artists.map((artist) => [artist.pubkey, artist]));
    const trackLines = buildTrackLines(tracks, artistByPubkey);
    const trackSection = trackLines.join('\n\n');
    const artistMentions = artists
        .map((artist) => `- ${formatNostrNpub(artist.npub)} (${artist.displayName})`)
        .join('\n');

    const tracksWithVideo = tracks.filter((track) => track.hasVideo);

    const videoSection = tracksWithVideo.length
        ? tracksWithVideo
            .map((track) => {
                const artist = artistByPubkey.get(track.pubkey);
                return `- **${track.title}** by ${artist ? formatNostrNpub(artist.npub) : '(unknown artist)'} has a music video in metadata.`;
            })
            .join('\n')
        : '- No tracks in this issue included a `video` tag.';

    const playerModesSection = playerScreenshotFileName
        ? [
            '## Nostria player modes',
            '',
            'Nostria\'s media player scales from a tiny floating circle to an immersive fullscreen experience, so you can keep browsing or focus fully on the track.',
            '',
            `![Reni & Boka playing in Nostria fullscreen mode](${playerScreenshotFileName})`,
            '',
        ]
        : [];

    const zapsSection = [
        '## Support artists with zaps',
        '',
        'Zapping is one of the most important feedback loops on Nostr. If you discover a song you love in this issue, send a zap to support the artist directly and encourage more open music publishing.',
        '',
        'Even small zaps matter: they create a direct creator-audience connection and help sustain independent content creators in the Nostr ecosystem.',
        '',
    ];

    const notesSection = [
        '## Curator notes',
        '',
        normalizeCuratorNotesForArticle(curatorNotes),
        '',
    ];

    return [
        `# ${title}`,
        '',
        'Curated tracks from artists publishing music on Nostr.',
        '',
        buildHumanLead(tracks),
        '',
        `Playlist source: ${playlistAddress}`,
        '',
        `This article might not show correctly in all Nostr clients, so go view it here: ${articleWebUrl}`,
        '',
        '## Artists',
        '',
        artistMentions,
        '',
        ...notesSection,
        '## Tracks',
        '',
        trackSection,
        '',
        '## Music videos in Nostria',
        '',
        videoSection,
        '',
        ...playerModesSection,
        ...zapsSection,
    ].join('\n');
}

function buildVideoChecklist(tracks: Track[], artists: Artist[]): Array<Record<string, string | number>> {
    const artistByPubkey = new Map(artists.map((artist) => [artist.pubkey, artist]));
    return tracks
        .filter((track) => track.hasVideo)
        .map((track, index) => {
            const artist = artistByPubkey.get(track.pubkey);
            const dTag = track.d || getTagValue(track.tags, 'd') || '';
            const relayHints = artist?.relayHints || [];
            const trackAddress = dTag
                ? `nostr:${nip19.naddrEncode({ kind: track.kind, pubkey: track.pubkey, identifier: dTag, relays: relayHints })}`
                : `nostr:${nip19.neventEncode({ id: track.id, author: track.pubkey, relays: relayHints })}`;

            return {
                order: index + 1,
                trackTitle: track.title,
                artistMention: artist ? formatNostrNpub(artist.npub) : formatNostrNpub(stripLeadingAt(track.mention)),
                trackAddress,
                screenshotStatus: 'todo',
            };
        });
}

function ensureRequiredConfig(config: BuildArticleConfig): void {
    if (!config.articleDir) throw new Error('Missing articleDir');
    if (!config.title) throw new Error('Missing title');
    if (!config.identifier) throw new Error('Missing identifier');
    if (!config.curatorNpub) throw new Error('Missing curatorNpub');
}

export async function buildArticle(config: BuildArticleConfig): Promise<void> {
    ensureRequiredConfig(config);

    const articleDir = path.resolve(config.articleDir);
    const title = config.title;
    const identifier = config.identifier;
    const curatorNpub = config.curatorNpub;
    const decodedCurator = nip19.decode(curatorNpub);
    if (decodedCurator.type !== 'npub') {
        throw new Error(`Expected curator to be npub, received ${decodedCurator.type}`);
    }

    const articleNaddr = nip19.naddrEncode({
        kind: 30023,
        pubkey: decodedCurator.data,
        identifier,
        relays: ['wss://nos.lol/'],
    });
    const articleWebUrl = `https://nostria.app/a/${articleNaddr}`;

    const indexerRelays = unique((config.indexerRelays || DEFAULT_INDEXER_RELAYS).map(normalizeRelayUrl));
    const fallbackProfileRelays = unique(DEFAULT_PROFILE_FALLBACK_RELAYS.map(normalizeRelayUrl));
    const featuredImageFileName = findMediaByStem(articleDir, 'feature-article');
    const playerScreenshotFileName = findMediaByStem(articleDir, 'reniboka-player');
    const curatorNotes = readArticleNotes(articleDir);

    const summaryPath = path.join(articleDir, 'data', 'summary.json');
    const tracksPath = path.join(articleDir, 'data', 'tracks', 'index.json');

    if (!fs.existsSync(summaryPath) || !fs.existsSync(tracksPath)) {
        throw new Error(
            `Missing generated data. Run fetch script first so these files exist: ${summaryPath}, ${tracksPath}`
        );
    }

    const summary = readJson<Summary>(summaryPath);
    const tracks = readJson<Track[]>(tracksPath);
    const artistPubkeys = [...new Set(tracks.map((track) => track.pubkey))];

    const pool = new SimplePool();
    console.log(`Resolving artist profiles via outbox model for ${artistPubkeys.length} artists...`);
    const outboxByPubkey = await resolveOutboxRelaysByPubkey(pool, artistPubkeys, indexerRelays);
    const profilesByPubkey = await resolveProfilesByOutbox(
        pool,
        artistPubkeys,
        outboxByPubkey,
        indexerRelays,
        fallbackProfileRelays
    );
    pool.close(unique([...indexerRelays, ...[...outboxByPubkey.values()].flat()]));

    const artists = buildArtistList(tracks, profilesByPubkey);
    const videoChecklist = buildVideoChecklist(tracks, artists);
    const unresolvedArtists = artistPubkeys
        .filter((pubkey) => !profilesByPubkey.has(pubkey))
        .map((pubkey) => ({
            pubkey,
            npub: nip19.npubEncode(pubkey),
            outboxRelays: outboxByPubkey.get(pubkey) || [],
        }));

    ensureDirectory(articleDir);

    const markdown = buildMarkdown({
        title,
        playlistAddress: summary.playlist.rawAddress,
        articleWebUrl,
        tracks,
        artists,
        playerScreenshotFileName,
        curatorNotes,
    });

    const articleMarkdownPath = path.join(articleDir, 'article.md');
    fs.writeFileSync(articleMarkdownPath, markdown);

    const now = Math.floor(Date.now() / 1000);
    const eventContent = stripLeadingTitleHeading(markdown, title);
    const unsignedEvent = {
        kind: 30023,
        pubkey: decodedCurator.data,
        created_at: now,
        tags: [
            ['d', identifier],
            ['title', title],
            ['summary', `Selected tracks from Nostr artists (${tracks.length} tracks).`],
            ...(featuredImageFileName ? [['image', featuredImageFileName]] : []),
            ['published_at', `${now}`],
            ['t', 'music'],
            ['t', 'nostria'],
            ['t', 'playlist'],
            ['a', `${summary.playlist.kind}:${summary.playlist.pubkey}:${summary.playlist.identifier}`],
            ...artists.map((artist) => ['p', artist.pubkey]),
        ],
        content: eventContent,
    };

    const unsignedEventPath = path.join(articleDir, 'nostr-event.unsigned.json');
    fs.writeFileSync(unsignedEventPath, JSON.stringify(unsignedEvent, null, 2));

    const artistsPath = path.join(articleDir, 'data', 'artists.json');
    fs.writeFileSync(artistsPath, JSON.stringify(artists, null, 2));

    const profilesPath = path.join(articleDir, 'data', 'profiles.json');
    fs.writeFileSync(
        profilesPath,
        JSON.stringify(
            artistPubkeys.map((pubkey) => ({
                pubkey,
                npub: nip19.npubEncode(pubkey),
                outboxRelays: outboxByPubkey.get(pubkey) || [],
                profile: profilesByPubkey.get(pubkey) || null,
            })),
            null,
            2
        )
    );

    const unresolvedPath = path.join(articleDir, 'data', 'unresolved-artists.json');
    fs.writeFileSync(unresolvedPath, JSON.stringify(unresolvedArtists, null, 2));

    const checklistPath = path.join(articleDir, 'data', 'video-screenshot-checklist.json');
    fs.writeFileSync(checklistPath, JSON.stringify(videoChecklist, null, 2));

    console.log(`Wrote ${path.relative(process.cwd(), articleMarkdownPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), unsignedEventPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), checklistPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), profilesPath)}`);
    console.log(`Wrote ${path.relative(process.cwd(), unresolvedPath)}`);
    console.log(`Artists: ${artists.length}, Tracks: ${tracks.length}, Video tracks: ${videoChecklist.length}`);
}

function parseCliConfig(): BuildArticleConfig {
    const articleDir = readArg('--article-dir');
    const title = readArg('--title');
    const identifier = readArg('--identifier');
    const curatorNpub = readArg('--curator-npub');
    const indexerRelaysArg = readArg('--indexer-relays');

    if (!articleDir || !title || !identifier || !curatorNpub) {
        throw new Error(
            'Usage: tsx scripts/music/build-article.ts --article-dir=... --title=... --identifier=... --curator-npub=npub1... [--indexer-relays=wss://...,wss://...]'
        );
    }

    return {
        articleDir,
        title,
        identifier,
        curatorNpub,
        indexerRelays: indexerRelaysArg
            ? indexerRelaysArg
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
    buildArticle(parseCliConfig()).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
