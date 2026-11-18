// js-yaml 4 ships no types; only load is used.
declare module "js-yaml" {
  export function load(text: string): unknown;
}
