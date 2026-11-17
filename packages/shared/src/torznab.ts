export interface TorznabItem {
  title: string;
  guid: string;
  link: string;
  magnetUrl: string | null;
  infohash: string;
  sizeBytes: number;
  pubDate: string;
  categoryId: number;
  seeders: number;
  peers: number;
  attrs: {
    resolution: string | null;
    video: string | null;
    audio: string | null;
    codec: string | null;
    language: string | null;
    subs: string | null;
    year: number | null;
    imdb: number | null;
    tmdbid: number | null;
    tvdbid: number | null;
    season: number | null;
    episode: number | null;
  };
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function attr(name: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `<torznab:attr name="${name}" value="${escapeXml(String(value))}" />`;
}

function itemXml(item: TorznabItem): string {
  const a = item.attrs;
  const attrs = [
    attr('size', item.sizeBytes),
    attr('category', item.categoryId),
    attr('infohash', item.infohash),
    attr('magneturl', item.magnetUrl),
    attr('seeders', item.seeders),
    attr('peers', item.peers),
    // Everything here is a local cache of public postings; nothing is ratio-tracked.
    attr('downloadvolumefactor', 0),
    attr('uploadvolumefactor', 1),
    attr('minimumratio', 1),
    attr('minimumseedtime', 0),
    attr('resolution', a.resolution),
    attr('video', a.video),
    attr('audio', a.audio),
    attr('codec', a.codec),
    attr('language', a.language),
    attr('subs', a.subs),
    attr('year', a.year),
    attr('imdb', a.imdb),
    attr('tmdbid', a.tmdbid),
    attr('tvdbid', a.tvdbid),
    attr('season', a.season),
    attr('episode', a.episode),
  ].filter((line): line is string => line !== null);

  return [
    '    <item>',
    `      <title>${escapeXml(item.title)}</title>`,
    `      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
    `      <link>${escapeXml(item.link)}</link>`,
    // Radarr/Sonarr read the download url from the enclosure and NRE on a missing one
    // (TorznabRssParser.GetDownloadUrl), which drops every release from the feed.
    `      <enclosure url="${escapeXml(item.link)}" length="${item.sizeBytes}" type="application/x-bittorrent" />`,
    `      <pubDate>${new Date(item.pubDate).toUTCString()}</pubDate>`,
    `      <category>${item.categoryId}</category>`,
    ...attrs.map((line) => `      ${line}`),
    '    </item>',
  ].join('\n');
}

export function renderSearchXml(items: TorznabItem[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>TamilCache Hindi</title>
    <description>Hindi-audio releases cached from TamilMV</description>
    <language>en-in</language>
    <category>2000</category>
    <category>5000</category>
${items.map(itemXml).join('\n')}
  </channel>
</rss>
`;
}

const CATEGORIES: ReadonlyArray<readonly [number, string]> = [
  [2000, 'Movies'],
  [2030, 'Movies/HD'],
  [2040, 'Movies/SD'],
  [2045, 'Movies/Other'],
  [2050, 'Movies/Foreign'],
  [2070, 'Movies/BluRay'],
  [5000, 'TV'],
  [5030, 'TV/HD'],
  [5040, 'TV/SD'],
  [5045, 'TV/Other'],
];

/**
 * Declares exactly the search types and categories Radarr/Sonarr negotiate against.
 *
 * `tvdbid` is deliberately **not** advertised for TV: TMDB's `external_ids` returns null for
 * almost every regional show (verified against our own data), so we could receive a filter we
 * cannot satisfy — and an unsatisfiable filter returns zero results, silently. Sonarr therefore
 * searches by `q` + `season`/`ep`, which we can always honour. Movie ids (`imdb`, `tmdb`) *are*
 * advertised because both are populated from TMDB.
 */
export function renderCapsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <server title="TamilCache" version="0.1" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q,imdbid,tmdbid,year" />
    <tv-search available="yes" supportedParams="q,season,ep,year" />
  </searching>
  <categories>
${CATEGORIES.map(([id, name]) => `    <category id="${id}" name="${name}" />`).join('\n')}
  </categories>
</caps>
`;
}
