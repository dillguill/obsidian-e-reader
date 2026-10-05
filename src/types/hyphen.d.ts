// The `hyphen` package ships no types; this is the part the reader uses.
declare module "hyphen/en-us" {
  interface HyphenOptions {
    hyphenChar?: string;
    minWordLength?: number;
    html?: boolean;
    exceptions?: string[];
  }
  export function hyphenateSync(text: string, options?: HyphenOptions): string;
}
