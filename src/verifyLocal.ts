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
/** The script tag, or a component of the site's own whose name says it wraps it. */
const TAG = /data-site=|\/a\.js\b|<SeolyticizeAnalytics\b|<\w*Seolyticize\w*\b/i;
const IMPORT = /(?:from\s+|import\s+|import\(\s*)["']([^"']+)["']/g;
const FOLLOW_DEPTH = 4;
const FOLLOW_FILES = 200;
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

/** Without comments, so a tag that is commented out does not count. */
const uncommented = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

/** Whether this file renders the tag: an import alone never runs it. */
const rendersTag = (text: string) => {
  // A string that opens with the element is text, not JSX; no real JSX has a quote right before it.
  const jsx = text.replace(/(['"`])\s*<Analytics\b[^\n]*?\1/g, "");
  return TAG.test(jsx) || (/<Analytics\b/.test(jsx) && /@seolyticize\/next/.test(jsx));
};

/** A file's own import, null for a package's, undefined when it should exist and does not. */
async function resolveImport(
  dir: string,
  from: string,
  target: string,
): Promise<{ file: string; text: string } | null | undefined> {
  const bases = target.startsWith(".")
    ? [join(dirname(from), target)]
    : /^[@~]\//.test(target)
      ? [join("src", target.slice(2)), target.slice(2)]
      : null;
  if (!bases) return null;
  for (const base of bases) {
    for (const extension of SOURCE_EXTENSIONS) {
      const file = base + extension;
      const text = extension || /\.\w+$/.test(base) ? await read(join(dir, file)) : null;
      if (text !== null) return { file, text };
    }
  }
  return undefined;
}

/**
 * Whether the tag is rendered in these files or the site's own files they
 * import, and whether all of those could be read. A layout often renders a
 * wrapper, which may render another, or come through a barrel.
 */
async function findTag(
  dir: string,
  roots: Array<{ file: string; text: string }>,
): Promise<{ tagged: boolean; complete: boolean }> {
  const seen = new Set(roots.map(({ file }) => file));
  let level = roots;
  let complete = true;
  for (let depth = 0; level.length > 0; depth += 1) {
    if (level.some(({ text }) => rendersTag(uncommented(text)))) {
      return { tagged: true, complete };
    }
    if (depth === FOLLOW_DEPTH || seen.size > FOLLOW_FILES) {
      return { tagged: false, complete: false };
    }
    const next: typeof level = [];
    for (const { file, text } of level) {
      for (const [, target] of uncommented(text).matchAll(IMPORT)) {
        const found = await resolveImport(dir, file, target!);
        if (found === undefined) complete = false;
        else if (found && !seen.has(found.file)) {
          seen.add(found.file);
          next.push(found);
        }
      }
    }
    level = next;
  }
  return { tagged: false, complete };
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
        warn: true,
        fix: `${urls - dated} of ${urls} URLs have no <lastmod>, so deploys cannot find what changed in them.`,
      });
    }
  }
  const sitemapRoute = await firstOf(dir, inNextApp("sitemap"));
  if (sitemapRoute && !/lastModified/.test(sitemapRoute.text)) {
    failures.push({
      file: sitemapRoute.file,
      code: "sitemap_lastmod_missing",
      warn: true,
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
  const { tagged, complete } = await findTag(dir, texts);
  if (!tagged && texts.length === 0) {
    failures.push({
      file: "<layout>",
      code: "analytics_tag_unknown",
      fix: `No layout or index.html here to read, so the tag could not be checked. ${addTag}`,
      warn: true,
    });
  } else if (!tagged && !complete) {
    failures.push({
      file: texts[0]!.file,
      code: "analytics_tag_unknown",
      fix: `No tag found, and not every import could be followed, so this cannot tell. ${addTag}`,
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
