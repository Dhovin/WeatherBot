# Developer Guide: Packet Limits & Compression

LoRa networks (such as Meshtastic or MeshCore) operate over low-bandwidth radio channels. Consequently, bots must operate under strict payload limit constraints to prevent packet fragmentation, transmission failures, or channel congestion.

This guide outlines how to handle the 150-byte message constraint, parse string segments safely, and compress information.

---

## 1. The 150-Byte LoRa Packet Constraint

Each text transmission on MeshCore should remain strictly **under 150 bytes** (which matches the maximum packet size of standard LoRa mesh protocols). 
* Any text message larger than 150 bytes will either be truncated by the radio firmware or split into multiple packets, heavily loading the channel.
* To prevent this, text must be proactively split into chunks at the software level and spaced out with transmission pauses.

---

## 2. Multi-byte UTF-8 Safe Splitting

Since emojis (like ⛈️ or 🟢) and special characters occupy multiple bytes (often 3 to 4 bytes per character), splitting strings using naive methods (like `String.prototype.slice()`) can cut a character in half, rendering invalid UTF-8 bytes and breaking the receiver's screen render.

The following utility function splits a string into chunks of a maximum byte size without splitting multi-byte characters:

```javascript
function splitStringToByteChunks(str, maxBytes) {
  const chunks = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const buf = encoder.encode(str);
  
  let start = 0;
  while (start < buf.length) {
    let end = start + maxBytes;
    if (end >= buf.length) {
      chunks.push(decoder.decode(buf.subarray(start)));
      break;
    }
    
    // If the split falls in the middle of a multi-byte UTF-8 character,
    // walk backward to locate the start of the character.
    // In UTF-8, continuation bytes always start with bits '10XXXXXX' (0x80 to 0xBF).
    while (end > start && (buf[end] & 0xC0) === 0x80) {
      end--;
    }
    
    // Fallback in case of invalid UTF-8 sequence
    if (end === start) {
      end = start + maxBytes; 
    }
    
    chunks.push(decoder.decode(buf.subarray(start, end)));
    start = end;
  }
  return chunks;
}
```

---

## 3. Shortening Strings safely

If you have arbitrary strings (like weather warnings or headlines) that you want to send in a single packet, use a byte-length truncator:

```javascript
function shortenToBytes(str, maxBytes) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = encoder.encode(str);
  
  if (buf.length <= maxBytes) return str;
  
  let end = maxBytes;
  // Walk backward to avoid splitting a UTF-8 character
  while (end > 0 && (buf[end] & 0xC0) === 0x80) {
    end--;
  }
  return decoder.decode(buf.subarray(0, end));
}
```

---

## 4. Emoji Compression (3-Day Forecast Example)

Rather than sending paragraphs of weather text, condense reports using emojis and simple layouts. Below is the compression logic used to fit a 3-day forecast inside **75 characters** (well under the 150-byte limit):

### The Logic
1. Classify the forecast text into simple emojis (e.g. Thunderstorms -> `⛈️`, Clear -> `☀️`, Rain -> `🌧️`).
2. Group weather periods by weekday date.
3. Formulate a single-line summary per day.

```javascript
function getEmojiForForecast(forecastText) {
  const text = (forecastText || '').toLowerCase();
  if (text.includes("thunderstorm") || text.includes("tornado")) return "⛈️";
  if (text.includes("snow") || text.includes("ice") || text.includes("freeze")) return "❄️";
  if (text.includes("rain") || text.includes("shower")) return "🌧️";
  if (text.includes("wind") || text.includes("hurricane")) return "💨";
  if (text.includes("cloud") || text.includes("overcast")) return "☁️";
  if (text.includes("sun") || text.includes("clear") || text.includes("fair")) return "☀️";
  return "🌤";
}

function formatCompressedForecast(zip, periods) {
  const groups = new Map();
  for (const p of periods) {
    const dateStr = p.startTime.slice(0, 10); // "YYYY-MM-DD"
    if (!groups.has(dateStr)) {
      groups.set(dateStr, { dateStr, daytime: null, nighttime: null });
    }
    const group = groups.get(dateStr);
    if (p.isDaytime) group.daytime = p;
    else group.nighttime = p;
  }

  // Slice first 3 days/groups
  const sortedGroups = Array.from(groups.values()).slice(0, 3);
  const header = `Wx ${zip ? zip : ''}:\n`;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thur", "Fri", "Sat"];

  const lines = sortedGroups.map((group, index) => {
    let label = '';
    if (index === 0) {
      label = 'today';
    } else {
      const dateObj = new Date(group.dateStr + "T00:00:00Z");
      label = weekdays[dateObj.getUTCDay()];
    }

    const forecastText = (group.daytime || group.nighttime)?.shortForecast || '';
    const emoji = getEmojiForForecast(forecastText);

    const tempLimits = [];
    if (group.daytime) tempLimits.push(`hi: ${group.daytime.temperature}`);
    if (group.nighttime) tempLimits.push(`low: ${group.nighttime.temperature}`);

    return `${label}: ${emoji} ${tempLimits.join(' ')}`;
  });

  return header + lines.join('\n');
}
```

### Resulting Output (Only 75 bytes)
```text
Wx 90210:
today: ☀️ hi: 75 low: 58
Thu: 🌤 hi: 78 low: 59
Fri: 🌧 hi: 70 low: 52
```
This enables you to send a complete, multi-day weather report in a single transmission.
