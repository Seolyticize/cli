import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * seolyticize verify --local <dir>: what verify_site would find wrong with the
 * files in a repo, before they are deployed. Reads files only; no key, no network.
 */
export type LocalFailure = { file: string; code: string; fix: string };

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

export async function verifyLocal(
  dir: string,
  publicDir = "public",
): Promise<LocalFailure[]> {
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

  const layout = await firstOf(dir, [
    ...NEXT_ROOTS.flatMap((root) => [
      `${root}/layout.tsx`,
      `${root}/layout.jsx`,
      `${root}/layout.js`,
    ]),
    "pages/_app.tsx",
    "pages/_app.jsx",
    "pages/_app.js",
    "index.html",
    `${publicDir}/index.html`,
  ]);
  if (layout && !/data-site=|<Analytics\b|<SeolyticizeAnalytics\b/.test(layout.text)) {
    failures.push({
      file: layout.file,
      code: "analytics_tag_missing",
      fix: "Add the analytics tag (analytics.install from onboard_site, or <Analytics /> from @seolyticize/next).",
    });
  }
  return failures;
}
