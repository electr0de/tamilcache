import { describe, expect, it } from 'vitest';
import { firstPostBody, hasDownload, parseTopicPage } from '../src/topic-parser.js';

const BASE = 'https://www.1tamilmv.io';

/** A DDL post whose only magnet lives in a reply — the shape that dead-lettered 261 topics. */
const ddlWithMagnetInReply = `
<html><head><title>A DDL Post - 1TamilMV</title></head><body>
<div data-role="commentContent">
  <strong>A Film (2026) Hindi WEB-DL - 1080p - x264 - 6GB:</strong><br>
  <a href="https://gplinks.co/abc123">MAGNET</a><br>
</div>
<div data-role="commentContent">
  someone replied: <a href="magnet:?xt=urn:btih:${'aa'.repeat(20)}">magnet</a>
</div>
</body></html>`;

const attachmentOnly = `
<html><head><title>Torrent Only - 1TamilMV</title></head><body>
<div data-role="commentContent">
  <strong>Some Film (2026) Hindi HDTC-Rip - 1080p - x264 - 6GB:</strong><br>
  <a href="https://www.1tamilmv.io/applications/core/interface/file/attachment.php?id=1&amp;key=k">x.torrent</a>
</div>
</body></html>`;

describe('hasDownload', () => {
  it('does not count a magnet that only appears in a reply', () => {
    const whole = hasDownload(ddlWithMagnetInReply);
    expect(whole).toBe(true); // the document does contain one
    expect(hasDownload(firstPostBody(ddlWithMagnetInReply))).toBe(false);
    expect(parseTopicPage(ddlWithMagnetInReply, BASE).variants).toEqual([]);
  });

  it('counts a .torrent attachment as a download', () => {
    expect(hasDownload(firstPostBody(attachmentOnly))).toBe(true);
  });

  it('counts a magnet in the first post', () => {
    const html = attachmentOnly.replace(
      '</div>\n</body>',
      `<a href="magnet:?xt=urn:btih:${'bb'.repeat(20)}">magnet</a></div>\n</body>`,
    );
    expect(hasDownload(firstPostBody(html))).toBe(true);
  });

  it('is false for a post with nothing but a shortener', () => {
    expect(hasDownload(firstPostBody(ddlWithMagnetInReply.split('<div data-role="commentContent">')[1] ?? ''))).toBe(
      false,
    );
  });
});
