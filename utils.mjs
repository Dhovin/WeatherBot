function bufferToHexString(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function degreesToCompass8(degrees) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(degrees / 45) % 8;
  return directions[index];
}

export function normalizeText(text) {
  return text.normalize('NFD').trim().replaceAll(/[\n\u0300-\u036f]/g, '');
}

export function calculateHeadingAndDistance(myLat, myLon, targetLat, targetLon) {
  const R = 6371; // Earth radius in km
  const toRadians = (degrees) => degrees * (Math.PI / 180);
  const toDegrees = (radians) => radians * (180 / Math.PI);

  const lat1Rad = toRadians(myLat);
  const lon1Rad = toRadians(myLon);
  const lat2Rad = toRadians(targetLat);
  const lon2Rad = toRadians(targetLon);

  const dLat = lat2Rad - lat1Rad;
  const dLon = lon2Rad - lon1Rad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  const bearingRad = Math.atan2(y, x);
  const heading = (toDegrees(bearingRad) + 360) % 360;

  return {
    heading: degreesToCompass8(heading),
    distance: R * c
  };
}

// Reverse Geocoding using OpenStreetMap Nominatim
export function geoCode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;

  return fetch(url, {
    headers: {
      'User-Agent': 'MeshCoreWeatherBot/1.0 (contact@example.com)'
    }
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
      return res.json();
    })
    .then(json => {
      if (json.error) return '';

      const address = json.address || {};
      let location = '';

      if (address.village) location += `${address.village}, `;
      else if (address.town) location += `${address.town}, `;
      else if (address.city) location += `${address.city}, `;

      if (address.municipality) location += `${address.municipality}, `;
      if (address.state) location += `${address.state}, `;
      if (address.country) location += `${address.country}`;

      return location.replace(/,\s*$/, '');
    })
    .catch(err => {
      console.error('Geocoding failed:', err);
      return '';
    });
}

export function trimAndNormalize(str) {
  return normalizeText(str.replaceAll(/[\n\s]+/g, ' ').trim());
}

export function shortenToBytes(str, maxBytes) {
  if (typeof str !== 'string' || typeof maxBytes !== 'number' || maxBytes < 0) {
    return '';
  }

  const encoder = new TextEncoder();
  const encoded = encoder.encode(str);

  if (encoded.length <= maxBytes) {
    return str;
  }

  const decoder = new TextDecoder('utf-8');
  let truncatedBytes = encoded.slice(0, maxBytes);
  let truncatedString = decoder.decode(truncatedBytes, { stream: true });

  while (encoder.encode(truncatedString).length > maxBytes) {
    truncatedString = truncatedString.slice(0, -1);
  }

  const match = truncatedString.match(/^(.*)\s/s);
  if (match && match[1]) {
    return match[1];
  } else {
    return '';
  }
}

export function splitStringToByteChunks(str, maxBytes) {
  if (typeof str !== 'string' || typeof maxBytes !== 'number' || maxBytes <= 0) {
    return [];
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks = [];
  let remainingStr = str.trim();

  while (remainingStr.length > 0) {
    if (encoder.encode(remainingStr).length <= maxBytes) {
      chunks.push(remainingStr);
      break;
    }

    let candidateChunk = '';
    const encoded = encoder.encode(remainingStr);
    const truncatedBytes = encoded.slice(0, maxBytes);

    candidateChunk = decoder.decode(truncatedBytes, { stream: true });
    while (encoder.encode(candidateChunk).length > maxBytes) {
      candidateChunk = candidateChunk.slice(0, -1);
    }

    if (candidateChunk.length === 0) {
      const oneCharLessBytes = encoded.slice(0, maxBytes - 3);
      candidateChunk = decoder.decode(oneCharLessBytes, { stream: true });
      if (candidateChunk.length === 0) break; // Safety break
    }

    let splitIndex = -1;
    const sentenceMatch = candidateChunk.match(/^(.*[.?!])\s/s);
    if (sentenceMatch && sentenceMatch[1]) {
      splitIndex = sentenceMatch[1].length;
    } else {
      const whitespaceMatch = candidateChunk.match(/^(.*)\s/s);
      if (whitespaceMatch && whitespaceMatch[1]) {
        splitIndex = whitespaceMatch[1].length;
      }
    }

    let finalChunk;
    if (splitIndex > 0) {
      finalChunk = remainingStr.substring(0, splitIndex);
    } else {
      finalChunk = candidateChunk;
    }

    chunks.push(finalChunk.trim());
    remainingStr = remainingStr.substring(finalChunk.length).trim();
  }

  return chunks;
}

export function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

export async function shaSumHex(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await globalThis.crypto.subtle.digest('SHA-1', data);
  return bufferToHexString(hash);
}

export function setAlarm(time, callback) {
  const [hoursStr, minutesStr] = time.split(':');
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);

  const seenAlarms = {};
  setInterval(() => {
    const date = new Date();
    const currentDate = date.toISOString().split('T')[0];
    if (date.getHours() === hours && date.getMinutes() === minutes && !seenAlarms[currentDate]) {
      console.debug('alarm triggered', date);
      seenAlarms[currentDate] = 1;
      callback(date);
    }
  }, 30 * 1000);
}

export function formatDate(date) {
  if (!date) return '';
  const dt = new Date(date);
  const optionsShort = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  return dt.toLocaleString("en-US", optionsShort);
}
