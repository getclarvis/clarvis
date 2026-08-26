import { ToolError } from "../errors.ts";
import { readFileOptions, readRawFile } from "../lib/files.ts";
import { sniffImageMime } from "../lib/image.ts";
import { resolvePath } from "../lib/paths.ts";
import { imagePart } from "./content.ts";
import type { ToolDef } from "./types.ts";

/**
 * The `read_image` tool: read an image file and return it as an image content
 * part for a vision-capable model.
 *
 * @remarks
 * The handler reads the raw bytes through {@link readRawFile}, capped at
 * `config.maxImageBytes` (surfaced as `MAX_IMAGE_BYTES`), then infers the MIME
 * type from the file's magic bytes via {@link sniffImageMime} rather than the
 * extension. Only PNG, JPEG, GIF, and WebP are recognized; anything else is
 * rejected. The result is a single base64-encoded {@link imagePart}.
 * @throws {@link ToolError} with code `not_an_image` when the bytes are not one
 *   of the supported formats; an oversized file surfaces from
 *   {@link readRawFile}.
 */
export const readImage: ToolDef = {
  name: "read_image",
  description:
    "Read an image file and return it so a vision-capable model can view it. Supports PNG, JPEG, " +
    "GIF, and WebP. Rejects files that are not one of those formats, and files larger than the " +
    "image size limit. Use read_file for text; use this only for images. If you do not know the " +
    "path, use glob or list_dir first.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Image file to read. Relative to workspace root or absolute (~ is not expanded).",
      },
    },
    required: ["path"],
  },
  async handler(args, config) {
    const relPath = args.path as string;
    const target = resolvePath(
      relPath,
      config.workspaceRoot,
      config.confineToWorkspace,
      config.temporaryRoots,
      config.logger,
    );
    const buf = await readRawFile(
      target,
      relPath,
      config.maxImageBytes,
      "MAX_IMAGE_BYTES",
      readFileOptions(config),
    );
    const mimeType = sniffImageMime(buf);
    if (mimeType === null) {
      throw new ToolError(
        "not_an_image",
        `Not a supported image (expected png, jpeg, gif, or webp): ${relPath}`,
        { path: relPath },
      );
    }
    return { content: [imagePart(buf.toString("base64"), mimeType)] };
  },
};
