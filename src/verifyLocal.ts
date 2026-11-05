import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UsageError } from "./args.js";

/**
 * seolyticize verify --local <dir>: what verify_site would find wrong with the
 * files in a repo, before they are deployed. Reads files only; no key, no network.
 */
export type LocalFailure = {
  file: string;
  code: string;
  fix: string;
  /** It could not tell: shown, but does not fail the run. */
  warn?: true;
};

const read = (path: string) => readFile(path, "utf8").catch(() => null);
const list = (path: string) => readdir(path).catch(() => [] as string[]);

/** The first of these that exists under dir, with its text. */
async function firstOf(
  dir: string,
  paths: string[],
): Promise<{ file: string; text: string } | null> {
  for (const file of paths) {
    const text = await read(join(dir, file));
    if (text !== null) return { file, text };
  }
  return null;
}

const NEXT_ROOTS = ["app", "src/app"];
const inNextApp = (name: string) =>
  NEXT_ROOTS.flatMap((root) =>
    ["ts", "tsx", "js", "jsx"].map((ext) => `${root}/${name}.${ext}`),
  );

const LAYOUT = /^layout\.(tsx|jsx|js|ts)$/;
/** The tag, or a component of the site's own whose name says it wraps the tag. */
const TAG =
  /data-site=|\/a\.js\b|@seolyticize\/next|<Analytics\b|<\w*Seolyticize\w*\b|\bseolyticize\w*\s*\(/i;
const IMPORT = /(?:from\s+|import\s+|import\(\s*)["']([^"']+)["']/g;
const SOURCE_EXTENSIONS = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
];

/** Every Next layout under a root: a locale or route group has its own. */
async function layoutsUnder(dir: string, root: string, depth = 6): Promise<string[]> {
  const entries = await readdir(join(dir, root), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isFile() && LAYOUT.test(entry.name)) found.push(path);
    else if (entry.isDirectory() && depth > 0 && entry.name !== "node_modules") {
      found.push(...(await layoutsUnder(dir, path, depth - 1)));
    }
  }
  return found;
}

/** A file's own import, or null for a package's. Undefined when it should exist and does not. */
async function resolveImport(
  dir: string,
  from: string,
  target: string,
): Promise<string | null | undefined> {
  const bases = target.startsWith(".")
    ? [join(dirname(from), target)]
    : /^[@~]\//.test(target)
      ? [join("src", target.slice(2)), target.slice(2)]
      : null;
  if (!bases) return null;
  for (const base of bases) {
    for (const extension of SOURCE_EXTENSIONS) {
      const text =
        extension || /\.\w+$/.test(base) ? await read(join(dir, base + extension)) : null;
      if (text !== null) return text;
    }
  }
  return undefined;
}

export async function verifyLocal(
  dir: string,
  publicDir = "public",
): Promise<LocalFailure[]> {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    throw new UsageError(`There is no directory at ${dir}.`);
  }
  const failures: LocalFailure[] = [];
  const names = await list(join(dir, publicDir));

  const keyFiles = names.filter((name) => /^[0-9a-z-]{8,128}\.txt$/i.test(name));
  const matching: string[] = [];
  for (const name of keyFiles) {
    const text = (await read(join(dir, publicDir, name)))?.trim();
    if (text === name.slice(0, -4)) matching.push(name);
  }
  if (matching.length === 0) {
    failures.push({
      file: `${publicDir}/<key>.txt`,
      code: "indexnow_key_missing",
      fix: "Serve the IndexNow key file from onboard_site: named <key>.txt, holding exactly the key.",
    });
  }

  for (const name of names.filter((one) => /^google[0-9a-z]+\.html$/i.test(one))) {
    const text = (await read(join(dir, publicDir, name)))?.trim();
    if (text !== `google-site-verification: ${name}`) {
      failures.push({
        file: `${publicDir}/${name}`,
        code: "google_file_wrong",
        fix: `The file must hold exactly: google-site-verification: ${name}`,
      });
    }
  }

  const bing = await read(join(dir, publicDir, "BingSiteAuth.xml"));
  if (bing !== null && !/<user>[^<]+<\/user>/i.test(bing)) {
    failures.push({
      file: `${publicDir}/BingSiteAuth.xml`,
      code: "bing_file_wrong",
      fix: "Download the file again from Bing Webmaster Tools: it needs a <user> value.",
    });
  }

  const staticRobots = names.includes("robots.txt");
  const robotsRoute = await firstOf(dir, inNextApp("robots"));
  if (staticRobots && robotsRoute) {
    failures.push({
      file: `${publicDir}/robots.txt`,
      code: "robots_txt_conflict",
      fix: `It shadows ${robotsRoute.file}: delete one of them.`,
    });
  }

  const sitemapFile = await firstOf(dir, [
    `${publicDir}/sitemap.xml`,
    "out/sitemap.xml",
    "dist/sitemap.xml",
  ]);
  if (sitemapFile) {
    const urls = sitemapFile.text.match(/<url>/g)?.length ?? 0;
    const dated = sitemapFile.text.match(/<lastmod>/g)?.length ?? 0;
    if (urls > dated) {
      failures.push({
        file: sitemapFile.file,
        code: "sitemap_lastmod_missing",
        fix: `${urls - dated} of ${urls} URLs have no <lastmod>, so deploys cannot find what changed in them.`,
      });
    }
  }
  const sitemapRoute = await firstOf(dir, inNextApp("sitemap"));
  if (sitemapRoute && !/lastModified/.test(sitemapRoute.text)) {
    failures.push({
      file: sitemapRoute.file,
      code: "sitemap_lastmod_missing",
      fix: "Set lastModified on each entry, so deploys can find what changed.",
    });
  }

  const addTag =
    "Add the analytics tag (analytics.install from onboard_site, or <Analytics /> from @seolyticize/next).";
  const entries = [
    ...(await Promise.all(NEXT_ROOTS.map((root) => layoutsUnder(dir, root)))).flat(),
    "pages/_app.tsx",
    "pages/_app.jsx",
    "pages/_app.js",
    "pages/_document.tsx",
    "pages/_document.jsx",
    "pages/_document.js",
    "index.html",
    `${publicDir}/index.html`,
  ];
  const texts: Array<{ file: string; text: string }> = [];
  for (const file of entries) {
    const text = await read(join(dir, file));
    if (text !== null) texts.push({ file, text });
  }
  let tagged = texts.some(({ text }) => TAG.test(text));
  let unread = false;
  // One level of the site's own imports: a layout often renders a wrapper.
  for (const { file, text } of tagged ? [] : texts) {
    for (const [, target] of text.matchAll(IMPORT)) {
      const imported = await resolveImport(dir, file, target!);
      if (imported === undefined) unread = true;
      else if (imported !== null && TAG.test(imported)) tagged = true;
    }
  }
  if (!tagged && texts.length === 0) {
    failures.push({
      file: "<layout>",
      code: "analytics_tag_unknown",
      fix: `No layout or index.html here to read, so the tag could not be checked. ${addTag}`,
      warn: true,
    });
  } else if (!tagged && unread) {
    failures.push({
      file: texts[0]!.file,
      code: "analytics_tag_unknown",
      fix: `No tag found, and an import could not be followed, so this cannot tell. ${addTag}`,
      warn: true,
    });
  } else if (!tagged) {
    failures.push({
      file: texts[0]!.file,
      code: "analytics_tag_missing",
      fix: addTag,
    });
  }
  return failures;
}
