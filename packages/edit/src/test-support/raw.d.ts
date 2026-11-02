// Vite's `?raw` imports (both test projects run through Vite): the file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's `?url` imports: the URL the test server serves the file at.
declare module "*?url" {
  const url: string;
  export default url;
}
