import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parseKey, encryptSecret, decryptSecret, CryptoError } from "../src/crypto.mjs";

const KEY = new Uint8Array(randomBytes(32));
const OTHER = new Uint8Array(randomBytes(32));
const hex = (u8) => Buffer.from(u8).toString("hex");

describe("parseKey", () => {
  test("vacio -> null (el que llama decide si es fatal)", () => {
    assert.equal(parseKey(""), null);
    assert.equal(parseKey(undefined), null);
  });
  test("acepta 64 hex", () => assert.equal(hex(parseKey(hex(KEY))), hex(KEY)));
  test("acepta base64 de 32 bytes", () => assert.equal(hex(parseKey(Buffer.from(KEY).toString("base64"))), hex(KEY)));
  test("rechaza otra longitud", () => {
    assert.throws(() => parseKey("abc"), (e) => e instanceof CryptoError && e.code === "bad_key");
    assert.throws(() => parseKey(randomBytes(16).toString("hex")), (e) => e instanceof CryptoError && e.code === "bad_key");
  });
});

describe("encryptSecret / decryptSecret (AES-256-GCM por WebCrypto)", () => {
  test("roundtrip", async () => {
    const token = "EAAG" + "x".repeat(180) + "ñ✓";
    const blob = await encryptSecret(token, KEY);
    assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(await decryptSecret(blob, KEY), token);
  });

  test("el blob no contiene el token en claro", async () => {
    const blob = await encryptSecret("EAAGsecret123", KEY);
    assert.equal(blob.includes("EAAGsecret123"), false);
  });

  test("dos cifrados del mismo texto son distintos (iv nuevo cada vez)", async () => {
    assert.notEqual(await encryptSecret("x", KEY), await encryptSecret("x", KEY));
  });

  test("otra clave no descifra", async () => {
    const blob = await encryptSecret("x", KEY);
    await assert.rejects(decryptSecret(blob, OTHER), (e) => e instanceof CryptoError && e.code === "bad_decrypt");
  });

  test("un blob manipulado no descifra (tag de autenticacion)", async () => {
    const blob = await encryptSecret("hola", KEY);
    const parts = blob.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    await assert.rejects(decryptSecret(parts.join("."), KEY), (e) => e instanceof CryptoError && e.code === "bad_decrypt");
  });

  test("formato desconocido", async () => {
    await assert.rejects(decryptSecret("v0.a.b.c", KEY), (e) => e instanceof CryptoError && e.code === "malformed");
    await assert.rejects(decryptSecret("", KEY), (e) => e instanceof CryptoError && e.code === "malformed");
  });

  test("sin clave no cifra ni descifra", async () => {
    await assert.rejects(encryptSecret("x", null), (e) => e instanceof CryptoError && e.code === "no_key");
    await assert.rejects(decryptSecret("v1.a.b.c", null), (e) => e instanceof CryptoError && e.code === "no_key");
  });
});
