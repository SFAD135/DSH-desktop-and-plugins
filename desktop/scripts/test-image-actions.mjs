#!/usr/bin/env node
/**
 * Unit tests for the image rules (`app/image-actions.js`).
 *
 * The regression these exist for: the image menu was composed correctly but the
 * feature was dead — a cookie-less `fetch` of `/api/file?…` is answered with 401,
 * and the suggested file name for that same URL was the literal string `file`,
 * with no extension. The naming and applicability rules are therefore pinned
 * down here, where they can be checked without a window.
 *
 *   node scripts/test-image-actions.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const {
  extensionForContentType,
  hostPathForImageUrl,
  imageFileName,
  imageMarkdown,
  isDurableImageUrl,
  isFileBackedImageUrl,
  isShareableImageUrl,
  sanitizeFileName,
} = require(path.join(ROOT, 'app', 'image-actions.js'));

let failed = 0;
let ran = 0;
const check = (name, ok, extra = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` — ${extra}`}`);
};

const BASE = 'http://127.0.0.1:50270';
const api = (hostPath) => `${BASE}/api/file?path=${encodeURIComponent(hostPath)}`;

// ── content types ───────────────────────────────────────────────────────────
check('maps the common image types', [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'], ['image/svg+xml', 'svg']].every(([t, e]) => extensionForContentType(t) === e));
check('ignores parameters and case', extensionForContentType('IMAGE/PNG; charset=binary') === 'png');
check('returns nothing for a non-image type', extensionForContentType('text/html') === null && extensionForContentType(undefined) === null);

// ── host paths ──────────────────────────────────────────────────────────────
check('resolves the service URL to its host path', hostPathForImageUrl(api('D:\\shots\\a.png')) === 'D:\\shots\\a.png');
check('resolves a POSIX path too', hostPathForImageUrl(api('/home/u/a.png')) === '/home/u/a.png');
check('resolves a file URL', hostPathForImageUrl('file:///D:/shots/a.png') === 'D:/shots/a.png');
check('decodes an encoded file URL', hostPathForImageUrl('file:///D:/my%20shots/a%20b.png') === 'D:/my shots/a b.png');
check('has no path for a blob URL', hostPathForImageUrl('blob:http://127.0.0.1:50270/9f2c-4a11') === null);
check('has no path for a data URL', hostPathForImageUrl('data:image/png;base64,iVBORw0KGgo=') === null);
check('has no path for a remote image', hostPathForImageUrl('https://example.com/a.png') === null);
check('tolerates junk', hostPathForImageUrl('') === null && hostPathForImageUrl('not a url') === null && hostPathForImageUrl(null) === null);
check('ignores the api route with no path parameter', hostPathForImageUrl(`${BASE}/api/file`) === null);

// ── durability ──────────────────────────────────────────────────────────────
check('a file-backed image is durable', isDurableImageUrl(api('D:\\a.png')) && isDurableImageUrl('file:///D:/a.png'));
check('a remote image is durable', isDurableImageUrl('https://example.com/a.png'));
check('a blob image is not durable', !isDurableImageUrl('blob:http://127.0.0.1:50270/abc'));
check('a data image is not durable', !isDurableImageUrl('data:image/png;base64,iVBORw0KGgo='));
check('junk is not durable', !isDurableImageUrl('') && !isDurableImageUrl('nonsense'));

// ── shareable addresses (a narrower question than durability) ──────────────
// A remote image has no local file yet is still worth copying as an address.
check('a remote image is shareable', isShareableImageUrl('https://example.com/a.png'));
check('a service image is shareable', isShareableImageUrl(api('D:\\a.png')));
check('a file url is shareable', isShareableImageUrl('file:///D:/a.png'));
check('a blob url is not shareable', !isShareableImageUrl('blob:http://127.0.0.1:50270/abc'));
check('a data url is not shareable', !isShareableImageUrl('data:image/png;base64,iVBORw0KGgo='));
check('junk is not shareable', !isShareableImageUrl('') && !isShareableImageUrl('nonsense') && !isShareableImageUrl(null));
check('shareable is wider than durable', isShareableImageUrl('https://example.com/a.png') && !hostPathForImageUrl('https://example.com/a.png'));

// ── file-backed (the narrowest of the three) ───────────────────────────────
// 「复制本地路径」 must be disabled for a remote image: it is durable, but there is
// no path here, so the entry would always fail when clicked.
check('a file-backed image is file-backed', isFileBackedImageUrl(api('D:\\a.png')) && isFileBackedImageUrl('file:///D:/a.png'));
check('a remote image is not file-backed', !isFileBackedImageUrl('https://example.com/a.png'));
check('a blob image is not file-backed', !isFileBackedImageUrl('blob:http://127.0.0.1:1/a'));
check('junk is not file-backed', !isFileBackedImageUrl('') && !isFileBackedImageUrl(null) && !isFileBackedImageUrl('nonsense'));
check('durable is wider than file-backed', isDurableImageUrl('https://example.com/a.png') && !isFileBackedImageUrl('https://example.com/a.png'));

// ── file names: the bug that made saved files unopenable ────────────────────
// `basename(pathname)` of the service URL is the literal string "file".
const shared = imageFileName(api('D:\\shots\\屏幕截图 2026-01-01.png'));
check('takes the name from the path query, not the URL path', shared === '屏幕截图 2026-01-01.png', shared);
check('never names a saved image just "file"', imageFileName(api('D:\\shots\\a.png')) !== 'file');
check('keeps the real extension', imageFileName(api('D:\\shots\\a.jpeg')) === 'a.jpeg');
check('adds an extension when the URL has none', imageFileName(api('D:\\shots\\clip')) === 'clip.png');
check('uses the response type when the name has no extension', imageFileName(api('D:\\shots\\clip'), 'image/webp') === 'clip.webp');
check('does not double up an existing extension', imageFileName(api('D:\\shots\\a.png'), 'image/webp') === 'a.png');
check('falls back to a stem when the URL carries no name', imageFileName('data:image/png;base64,iVBORw0KGgo=') === 'image.png', imageFileName('data:image/png;base64,iVBORw0KGgo='));
check('names a remote image from its path', imageFileName('https://example.com/pics/cat.webp') === 'cat.webp');
check('strips characters Windows forbids', sanitizeFileName('a<b>c:d"e/f\\g|h?i*j') === 'a_b_c_d_e_f_g_h_i_j');
check('a forbidden-only name still yields a usable file', /^[^<>:"/\\|?*]+\.png$/u.test(imageFileName(api('D:\\shots\\***'))), imageFileName(api('D:\\shots\\***')));
check('caps a very long name', imageFileName(api(`D:\\shots\\${'x'.repeat(400)}.png`)).length <= 130);

// ── markdown ────────────────────────────────────────────────────────────────
check('references a host file by its real path', imageMarkdown({ url: api('D:\\shots\\a.png') }) === '![a](D:\\shots\\a.png)');
check('uses the URL when there is no file', imageMarkdown({ url: 'https://example.com/a.png' }) === '![a](https://example.com/a.png)');
check('produces a well-formed markdown image', /^!\[[^\]]*\]\([^)]+\)$/u.test(imageMarkdown({ url: api('D:\\shots\\a b.png') })));

// A hardcoded total once drifted from the real count elsewhere in this suite;
// count what actually ran and fail if that number changes.
const EXPECTED_CHECKS = 43;
const ranBeforeAudit = ran;
check('the suite still runs every check', ranBeforeAudit === EXPECTED_CHECKS, `ran ${String(ranBeforeAudit)}, expected ${String(EXPECTED_CHECKS)}`);

const total = ran;
console.log(`\n${failed === 0 ? total : total - failed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
