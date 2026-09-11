function consumeUntilStringTerminator(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 7) return index + 1;
    if (code === 156) return index + 1;
    if (code === 27 && value.charCodeAt(index + 1) === 92) return index + 2;
  }
  return value.length;
}

function consumeCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 64 && code <= 126) return index + 1;
  }
  return value.length;
}

function consumeEscape(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (next === 91) return consumeCsi(value, start + 2);
  if (next === 93 || next === 80 || next === 88 || next === 94 || next === 95)
    return consumeUntilStringTerminator(value, start + 2);
  if (next === 79) return Math.min(value.length, start + 3);
  if (next >= 32 && next <= 47) {
    for (let index = start + 2; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 48 && code <= 126) return index + 1;
    }
    return value.length;
  }
  return Math.min(value.length, start + 2);
}

/** Removes terminal escape sequences without interpreting their cursor or device effects. */
export function stripAnsi(value: string): string {
  let plain = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      index = consumeEscape(value, index);
      continue;
    }
    if (code === 155) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === 157 || code === 144 || code === 152 || code === 158 || code === 159) {
      index = consumeUntilStringTerminator(value, index + 1);
      continue;
    }
    if (code === 143) {
      index = Math.min(value.length, index + 2);
      continue;
    }
    plain += value[index];
    index += 1;
  }
  return plain;
}

function removeLastCodePoint(value: string, floor: number): string {
  if (value.length <= floor) return value;
  const last = value.charCodeAt(value.length - 1);
  const previous = value.charCodeAt(value.length - 2);
  const width =
    last >= 0xdc00 &&
    last <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    value.length - 2 >= floor
      ? 2
      : 1;
  return value.slice(0, value.length - width);
}

/** Projects untrusted process output into stable plain text that cannot move the TUI cursor. */
export function terminalPlainText(value: string): string {
  const stripped = stripAnsi(value);
  let plain = "";
  let lineStart = 0;
  for (let index = 0; index < stripped.length; index += 1) {
    const code = stripped.charCodeAt(index);
    if (code === 13 && stripped.charCodeAt(index + 1) === 10) {
      plain += "\n";
      lineStart = plain.length;
      index += 1;
      continue;
    }
    if (code === 13) {
      plain = plain.slice(0, lineStart);
      continue;
    }
    if (code === 8) {
      plain = removeLastCodePoint(plain, lineStart);
      continue;
    }
    if (code === 10) {
      plain += "\n";
      lineStart = plain.length;
      continue;
    }
    if (code === 9 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)))
      plain += stripped[index];
  }
  return plain;
}
