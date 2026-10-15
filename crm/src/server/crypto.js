const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const base64url = (bytes) => b64(bytes).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(text) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const aesKey = (keyB64) => crypto.subtle.importKey("raw", unb64(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);

/** AES-GCM; the output is base64(iv ‖ ciphertext). */
export async function encrypt(keyB64, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(text)));
  return b64(new Uint8Array([...iv, ...data]));
}

export async function decrypt(keyB64, sealed) {
  const bytes = unb64(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await aesKey(keyB64), bytes.slice(12));
  return new TextDecoder().decode(plain);
}
