import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UNTRUSTED_COMMENT = "untrusted comment:";

function firstLine(text) {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function looksLikeMinisignSecret(text) {
  return firstLine(text).startsWith(UNTRUSTED_COMMENT);
}

/**
 * GitHub Actions stores the Tauri signer key as either the raw minisign
 * secret (two lines, starting with `untrusted comment:`) or the base64
 * encoding of that file. An empty secret produces the bundler error
 * `incorrect updater private key password: Missing comment in secret key`.
 */
export function validateUpdaterSigningSecrets({ privateKey, password } = {}) {
  const key = typeof privateKey === "string" ? privateKey.trim() : "";
  if (!key) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY is empty. Add the repository secret from .updater-private.key.",
    );
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is empty. Add the repository secret from .updater-signing.env.",
    );
  }

  if (looksLikeMinisignSecret(key)) {
    return { format: "raw" };
  }

  const decoded = Buffer.from(key, "base64").toString("utf8");
  if (!looksLikeMinisignSecret(decoded)) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY is missing the minisign untrusted comment line.",
    );
  }
  return { format: "base64" };
}

function main() {
  const result = validateUpdaterSigningSecrets({
    privateKey: process.env.TAURI_SIGNING_PRIVATE_KEY,
    password: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  });
  console.log(`Updater signing secrets look valid (${result.format}).`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
