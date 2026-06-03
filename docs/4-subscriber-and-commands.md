# Developer Guide: Subscribers & Commands

This guide explains how to construct an interactive command parsing loop, handle local user storage, and enforce paced transmission intervals to avoid flooding the LoRa mesh network.

---

## 1. Command Routing Architecture

To make your bot interactive, feed all incoming text messages through a central parser. The parser should trim whitespace, handle casing, strip sender usernames (which MeshCore prepends automatically), and match commands using regular expressions.

```javascript
async function handleIncomingMessage(text, replyCallback, contact = null) {
  if (!text) return;
  let cleanText = text.trim();
  
  // Strip MeshCore username prefix (e.g., "Dhovin: 76244" -> "76244")
  cleanText = cleanText.replace(/^[A-Za-z0-9_.-]+:\s+/, '').trim();
  const lowerText = cleanText.toLowerCase();

  // 1. Version / Information Queries
  if (lowerText === 'version' || lowerText === 'info') {
    await replyCallback(`MyBot v1.0.0`);
    return;
  }

  // 2. Direct-Message Only Subscriptions
  if (lowerText.startsWith('subscribe')) {
    if (!contact) {
      await replyCallback('Error: Subscriptions must be requested via DM.');
      return;
    }
    const match = cleanText.match(/^subscribe\s+(\d{5})$/i);
    if (!match) {
      await replyCallback('Usage: subscribe [ZIP]');
      return;
    }
    const zip = match[1];
    await handleSubscribe(contact.publicKey, zip, replyCallback);
    return;
  }

  if (lowerText === 'unsubscribe') {
    if (!contact) {
      await replyCallback('Error: Subscriptions must be requested via DM.');
      return;
    }
    await handleUnsubscribe(contact.publicKey, replyCallback);
    return;
  }

  // 3. Coordinate Weather Query (Standard Query)
  if (/^\d{5}$/.test(cleanText)) {
     // Handle weather request...
  }
}
```

---

## 2. Subscription Storage Database (`subscriptions.json`)

For lightweight bots, a simple JSON file provides a robust, no-dependency database structure. Write changes synchronously (or safely asynchronously) and cache operations in memory:

```javascript
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SUBS_FILE = './subscriptions.json';

function readSubscriptions() {
  if (!existsSync(SUBS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SUBS_FILE, 'utf-8'));
  } catch (err) {
    console.error('Error reading database:', err.message);
    return {};
  }
}

function writeSubscriptions(subs) {
  try {
    writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing database:', err.message);
  }
}

async function addSubscription(publicKey, zip, displayName, lat, lon, forecastUrl) {
  const subs = readSubscriptions();
  const key = Buffer.from(publicKey).toString('hex');
  
  subs[key] = {
    publicKeyHex: key,
    zipCode: zip,
    displayName,
    lat,
    lon,
    forecastUrl,
    subscribedAt: Date.now()
  };
  
  writeSubscriptions(subs);
}
```

---

## 3. Paced Transmissions (Anti-Flood Controls)

LoRa transmitters operate on low duty cycles. If a bot broadcasts multiple messages back-to-back, or sends updates to several subscribers at once, the radio hardware buffer will overflow, causing packets to drop.

Implement a sleep utility to pause transmission between packets:

```javascript
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function broadcastToSubscribers() {
  const subs = readSubscriptions();
  const subKeys = Object.keys(subs);
  
  console.log(`Sending daily alerts to ${subKeys.length} subscribers...`);

  for (const key of subKeys) {
    const sub = subs[key];
    const publicKey = Buffer.from(key, 'hex');

    try {
      // Message 1: Weather Synopsis
      await connection.sendTextMessage(publicKey, "Synopsis...", Constants.TxtTypes.Plain);
      
      // PAUSE: Wait 5 seconds between consecutive parts of a message
      await sleep(5000);

      // Message 2: 3-Day compressed forecast
      await connection.sendTextMessage(publicKey, "Forecast...", Constants.TxtTypes.Plain);

      // PAUSE: Wait 10 seconds between different subscribers to let the queue clear
      await sleep(10000);

    } catch (err) {
      console.error(`Failed to send to subscriber ${key}:`, err.message);
    }
  }
}
```
This pacing keeps your bot safe from local regulatory duty cycle limits and prevents node TX congestion.
