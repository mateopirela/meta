import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyFirebaseIdToken, isAllowedUser, AuthError } from "../src/auth.mjs";

// Un par de llaves RSA de prueba. `certs` se inyecta en PEM publico, que es lo
// que createPublicKey acepta igual que los certificados X.509 de Google.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = publicKey.export({ type: "spki", format: "pem" });
const CERTS = { "kid-1": PEM };
const PROJECT = "prewave-prod-f1303";
const NOW = 1_800_000_000_000; // ms

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function makeToken(payloadOverrides = {}, { kid = "kid-1", key = privateKey, alg = "RS256" } = {}) {
  const nowSec = Math.floor(NOW / 1000);
  const header = { alg, kid, typ: "JWT" };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: nowSec - 60,
    iat: nowSec - 60,
    exp: nowSec + 3600,
    sub: "uid-123",
    email: "Mateo@30x.com",
    email_verified: true,
    name: "Mateo",
    ...payloadOverrides,
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64url(sig)}`;
}

const verify = (token) => verifyFirebaseIdToken(token, { projectId: PROJECT, now: NOW, certs: CERTS });
const rejects = (token, code) => assert.rejects(verify(token), (err) => err instanceof AuthError && err.code === code);

describe("verifyFirebaseIdToken", () => {
  test("acepta un token bien firmado y devuelve los claims utiles", async () => {
    const claims = await verify(makeToken());
    assert.deepEqual(claims, { uid: "uid-123", email: "mateo@30x.com", emailVerified: true, name: "Mateo" });
  });

  test("rechaza firma de otra llave", () => rejects(makeToken({}, { key: otherKey }), "bad_signature"));
  test("rechaza kid desconocido", () => rejects(makeToken({}, { kid: "kid-x" }), "unknown_kid"));
  test("rechaza alg distinto de RS256 (ni 'none' ni HS256)", () => rejects(makeToken({}, { alg: "none" }), "bad_alg"));
  test("rechaza token vencido", () => rejects(makeToken({ exp: Math.floor(NOW / 1000) - 3600 }), "expired"));
  test("rechaza otro proyecto (aud)", () => rejects(makeToken({ aud: "otro-proyecto" }), "bad_aud"));
  test("rechaza otro emisor (iss)", () => rejects(makeToken({ iss: "https://evil.example" }), "bad_iss"));
  test("rechaza sub vacio", () => rejects(makeToken({ sub: "" }), "bad_sub"));
  test("rechaza basura", () => rejects("no.es.jwt", "malformed"));
});

describe("isAllowedUser", () => {
  const claims = { email: "mateo@30x.com", emailVerified: true };
  test("sin lista nadie entra", () => assert.equal(isAllowedUser(claims, {}), false));
  test("entra por dominio", () => assert.equal(isAllowedUser(claims, { domains: ["30x.com"] }), true));
  test("entra por correo exacto, sin importar mayusculas", () =>
    assert.equal(isAllowedUser(claims, { emails: ["MATEO@30x.com"] }), true));
  test("otro dominio no entra", () => assert.equal(isAllowedUser(claims, { domains: ["gmail.com"] }), false));
  test("correo sin verificar no entra aunque el dominio este permitido", () =>
    assert.equal(isAllowedUser({ ...claims, emailVerified: false }, { domains: ["30x.com"] }), false));
});
