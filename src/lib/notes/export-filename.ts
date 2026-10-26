export type DownloadExtension = "md" | "docx";

const FALLBACK_FILENAME = "Poznamka";
const DEFAULT_FILENAME = "Poznámka";
const MAX_FILENAME_BASE_CODEPOINTS = 120;
const FILENAME_RESERVED_PATTERN = /[<>:"/\\|?*]/g;
const FILENAME_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const ASCII_ATTR_CHAR_PATTERN = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function boundFilenameBase(value: string, fallback: string): string {
  const bounded = Array.from(value)
    .slice(0, MAX_FILENAME_BASE_CODEPOINTS)
    .join("")
    .replace(/[.\s-]+$/g, "");

  return bounded === "" ? fallback : bounded;
}

function sanitizeFilenameBase(title: string, fallback: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(FILENAME_CONTROL_PATTERN, "")
    .replace(FILENAME_RESERVED_PATTERN, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  return boundFilenameBase(cleaned, fallback);
}

function asciiFallbackFilename(
  title: string,
  extension: DownloadExtension,
): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(FILENAME_CONTROL_PATTERN, "")
    .replace(FILENAME_RESERVED_PATTERN, "-")
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  return `${boundFilenameBase(ascii, FALLBACK_FILENAME)}.${extension}`;
}

function percentEncodeFilename(filename: string): string {
  const bytes = new TextEncoder().encode(filename);
  let encoded = "";

  for (const byte of bytes) {
    const character = String.fromCharCode(byte);

    if (ASCII_ATTR_CHAR_PATTERN.test(character)) {
      encoded += character;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }

  return encoded;
}

export function buildDownloadContentDisposition(
  title: string,
  extension: DownloadExtension,
): string {
  const asciiFilename = asciiFallbackFilename(title, extension);
  const unicodeFilename =
    `${sanitizeFilenameBase(title, DEFAULT_FILENAME)}.${extension}`;

  return [
    "attachment",
    `filename="${asciiFilename}"`,
    `filename*=UTF-8''${percentEncodeFilename(unicodeFilename)}`,
  ].join("; ");
}
