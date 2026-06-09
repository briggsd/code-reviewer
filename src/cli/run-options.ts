export interface RunPublishOptions {
  publishSummary: boolean;
  publishInline: boolean;
}

export function parseRunPublishOptions(args: string[]): RunPublishOptions {
  return {
    publishSummary: hasFlag(args, "--publish-summary"),
    publishInline: hasFlag(args, "--publish-inline"),
  };
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}
