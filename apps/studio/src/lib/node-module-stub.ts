// Stand-in for Node's built-in `module` in the client bundle. harfbuzzjs
// (Emscripten output) imports it only when it detects Node, which never
// happens in the browser, so nothing here is ever called. Aliased in
// next.config.ts (turbopack.resolveAlias).
export function createRequire(): never {
  throw new Error("createRequire is not available in the browser");
}
