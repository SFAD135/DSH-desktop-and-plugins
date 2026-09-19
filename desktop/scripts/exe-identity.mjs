'use strict';
/**
 * Authoring the product identity resource that `electron-core.exe` is given at build
 * time.
 *
 * The window belongs to the Electron core process, so the taskbar button and Task
 * Manager read **its** icon and version resource, not the launcher's. The replacement
 * blobs are produced by compiling a throwaway assembly with `csc`: assembly attributes
 * become the VS_VERSIONINFO block and `/win32icon:` becomes the icon group, so neither
 * structure is assembled by hand. `tools/set-exe-identity.cs` then transplants them.
 *
 * This module exists so the source it generates is testable
 * (`scripts/test-exe-identity.mjs`) — the ordering rule it encodes is not obvious and
 * getting it wrong is a compile error that the build only reports as a warning.
 *
 * @module dsh-desktop/scripts/exe-identity
 */

/**
 * A four-part numeric version, which is all `AssemblyVersion` accepts.
 *
 * `package.json` may carry a prerelease tag (`0.1.5-rc.2`) or build metadata
 * (`1.2.3+build`); **both** are dropped rather than encoded, because the Windows
 * resource has nowhere to put them and inventing a fourth number would be worse than
 * rounding to the release they qualify. `AssemblyVersion` rejects either form, so
 * missing one turns into a compile error.
 * @param version - a version string such as `0.1.5-rc.2`, `1.2` or `1.2.3.4`.
 * @returns a `x.y.z.w` string.
 */
function numericVersion(version) {
  const parts = String(version).split(/[-+]/u)[0].split('.');
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
}

/**
 * The C# source whose compiled resources become the core executable's identity.
 *
 * **Assembly-level attributes must precede every other element in a C# file** (only
 * `using` directives and `extern` aliases may come first). Putting them after the type
 * declaration is `CS1730`, which is why the order here is asserted by a test.
 *
 * `AssemblyTitle` becomes the shell's FileDescription, `AssemblyProduct` the
 * ProductName — the two strings Explorer and Task Manager show.
 *
 * @param version - a `package.json` version, normalized by {@link numericVersion}.
 * @returns C# source text.
 */
function identitySource(version) {
  return [
    'using System.Reflection;',
    '',
    '[assembly: AssemblyTitle("DeepSeek Harness")]',
    '[assembly: AssemblyProduct("DeepSeek Harness")]',
    '[assembly: AssemblyDescription("DeepSeek Harness 桌面版")]',
    '[assembly: AssemblyCompany("DeepSeek Harness Desktop")]',
    '[assembly: AssemblyCopyright("MIT")]',
    `[assembly: AssemblyVersion("${numericVersion(version)}")]`,
    `[assembly: AssemblyFileVersion("${numericVersion(version)}")]`,
    '',
    'internal static class Identity',
    '{',
    // A win32 executable target needs an entry point; nothing ever runs this one.
    '    private static void Main() { }',
    '}',
    '',
  ].join('\r\n');
}

export { identitySource, numericVersion };
