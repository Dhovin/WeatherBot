import { ed25519 } from '@noble/curves/ed25519';
import crypto from 'crypto';
import { Constants } from '@liamcottle/meshcore.js';

// Base64url encode without padding
function base64urlEncode(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Convert little-endian bytes to BigInt
function bytesToNumberLE(bytes) {
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value += BigInt(bytes[i]) << (8n * BigInt(i));
  }
  return value;
}

function sha512(data) {
  return crypto.createHash('sha512').update(data).digest();
}

// Signs a message using Ed25519 with expanded key (scalar || prefix)
export function signWithExpandedKey(msg, privateKeyBytes, publicKeyBytes) {
  if (privateKeyBytes.length !== 64) {
    throw new Error(`Private key must be 64 bytes, got ${privateKeyBytes.length}`);
  }
  if (publicKeyBytes.length !== 32) {
    throw new Error(`Public key must be 32 bytes, got ${publicKeyBytes.length}`);
  }

  const Fn = ed25519.Point.Fn;
  const BASE = ed25519.Point.BASE;

  const scalarBytes = privateKeyBytes.subarray(0, 32);
  const prefix = privateKeyBytes.subarray(32, 64);

  const scalar = Fn.create(bytesToNumberLE(scalarBytes));

  // r = SHA512(prefix || msg) mod L
  const rBytes = sha512(Buffer.concat([prefix, msg]));
  const r = Fn.create(bytesToNumberLE(rBytes));

  // R = rG
  const R = BASE.multiply(r).toBytes();

  // k = SHA512(R || publicKeyBytes || msg) mod L
  const kBytes = sha512(Buffer.concat([R, publicKeyBytes, msg]));
  const k = Fn.create(bytesToNumberLE(kBytes));

  // s = (r + k * scalar) mod L
  const s = Fn.create(r + k * scalar);

  // signature is R || s (64 bytes)
  const sig = new Uint8Array(64);
  sig.set(R, 0);
  sig.set(Fn.toBytes(s), 32);
  return sig;
}

// Helper to wait for Ok or Err response for a connection command
async function waitOkOrErr(connection, commandFn, timeoutMs = 5000) {
  return new Promise(async (resolve, reject) => {
    let cleanedUp = false;
    
    const timer = setTimeout(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error("Timeout waiting for Ok/Err response"));
    }, timeoutMs);
    
    function onOk(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onErr);
      resolve(data);
    }
    
    function onErr(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error(`Command returned error code: ${data.errCode}`));
    }
    
    connection.on(Constants.ResponseCodes.Ok, onOk);
    connection.on(Constants.ResponseCodes.Err, onErr);
    
    try {
      await commandFn();
    } catch (err) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Ok, onOk);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(err);
    }
  });
}

// Sign message using connected companion device
export async function signWithDevice(connection, msgBytes) {
  if (!connection) {
    throw new Error("No companion connection provided for on-device signing");
  }

  console.log(`[Auth Token] Starting on-device signing for message length ${msgBytes.length} bytes...`);

  // 1. Sign start
  const startRes = await new Promise(async (resolve, reject) => {
    let cleanedUp = false;
    const timer = setTimeout(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      connection.off(Constants.ResponseCodes.SignStart, onStart);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error("Timeout waiting for SignStart response"));
    }, 5000);
    
    function onStart(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.SignStart, onStart);
      connection.off(Constants.ResponseCodes.Err, onErr);
      resolve(data);
    }
    
    function onErr(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.SignStart, onStart);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error(`SignStart returned error code: ${data.errCode}`));
    }
    
    connection.on(Constants.ResponseCodes.SignStart, onStart);
    connection.on(Constants.ResponseCodes.Err, onErr);
    
    try {
      await connection.sendCommandSignStart();
    } catch (err) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.SignStart, onStart);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(err);
    }
  });

  const maxLen = startRes.maxSignDataLen || 120;
  const chunkSize = Math.min(120, maxLen);
  console.log(`[Auth Token] SignStart successful. maxSignDataLen: ${maxLen}, chunk size: ${chunkSize}`);

  // 2. Send chunks
  for (let offset = 0; offset < msgBytes.length; offset += chunkSize) {
    const chunk = msgBytes.subarray(offset, offset + chunkSize);
    await waitOkOrErr(connection, () => connection.sendCommandSignData(chunk));
  }

  // 3. Finish sign and wait for signature
  const finishRes = await new Promise(async (resolve, reject) => {
    let cleanedUp = false;
    const timer = setTimeout(() => {
      if (cleanedUp) return;
      cleanedUp = true;
      connection.off(Constants.ResponseCodes.Signature, onSig);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error("Timeout waiting for Signature response"));
    }, 10000);
    
    function onSig(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Signature, onSig);
      connection.off(Constants.ResponseCodes.Err, onErr);
      resolve(data);
    }
    
    function onErr(data) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Signature, onSig);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(new Error(`SignFinish returned error code: ${data.errCode}`));
    }
    
    connection.on(Constants.ResponseCodes.Signature, onSig);
    connection.on(Constants.ResponseCodes.Err, onErr);
    
    try {
      await connection.sendCommandSignFinish();
    } catch (err) {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      connection.off(Constants.ResponseCodes.Signature, onSig);
      connection.off(Constants.ResponseCodes.Err, onErr);
      reject(err);
    }
  });

  console.log("[Auth Token] On-device signing completed successfully.");
  return finishRes.signature;
}

// Generate the signed JWT token for a given public key & optional private key / connection
export async function createAuthToken(publicKeyHex, privateKeyHex = null, expirySeconds = 86400, connection = null, claims = {}) {
  if (!publicKeyHex) {
    throw new Error("publicKeyHex is required");
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const expTime = currentTime + expirySeconds;

  const payload = {
    publicKey: publicKeyHex.toUpperCase(),
    iat: currentTime,
    exp: expTime,
    ...claims
  };

  const header = {
    alg: 'Ed25519',
    typ: 'JWT'
  };

  const headerEncoded = base64urlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
  const payloadEncoded = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));

  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signingInputBytes = Buffer.from(signingInput, 'utf8');

  let signatureBytes;
  if (privateKeyHex) {
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    signatureBytes = signWithExpandedKey(signingInputBytes, privateKeyBytes, publicKeyBytes);
  } else if (connection) {
    signatureBytes = await signWithDevice(connection, signingInputBytes);
  } else {
    throw new Error("No signing method available: either privateKeyHex or active connection must be provided");
  }

  const signatureHex = Buffer.from(signatureBytes).toString('hex');
  return `${headerEncoded}.${payloadEncoded}.${signatureHex}`;
}
