import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyLink, isExternalLink } from '../src/links.js';
import { parseTopicPage } from '../src/topic-parser.js';

const fixtureDir = join(import.meta.dirname, 'fixtures');

/** Every href in a captured page, with `&amp;` decoded the way a parser would hand it over. */
function hrefsOf(file: string): string[] {
  const html = readFileSync(join(fixtureDir, file), 'utf8');
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => (m[1] ?? '').replace(/&amp;/gi, '&'));
}

/**
 * Every href *and* src in a captured page, `&amp;` decoded, blanks dropped.
 * Posters and theme images live in `src`, so the spam-safety checks need both.
 */
function urlsOf(file: string): string[] {
  const html = readFileSync(join(fixtureDir, file), 'utf8');
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)]
    .map((m) => (m[1] ?? '').replace(/&amp;/gi, '&'))
    .filter((url) => url.length > 1);
}

const IMAGE_URL = /\.(?:jpe?g|png|gif|webp)(?:\.[a-z0-9]+)?$/i;

describe('classifyLink', () => {
  it.each([
    ['https://drive.google.com/file/d/abc/view', 'gdrive'],
    ['https://docs.google.com/uc?id=abc', 'gdrive'],
    ['https://lulust.com/e/0zehm393gdwj', 'shortener'],
    ['https://drakkar.st/v/1-d8g1rz0qg', 'shortener'],
    ['https://luluvdo.com/d/5ukp7vsmak2h', 'stream'],
    ['https://siteget.net/o.php?u=https://www.1tamilmv.style/', 'shortener'],
    ['https://freeproxy.io/o.php?u=https://www.1tamilmv.style/', 'shortener'],
    ['https://t.me/tmvog', 'spam'],
    ['https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=1&key=x', 'torrent'],
    ['https://img1.imageride.net/images/2025/04/04/x.jpg', 'spam'],
    ['https://www.1tamilmv.io/index.php?/forums/topic/123-x/', 'other'],
    // real fixture variants beyond the recon table
    // "luluvido" (not "luluvdo") is a distinct shortener host seen in home.html
    ['https://luluvido.com/e/x0w6xdqjyeum', 'shortener'],
    // https://www.cyberloom.best/l/<id> is the download-button shortener used by
    // multi-quality.html / hindi-original.html; not in the recon table
    ['https://www.cyberloom.best/l/PWKT876T', 'shortener'],
    // streamdady is site chrome (one per topic), so it is noise, not a download target
    ['https://www.streamdady.com/', 'spam'],
    // mirror list is wider than .io and host matching must be case-insensitive
    ['https://www.1tamilmv.meme/index.php?/forums/topic/1-x/', 'other'],
    ['https://www.1TamilMV.day/index.php?/forums/topic/1-x/', 'other'],
    ['https://1tamilmv.style/index.php?/forums/topic/1-x/', 'other'],
  ])('classifies %s as %s', (url, kind) => {
    expect(classifyLink(url).kind).toBe(kind);
  });

  it('classifies an attachment.php URL whose &amp; was already decoded as torrent', () => {
    const url =
      'https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=161059&key=a70c6e641f9fc577467628610588d69e';
    expect(classifyLink(url).kind).toBe('torrent');
  });

  it('classifies an attachment.php URL that still carries &amp; as torrent', () => {
    const url =
      'https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=161059&amp;key=a70c6e641f9fc577467628610588d69e';
    expect(classifyLink(url).kind).toBe('torrent');
  });

  it('returns a human label with the lowercased, www-stripped host', () => {
    expect(classifyLink('https://lulust.com/e/abc').label).toBe('lulust.com');
    expect(classifyLink('https://www.1TamilMV.day/x').label).toBe('1tamilmv.day');
    expect(classifyLink('https://t.me/tmvog').label).toBe('t.me');
  });

  it('labels a torrent attachment instead of exposing its host', () => {
    const link = classifyLink('https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=1');
    expect(link.label).toBe('torrent file');
    expect(link.url).toBe('https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=1');
  });

  it.each([
    ['#'],
    ['/relative/path'],
    ['//kp.troggingods.com/rw5mujvkBk1DAIms7/133939'],
    ['https://'],
    ['not a url'],
    ['magnet:?xt=urn:btih:e1e6325094bf538c06542a4c2350c26dbf1d2615&dn=x'],
  ])('never throws on non-http input: %s', (url) => {
    const link = classifyLink(url);
    expect(link.url).toBe(url);
    expect(['gdrive', 'shortener', 'stream', 'torrent', 'spam', 'other']).toContain(link.kind);
  });
});

describe('classifyLink on multi-quality.html', () => {
  const hrefs = hrefsOf('multi-quality.html');
  const links = hrefs.map((h) => classifyLink(h));

  it('classifies every href in the page without throwing', () => {
    expect(links).toHaveLength(hrefs.length);
    expect(links.length).toBeGreaterThan(50);
  });

  it('labels posters and CDN images as other, not spam — only blocklisted noise hosts are spam', () => {
    // pbs.twimg.com / i.pinimg.com / cdn.jsdelivr.net and the forum's own
    // uploads/logo.png.<hash>.png are poster and theme images in the page. They are
    // not download targets, but they are also not spam. (An extension-based rule
    // flags all of them, plus the protocol-relative //www.1tamilmv.lease/… images,
    // which is why spam here is host-based only.)
    const posterish = urlsOf('multi-quality.html').filter((u) =>
      /(?:twimg\.com|pinimg\.com|jsdelivr\.net|1tamilmv\.(?:io|lease)\/uploads)/i.test(u),
    );
    expect(posterish.length).toBeGreaterThan(3);
    expect(posterish.filter((u) => classifyLink(u).kind !== 'other')).toEqual([]);
    // …and none of them is announced as an image by extension-only reasoning
    expect(posterish.some((u) => IMAGE_URL.test(u))).toBe(true);
  });

  it('finds only chrome as spam: the t.me invite and the streamdady banner', () => {
    const spam = links.filter((l) => l.kind === 'spam');
    expect(spam.map((l) => l.label).sort()).toEqual(['streamdady.com', 't.me']);
  });

  it('classifies every attachment.php href as torrent', () => {
    const attachments = links.filter((l) => l.url.includes('attachment.php'));
    expect(attachments.length).toBeGreaterThan(0);
    expect(attachments.every((l) => l.kind === 'torrent')).toBe(true);
  });

  it('finds the stream and shortener download buttons the page really uses', () => {
    const kinds = new Set(links.map((l) => l.kind));
    expect(kinds.has('spam')).toBe(true); // streamdady.com is chrome
    expect(kinds.has('shortener')).toBe(true); // cyberloom.best/l/<id>
    expect(links.filter((l) => l.kind === 'shortener').every((l) => l.label === 'cyberloom.best')).toBe(true);
  });
});

describe('classifyLink on hindi-original.html (screenshot CDN)', () => {
  it('marks imageride screenshots as spam by recon design, while forum-hosted theme images stay other', () => {
    const urls = urlsOf('hindi-original.html');
    const imageride = urls.filter((u) => /imageride\.net/i.test(u));
    expect(imageride.length).toBeGreaterThan(0);
    expect(imageride.filter((u) => classifyLink(u).kind !== 'spam')).toEqual([]);

    // the asymmetry is deliberate: the recon blocklist names imageride (screenshot
    // noise) but not generic image CDNs, which fall through to other
    const otherImages = urls.filter((u) => IMAGE_URL.test(u) && !/imageride\.net/i.test(u));
    expect(otherImages.length).toBeGreaterThan(0);
    expect(otherImages.filter((u) => classifyLink(u).kind === 'spam')).toEqual([]);
  });
});

describe('site chrome is not a post link', () => {
  it('treats streamdady as chrome, not a stream target', () => {
    // It appears exactly once on every topic page (8,682 rows for 8,682 topics): it is the site's
    // own player banner, and treating it as a post link makes every magnet-less post look external.
    expect(classifyLink('https://www.streamdady.com/').kind).toBe('spam');
  });
  it('keeps a real direct video host as stream', () => {
    expect(classifyLink('https://dood.to/e/abc').kind).toBe('stream');
    expect(classifyLink('https://luluvdo.com/e/xyz').kind).toBe('stream');
  });
});

describe('adrinolinks gate (discovered in gdrive-only.html)', () => {
  it('classifies the Drive gate as a shortener, not other', () => {
    expect(classifyLink('https://adrinolinks.in/ficTU').kind).toBe('shortener');
  });
  it('finds 13 gate links in the gdrive-only fixture', () => {
    const html = readFileSync(join(fixtureDir, 'gdrive-only.html'), 'utf8');
    const hits = [...html.matchAll(/https?:\/\/(?:www\.)?adrinolinks\.in\/[A-Za-z0-9]+/g)];
    expect(new Set(hits.map((h) => h[0])).size).toBe(13);
    for (const h of hits) expect(classifyLink(h[0]).kind).toBe('shortener');
  });
});

describe('an unrecognised external host in the post is a download, not noise', () => {
  it('keeps a shortener we have never seen', () => {
    // A real no_link topic: its only download link is shrinkme.click, absent from SHORTENERS.
    const { links } = parseTopicPage(readFileSync(join(fixtureDir, 'unknown-shortener.html'), 'utf8'), 'https://www.1tamilmv.io');
    const downloads = links.filter((link) => link.kind === 'download');
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads[0]?.label).toContain('shrinkme.click');
  });

  it('treats a forum mirror or a relative URL as navigation, never as a download', () => {
    expect(isExternalLink('https://www.1tamilmv.lease/index.php?/forums/topic/1-x/')).toBe(false);
    expect(isExternalLink('/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/')).toBe(false);
    expect(isExternalLink('https://shrinkme.click/x')).toBe(true);
  });
});

describe('linksOf reads the post, not the page', () => {
  it('ignores an anchor that wraps an image', () => {
    // A screenshot or poster link is not a download; gdrive-only.html carries an Amazon asset host.
    const { links } = parseTopicPage(readFileSync(join(fixtureDir, 'gdrive-only.html'), 'utf8'), 'https://www.1tamilmv.io');
    expect(links.some((link) => /aboutamazon/.test(link.url))).toBe(false);
    expect(links.some((link) => link.kind === 'shortener')).toBe(true);
  });

  it('does not scan the page chrome outside the first post', () => {
    const { links } = parseTopicPage(readFileSync(join(fixtureDir, 'multi-quality.html'), 'utf8'), 'https://www.1tamilmv.io');
    // streamdady is the site's player banner, outside the post body.
    expect(links.some((link) => /streamdady/.test(link.url))).toBe(false);
  });
});

describe('links pasted as plain text', () => {
  // Real topic 195053: the poster wrote the URLs as text, so they are not anchors at all.
  // Anchors-only scanning saw nothing and the post was filed as `no_link`.
  it('finds a bare URL in the post and classifies it', () => {
    const { links } = parseTopicPage(readFileSync(join(fixtureDir, 'bare-url-links.html'), 'utf8'), 'https://www.1tamilmv.io');
    const gplinks = links.filter((link) => /gplinks\.co/i.test(link.url));
    expect(gplinks.length).toBeGreaterThanOrEqual(2);
    expect(gplinks.every((link) => link.kind === 'shortener')).toBe(true);
  });

  it('does not invent links from text that is not a URL', () => {
    const { links } = parseTopicPage(readFileSync(join(fixtureDir, 'bare-url-links.html'), 'utf8'), 'https://www.1tamilmv.io');
    // The post names file sizes and a .mkv filename; neither is a link.
    expect(links.every((link) => /^https?:\/\//i.test(link.url) || /^www\./i.test(link.url))).toBe(true);
  });
});
