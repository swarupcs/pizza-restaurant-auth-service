/**
 * Materializes the RSA signing key at boot from an environment variable.
 *
 * Why this exists: `certs/` is gitignored, and hosted environments have an
 * ephemeral filesystem, so the key has to be written on every start.
 *
 * Path detail: TokenService reads `path.join(__dirname, "../../certs/private.pem")`.
 * From the compiled path `dist/src/services/`, that resolves to `dist/certs/` —
 * NOT the repo root. Both locations are written so ts-node (dev) and the
 * compiled build (prod) each find the key.
 *
 * Usage:  node scripts/write-certs.mjs && node dist/src/server.js
 */
import fs from "node:fs";
import path from "node:path";
import rsaPemToJwk from "rsa-pem-to-jwk";

const b64 = process.env.PRIVATE_KEY_BASE64;

if (!b64) {
    console.error(
        "[write-certs] PRIVATE_KEY_BASE64 is not set. Generate a key with " +
            "`node scripts/generateKeys.mjs` and set the env var to " +
            "`base64 -w0 certs/private.pem`.",
    );
    process.exit(1);
}

const privateKey = Buffer.from(b64, "base64");

if (!privateKey.toString("utf8").includes("BEGIN RSA PRIVATE KEY")) {
    console.error(
        "[write-certs] PRIVATE_KEY_BASE64 did not decode to a PKCS#1 RSA " +
            "private key. Check that the value is base64 of certs/private.pem.",
    );
    process.exit(1);
}

for (const dir of ["certs", "dist/certs"]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "private.pem"), privateKey);
}

// Regenerate the JWKS document so it always matches the key actually in use.
// app.ts serves this via express.static("public"), which is cwd-relative —
// hence the repo root, not dist/.
const jwk = rsaPemToJwk(privateKey, { use: "sig" }, "public");
fs.mkdirSync("public/.well-known", { recursive: true });
fs.writeFileSync(
    "public/.well-known/jwks.json",
    JSON.stringify({ keys: [jwk] }, null, 4),
);

console.log("[write-certs] wrote certs/, dist/certs/ and public/.well-known/jwks.json");
