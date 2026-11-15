declare const console: Console & {
  readonly Console: {
    new (stdout: $Node.Writable, stderr?: $Node.Writable, ignoreErrors?: boolean): Console;
  };
};

export default console;
