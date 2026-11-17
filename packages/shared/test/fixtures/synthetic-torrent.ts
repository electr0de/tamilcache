/**
 * A synthetic `.torrent` for tests.
 *
 * A real attachment must never be committed: this tree carries no infohash that resolves to a live
 * swarm. The blob is bencoded by hand rather than by our own encoder, so the fixture is not
 * produced by the code it validates.
 *
 * `SYNTHETIC_INFOHASH` was computed outside this suite, from the exact info-dict byte slice:
 *
 *   printf '%s' 'd6:lengthi1024e4:name19:example-fixture.txt12:piece lengthi16384e6:pieces20:bbbbbbbbbbbbbbbbbbbbe' | sha1sum
 *   c9d385dc7158d74f70b733f17a8c0dde9b67357c
 *
 * The slice ends at the first of the two closing `e`s: one closes the info dict (which is what
 * gets hashed), the other closes the outer dictionary.
 *
 * Anyone can re-run that line and compare. Nothing in the torrent resolves: the announce URL is
 * `tracker.example`, the file does not exist, and the piece hash is filler.
 */
export const SYNTHETIC_TORRENT = Buffer.concat([
  Buffer.from(
    'd8:announce22:http://tracker.example4:infod6:lengthi1024e4:name19:example-fixture.txt12:piece lengthi16384e6:pieces20:',
  ),
  Buffer.from('bbbbbbbbbbbbbbbbbbbb', 'latin1'),
  Buffer.from('ee'),
]);

/** SHA-1 of the bencoded info dict above — verified out of band, see the comment. */
export const SYNTHETIC_INFOHASH = 'c9d385dc7158d74f70b733f17a8c0dde9b67357c';
