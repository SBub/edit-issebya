// The one platform global the package uses, present in browsers and Node
// alike. Declared here because the source is checked with no DOM and no Node
// types (tsconfig.json); tsconfig.test.json, which has both, leaves this out.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
