/**
 * The URL a media file is loaded through, and its inverse.
 *
 * ## Why this is not `file://`
 *
 * PR 2 shipped `<video src="file:///...">`, and that works in exactly half the
 * configurations this app runs in. The page itself is served two ways: `loadFile`
 * when packaged, so the page's origin is `file://`, and the Vite dev server when
 * not, so the origin is `http://127.0.0.1:<port>`. Chromium permits a `file://`
 * subresource from a `file://` page and blocks it from an `http://` one, so
 * video worked in the built app and failed under `npm run dev` — with no error
 * an operator would ever see, because the failure surfaces as a cue that will
 * not preview.
 *
 * That is PR 1's blank-production-page defect with the sign flipped: one
 * environment broken, the other covered, and a gate that only ever ran the
 * covered one. Routing media through a privileged scheme of our own removes the
 * dependency on how the page was served, rather than fixing whichever half is
 * currently broken.
 *
 * ## Why this module is DOM-free and stands alone
 *
 * `mediaUrl` runs in the renderer and `mediaPath` runs in the main process, and
 * they have to be exact inverses. A path containing a space, a `#`, a `?` or a
 * non-ASCII character that does not survive the round trip is a cue that fails
 * to load for a reason nothing in the UI can explain. Keeping both halves in one
 * file with no DOM and no Electron imports means the pair can be tested
 * together, and means the main process can import it without pulling a video
 * element's worth of DOM types into its bundle.
 */

/**
 * Registered as a privileged scheme in `electron/main.ts`, where the privilege
 * that matters is `corsEnabled` — see the note there. This scheme is
 * cross-origin to the page however the page was served, so media on it must be
 * fetched in CORS mode or it taints every canvas it is drawn into.
 *
 * Note the scheme is registered `stream: true` but the handler does **not**
 * serve range requests: `net.fetch` over a `file://` URL answers `Range:
 * bytes=0-` with a plain `200` and the whole file. Seeking works because
 * Chromium buffers what it is given, which is fine for clips and would not be
 * for a long file. Measured on Electron 43 — an earlier version of this comment
 * asserted the opposite without checking.
 */
export const MEDIA_SCHEME = 'ddf-media';

/**
 * A dummy authority.
 *
 * A standard scheme's URL is parsed as `scheme://host/path`, so it needs *some*
 * host. Using a fixed one keeps every media URL same-origin with every other,
 * which an empty authority does not reliably do.
 */
const MEDIA_HOST = 'file';

/**
 * An absolute filesystem path as a URL the renderer can put in a `src`.
 *
 * Each path segment is encoded separately so that separators survive and
 * everything else — spaces, `#`, `?`, `%`, non-ASCII — does not leak into the
 * URL's structure. A Windows drive letter is left alone, because `C%3A` is not a
 * drive letter any more on the way back.
 */
export function mediaUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const encoded = normalized
    .split('/')
    .map((segment) => (isDriveLetter(segment) ? segment : encodeURIComponent(segment)))
    .join('/');

  return `${MEDIA_SCHEME}://${MEDIA_HOST}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/**
 * The absolute path a `ddf-media://` URL refers to, or `null` if it refers to
 * nothing.
 *
 * The `null` is not defensive padding. This runs in the main process against a
 * URL that arrives from the renderer, and returning a path for a malformed or
 * foreign URL is how a protocol handler turns into a file-read primitive for
 * whatever gets into the page. A caller that cannot name the file does not open
 * one.
 */
export function mediaPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null;

  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    // A stray `%` that is not a valid escape.
    return null;
  }

  if (path.length === 0) return null;

  // `/C:/clips/x.mp4` came from a Windows path and has a leading separator the
  // URL form requires and the filesystem does not.
  if (isDriveLetter(path.slice(1, 3)) && path.startsWith('/')) return path.slice(1);
  return path;
}

function isDriveLetter(segment: string): boolean {
  return /^[A-Za-z]:$/.test(segment);
}
