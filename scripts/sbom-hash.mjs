/* global Buffer */
const algorithms = new Map([
  ["sha256", { cyclonedx: "SHA-256", bytes: 32 }],
  ["sha384", { cyclonedx: "SHA-384", bytes: 48 }],
  ["sha512", { cyclonedx: "SHA-512", bytes: 64 }]
]);

export function npmIntegrityToCycloneDx(value, identity = "npm component") {
  if (typeof value !== "string") {
    throw new Error(`${identity} integrity must be a string`);
  }
  const match = value.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) {
    throw new Error(`${identity} integrity is not one supported canonical SRI digest`);
  }
  const algorithm = algorithms.get(match[1]);
  const encoded = match[2];
  const digest = Buffer.from(encoded, "base64");
  if (!algorithm || digest.length !== algorithm.bytes || digest.toString("base64") !== encoded) {
    throw new Error(`${identity} integrity digest is malformed`);
  }
  return { alg: algorithm.cyclonedx, content: digest.toString("hex") };
}

export function sha256HexToCycloneDx(value, identity) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${identity} SHA-256 digest is malformed`);
  }
  return { alg: "SHA-256", content: value };
}
