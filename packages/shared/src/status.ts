/**
 * A topic's status describes what its links are, never whether a function threw.
 *
 * `gone` is the only state a user is asked to act on as a failure; `external` and `no_link` are
 * both successes that need a human only because the uploader gated the download. `parse_failed`
 * is our defect: the download is on the page and we could not turn it into a feedable row, so it
 * must be counted and retried, never parked in front of the user as a dead link.
 */
export type TopicStatus = 'parsed' | 'external' | 'no_link' | 'gone' | 'parse_failed' | 'below_floor';

export interface StatusInput {
  /** HTTP status of the topic page. */
  httpStatus: number;
  /** Variants persisted for this topic on this visit. */
  variants: number;
  /** The first post carries a magnet or a `.torrent` attachment. */
  hasDownload: boolean;
  /** Blocks the parser understood but dropped for being under the 1080p floor. */
  variantsDropped?: number;
  /** The first post carries a non-chrome outbound link (shortener, stream, gdrive). */
  hasPostLink: boolean;
}

export function deriveStatus(input: StatusInput): TopicStatus {
  if (input.httpStatus === 404 || input.httpStatus === 410) return 'gone';
  if (input.variants > 0) return 'parsed';
  // A post whose releases were all parsed and then dropped for being under the floor is not a
  // parser failure — reporting it as one made 480p/DVD9 posts look like a markup problem.
  if (input.hasDownload && (input.variantsDropped ?? 0) > 0) return 'below_floor';
  if (input.hasDownload) return 'parse_failed';
  return input.hasPostLink ? 'external' : 'no_link';
}
