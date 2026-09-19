'use strict';
/**
 * Pure rules for acting on an image in the hosted page.
 *
 * These exist because the first version of the image menu was **composed
 * correctly but did nothing**: it handed `srcURL` straight to a bare
 * `fetch()` in the main process, and every image the Harness GUI shows is
 * either
 *
 *   - `/api/file?path=…`, which the local service answers only with the
 *     `dsh-auth-*` cookie (a cookie-less fetch gets HTTP 401), or
 *   - a `blob:` URL created by the page, which the main process cannot fetch at
 *     all because it only exists inside the renderer.
 *
 * A second, quieter defect lived here too: for `/api/file?path=…` the real name
 * sits in the query string, so `basename(pathname)` was the literal string
 * `file` — no extension, not openable on Windows.
 *
 * Everything in this module is therefore pure and unit-tested, so the naming and
 * applicability rules can be checked without a window.
 *
 * @module dsh-desktop/image-actions
 */

/** Content types we can name a file for, most specific first. */
const EXTENSIONS = [
  ['image/svg+xml', 'svg'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp'],
  ['image/x-icon', 'ico'],
  ['image/tiff', 'tiff'],
];

/** The prefix the local dsh service serves host files under. */
const FILE_API_PATH = '/api/file';

/**
 * The extension for a content type, without the dot.
 * @param contentType - a full header value such as `image/png; charset=binary`.
 * @returns the extension, or `null` when it is not a known image type.
 */
function extensionForContentType(contentType) {
  const mime = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  for (const [type, extension] of EXTENSIONS) {
    if (mime === type) return extension;
  }
  return null;
}

/**
 * The host file path behind an image URL, when there is one.
 *
 * Only two shapes resolve to a file the shell can hand to the operating system:
 * a `file:` URL, and the local service's `/api/file?path=…` (whose `path` is an
 * absolute host path — the GUI builds it from the authored markdown
 * destination). `blob:` and `data:` URLs have no file behind them.
 *
 * @param url - the image URL as the page reports it.
 * @returns the absolute path, or `null` when the image is not file-backed.
 */
function hostPathForImageUrl(url) {
  const text = String(url ?? '');
  if (text.length === 0) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'file:') {
      // `decodeURIComponent` is deliberate: file URLs percent-encode spaces and
      // non-ASCII, and a path that still holds `%20` will not open.
      const pathname = decodeURIComponent(parsed.pathname);
      // Windows file URLs look like `/D:/dir/a.png`; POSIX ones are already right.
      return /^\/[A-Za-z]:/u.test(pathname) ? pathname.slice(1) : pathname;
    }
    if (parsed.pathname === FILE_API_PATH || parsed.pathname === `${FILE_API_PATH}/`) {
      const target = parsed.searchParams.get('path');
      return target && target.length > 0 ? target : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether an image is backed by a file this machine can actually open.
 *
 * Narrower than `isDurableImageUrl`: a remote `https:` image is durable (it can be
 * referenced again) but has no local path, so 「复制本地路径」 must stay disabled
 * for it — otherwise the entry looks available and always fails when clicked.
 *
 * @param url - the image URL.
 * @returns `true` when `hostPathForImageUrl` resolves a path.
 */
function isFileBackedImageUrl(url) {
  return hostPathForImageUrl(url) !== null;
}

/**
 * Whether an image URL can be referenced durably, i.e. outside this window.
 *
 * A `blob:http://127.0.0.1:…/uuid` is meaningless the moment the page reloads,
 * so pasting it into a document produces a dead link. Rather than emit a broken
 * link, the menu disables the referencing entries for those images.
 *
 * @param url - the image URL.
 * @returns `true` for file-backed and networked images.
 */
function isDurableImageUrl(url) {
  if (hostPathForImageUrl(url) !== null) return true;
  try {
    const { protocol } = new URL(String(url ?? ''));
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Whether an image URL is worth copying as an *address*.
 *
 * Distinct from `isDurableImageUrl`, which asks "is there a file behind this?".
 * A remote `https:` image is perfectly copyable even though it has no local file,
 * while a `blob:` URL is scoped to the document that created it and a `data:` URL
 * is the bytes themselves — pasting either anywhere is useless, so the menu
 * disables 「复制图片地址」 for them instead of putting junk on the clipboard.
 *
 * @param url - the image URL.
 * @returns `true` when the URL is an address another program could use.
 */
function isShareableImageUrl(url) {
  const text = String(url ?? '').trim();
  if (text.length === 0) return false;
  try {
    const { protocol } = new URL(text);
    return protocol !== 'blob:' && protocol !== 'data:';
  } catch {
    return false;
  }
}

/** Strip characters Windows forbids in a file name, and trim the result. */
function sanitizeFileName(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/^\.+/u, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '';
}

/**
 * The file name to offer in the save dialog.
 *
 * Preference order: the host file's own name (most truthful), then the last
 * path segment of the URL, then a generic stem — with the extension taken from
 * the response content type whenever the chosen name has none, which is what
 * makes the saved file openable.
 *
 * @param url - the image URL.
 * @param contentType - the response's content type, when known.
 * @returns a file name including an extension.
 */
function imageFileName(url, contentType) {
  const fallbackExtension = extensionForContentType(contentType) ?? 'png';
  const hostPath = hostPathForImageUrl(url);

  let candidate = '';
  if (hostPath !== null) {
    candidate = hostPath.split(/[\\/]/u).pop() ?? '';
  } else {
    try {
      const parsed = new URL(String(url ?? ''));
      // For `blob:` the useful part is the last segment of the inner URL shape;
      // for `data:` there is no name at all — its "pathname" is the payload
      // itself (`image/png;base64,iVBOR…`), which must never become a file name.
      const segment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
      candidate = /[;=,]/u.test(segment) ? '' : segment;
    } catch {
      candidate = '';
    }
  }

  const safe = sanitizeFileName(candidate);
  // A URL segment such as `file` or `4f2a…` is a real name but carries no type;
  // an extension is what makes the difference between "saved" and "openable".
  const stem = safe.length > 0 ? safe : 'image';
  return /\.[A-Za-z0-9]{2,5}$/u.test(stem) ? stem : `${stem}.${fallbackExtension}`;
}

/**
 * The Markdown an image becomes when pasted into a document.
 *
 * A file-backed image is referenced by its real path so the document points at
 * something durable; otherwise its URL is used.
 *
 * @param options - `url` as reported by the page, `contentType` when known.
 * @returns `![alt](target)`.
 */
function imageMarkdown({ url, contentType }) {
  const hostPath = hostPathForImageUrl(url);
  const target = hostPath ?? String(url ?? '');
  const alt = imageFileName(url, contentType).replace(/\.[A-Za-z0-9]{2,5}$/u, '');
  return `![${alt}](${target})`;
}

module.exports = {
  EXTENSIONS,
  FILE_API_PATH,
  extensionForContentType,
  hostPathForImageUrl,
  imageFileName,
  imageMarkdown,
  isDurableImageUrl,
  isFileBackedImageUrl,
  isShareableImageUrl,
  sanitizeFileName,
};
