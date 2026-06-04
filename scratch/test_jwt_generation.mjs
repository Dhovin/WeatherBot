import { createAuthToken, signWithExpandedKey } from '../modules/auth_token.mjs';
import { ed25519 } from '@noble/curves/ed25519';
import crypto from 'crypto';

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

async function runTests() {
  console.log("Running JWT Generation Tests...");

  // Generate random keys
  const seed = crypto.randomBytes(32);
  const { secretKey, publicKey } = ed25519.keygen(seed);
  const publicKeyHex = Buffer.from(publicKey).toString('hex');

  const ext = ed25519.utils.getExtendedPublicKey(secretKey);
  const expandedKeyBytes = new Uint8Array(64);
  expandedKeyBytes.set(ext.head, 0);
  expandedKeyBytes.set(ext.prefix, 32);
  const privateKeyHex = Buffer.from(expandedKeyBytes).toString('hex');

  const claims = { aud: "mqtt-us-v1.letsmesh.net" };
  const token = await createAuthToken(publicKeyHex, privateKeyHex, 86400, null, claims);

  console.log("Generated Token:", token);

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`Token does not have 3 parts: ${parts.length}`);
  }

  // Decode and check header
  const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  console.log("Decoded Header:", header);
  if (header.alg !== 'Ed25519' || header.typ !== 'JWT') {
    throw new Error("Invalid header structure");
  }

  // Decode and check payload
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  console.log("Decoded Payload:", payload);
  if (payload.publicKey !== publicKeyHex.toUpperCase()) {
    throw new Error("Invalid publicKey in payload");
  }
  if (payload.aud !== 'mqtt-us-v1.letsmesh.net') {
    throw new Error("Invalid aud in payload");
  }
  if (!payload.iat || !payload.exp) {
    throw new Error("Missing iat or exp in payload");
  }

  // Verify signature
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signingInputBytes = Buffer.from(signingInput, 'utf8');
  const signatureBytes = Buffer.from(parts[2], 'hex');

  const verified = ed25519.verify(signatureBytes, signingInputBytes, publicKey);
  console.log("JWT Signature Verified locally:", verified);
  if (!verified) {
    throw new Error("JWT Signature verification failed!");
  }

  console.log("✓ All JWT generation tests passed!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
