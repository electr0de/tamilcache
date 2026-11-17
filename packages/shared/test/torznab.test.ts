import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { renderCapsXml, renderSearchXml, type TorznabItem } from '../src/torznab.js';

const ITEM: TorznabItem = {
  title: 'A.Minecraft.Movie.2025.720p.HDTC.x264.AAC.Hindi.700MB-TMV',
  guid: 'tamilcache-1',
  link: 'http://localhost:8484/api/v1/download/1?apikey=k',
  magnetUrl: 'magnet:?xt=urn:btih:c9d385dc7158d74f70b733f17a8c0dde9b67357c',
  infohash: 'c9d385dc7158d74f70b733f17a8c0dde9b67357c',
  sizeBytes: 734003200,
  pubDate: '2026-11-01T00:00:00.000Z',
  categoryId: 2040,
  seeders: 0,
  peers: 0,
  attrs: {
    resolution: '720p',
    video: 'x264',
    audio: 'AAC',
    codec: 'x264',
    language: 'Hindi',
    subs: 'English',
    year: 2025,
    imdb: 1,
    tmdbid: 1,
    tvdbid: null,
    season: null,
    episode: null,
  },
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

describe('renderSearchXml', () => {
  const xml = renderSearchXml([ITEM]);
  const parsed = parser.parse(xml) as {
    rss: { channel: { item: Record<string, unknown> } };
  };

  it('is well-formed RSS with the torznab namespace', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('xmlns:torznab="http://torznab.com/schemas/2015/feed"');
    expect(parsed.rss.channel.item).toBeDefined();
  });

  it('emits every attr a Radarr or Sonarr decision reads', () => {
    const attrs = (parsed.rss.channel.item['torznab:attr'] as Array<Record<string, string>>).map((a) => a['@name']);
    expect(attrs).toEqual(
      expect.arrayContaining([
        'size', 'category', 'infohash', 'magneturl', 'seeders', 'peers',
        'downloadvolumefactor', 'uploadvolumefactor', 'resolution', 'video', 'audio', 'language',
      ]),
    );
  });

  it('records downloadvolumefactor 0 so clients never ratio-limit us', () => {
    const attrs = parsed.rss.channel.item['torznab:attr'] as Array<Record<string, string>>;
    expect(attrs.find((a) => a['@name'] === 'downloadvolumefactor')?.['@value']).toBe('0');
  });

  it('escapes XML-hostile characters in titles', () => {
    const hostile = renderSearchXml([{ ...ITEM, title: 'A & B "quoted" <tag>' }]);
    expect(hostile).toContain('&amp;');
    expect(hostile).not.toContain('<tag>');
    expect(() => parser.parse(hostile)).not.toThrow();
  });

  // Radarr's TorznabRssParser.GetDownloadUrl dereferences <enclosure> and throws
  // NullReferenceException without it, which drops every release and surfaces as
  // "no results in the configured categories" in the UI test.
  it('carries the enclosure Radarr and Sonarr read the download url from', () => {
    const item = parsed.rss.channel.item as unknown as { enclosure: Record<string, string> };

    expect(item.enclosure).toBeDefined();
    expect(item.enclosure['@url']).toBe(ITEM.link);
    expect(item.enclosure['@length']).toBe(String(ITEM.sizeBytes));
    expect(item.enclosure['@type']).toBe('application/x-bittorrent');
  });

  it('escapes an ampersand in the enclosure url', () => {
    const raw = renderSearchXml([{ ...ITEM, link: 'http://h/api/v1/download/1?apikey=k&x=1' }]);

    expect(raw).toContain('url="http://h/api/v1/download/1?apikey=k&amp;x=1"');
    expect(() => parser.parse(raw)).not.toThrow();
  });

  it('emits an empty channel when there are no items', () => {
    const empty = parser.parse(renderSearchXml([])) as { rss: { channel: { item?: unknown } } };
    expect(empty.rss.channel.item).toBeUndefined();
  });

  it('omits null attrs instead of emitting empty values', () => {
    const xmlWithNulls = renderSearchXml([ITEM]);
    expect(xmlWithNulls).not.toContain('name="tvdbid"');
    expect(xmlWithNulls).not.toContain('value=""');
  });
});

describe('renderCapsXml', () => {
  const xml = renderCapsXml();

  it('declares the search types the clients negotiate', () => {
    // Torznab caps express these as elements, not `t=` attributes.
    expect(xml).toContain('<search available="yes"');
    expect(xml).toContain('<movie-search available="yes"');
    expect(xml).toContain('<tv-search available="yes"');
    // tvdbid is deliberately absent: TMDB returns null for almost every regional show.
    expect(xml).toContain('supportedParams="q,season,ep,year"');
    expect(xml).not.toContain('tvdbid');
  });

  it('declares the categories both clients need', () => {
    for (const id of ['2000', '2030', '2040', '2045', '2050', '5000', '5030', '5040']) {
      expect(xml).toContain(`id="${id}"`);
    }
  });

  it('is parseable and declares limits', () => {
    const parsed = parser.parse(xml) as { caps: { limits: Record<string, string> } };
    expect(parsed.caps.limits['@max']).toBe('100');
  });
});
