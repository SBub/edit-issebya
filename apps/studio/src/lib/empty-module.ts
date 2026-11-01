// Browser stand-in for Node's `module` builtin. harfbuzzjs (the preview's text
// measurer) imports it only behind its own Node check, so the browser never
// calls into it; Turbopack still has to resolve the import. See next.config.ts.
export {};
