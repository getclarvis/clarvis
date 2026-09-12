/** A recognized literal producer; replacement preserves outer command syntax for analysis. */
export interface LiteralDataProjection {
  source: string;
  producers: Array<{ marker: string; bytes: number }>;
}

/**
 * Recognize only a single operand-free cat fed by one quoted heredoc. The delimiter is parsed
 * before locating its exact closing line; body bytes are literal data, not shell syntax.
 * This proves the producer only. The effect descriptor must still validate the argument position.
 */
export function projectLiteralData(command: string): LiteralDataProjection {
  const producers: LiteralDataProjection["producers"] = [];
  let source = command;
  let offset = 0;
  while (offset < source.length && producers.length < 8) {
    const start = source.indexOf("$(", offset);
    if (start < 0) break;
    const header = /^\$\(cat[ \t]+<<(['"])([A-Za-z_][A-Za-z0-9_]{0,31})\1[ \t]*\r?\n/.exec(
      source.slice(start),
    );
    if (header === null) {
      offset = start + 2;
      continue;
    }
    const bodyStart = start + header[0].length;
    const delimiter = header[2];
    const endLine = new RegExp(`^${delimiter}\\r?$`, "m");
    const close = endLine.exec(source.slice(bodyStart));
    if (close === null) {
      offset = bodyStart;
      continue;
    }
    const bodyEnd = bodyStart + close.index;
    const suffixStart = bodyEnd + close[0].length;
    const suffix = /^\r?\n[ \t]*\)/.exec(source.slice(suffixStart));
    const bytes = Buffer.byteLength(source.slice(bodyStart, bodyEnd), "utf8");
    if (suffix === null || bytes > 4096) {
      offset = suffixStart;
      continue;
    }
    const end = suffixStart + suffix[0].length;
    if (
      source[start - 1] !== '"' ||
      !/\s/.test(source[start - 2] ?? "") ||
      source[end] !== '"' ||
      (source[end + 1] !== undefined && !/[\s;&]/.test(source[end + 1] ?? ""))
    ) {
      offset = end;
      continue;
    }
    const marker = `__clarvis_literal_data_${producers.length}__`;
    if (command.includes(marker)) return { source: command, producers: [] };
    source = source.slice(0, start) + marker + source.slice(suffixStart + suffix[0].length);
    producers.push({ marker, bytes });
    offset = start + marker.length;
  }
  return { source, producers };
}
