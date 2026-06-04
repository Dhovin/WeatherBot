# Developer Guide: NWS API & Geocoding

This guide explains how to integrate with the National Weather Service (NWS) API and implement a dual-redundant US ZIP code geocoding system with automatic rate-limit fallbacks.

---

## 1. NWS API Integration & User-Agent Policy

The National Weather Service (NWS) API (`api.weather.gov`) does not require an API key, but it enforces a **strict User-Agent header policy**. If your request does not contain a custom User-Agent identifying your application and containing contact information (such as an email address), the NWS will block the requests.

Always include headers in your fetches:

```javascript
async function fetchNWS(url, contactEmail) {
  const userAgent = `MeshBot/1.1.0 (${contactEmail})`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      'Accept': 'application/geo+json'
    }
  });

  if (!res.ok) {
    throw new Error(`NWS API error ${res.status}: ${res.statusText}`);
  }

  return res.json();
}
```

---

## 2. Resolving Coordinates to NWS Forecast Endpoints

The NWS API does not return forecasts by coordinates directly. Instead, you perform a two-step handshake:
1. Call the `points` metadata endpoint with coordinates to fetch the location's specific grid identifier and forecast URL.
2. Fetch the weather periods from that resolved forecast URL.

```javascript
async function getForecastByCoordinates(lat, lon, email) {
  // Step 1: Resolve metadata points
  const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
  const pointsData = await fetchNWS(pointsUrl, email);
  
  // Step 2: Retrieve the forecast endpoint (e.g. /gridpoints/LWX/96,72/forecast)
  const forecastUrl = pointsData.properties.forecast;
  const forecastData = await fetchNWS(forecastUrl, email);
  
  return forecastData.properties.periods;
}
```

---

## 3. Dynamic Local Timezone Resolution

LoRa bot servers often run in UTC timezone. To trigger alarms at the user's exact local time (e.g., exactly at 6:00 AM local time), extract the timezone identifier (e.g., `America/Chicago`) dynamically from the NWS Points response:

```javascript
// Extract timezone dynamically
const localTimeZone = pointsData.properties.timeZone || 'UTC';

// To calculate next alarm matching localTimeZone:
function setAlarm(alarmTimeStr, callback, timeZone) {
  const [hour, minute] = alarmTimeStr.split(':').map(Number);
  
  const check = () => {
    const now = new Date();
    // Resolve current hour/minute in the target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone
    });
    
    const parts = formatter.formatToParts(now);
    const localHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const localMinute = parseInt(parts.find(p => p.type === 'minute').value, 10);

    if (localHour === hour && localMinute === minute) {
      callback();
    }
  };

  setInterval(check, 60 * 1000); // Check every minute
}
```

---

## 4. Dual-Redundant Geocoder (Zippopotam -> OSM Nominatim)

Using third-party APIs for geocoding can result in rate-limit blocks (especially if hosting your bot on cloud environments like AWS or DigitalOcean, where IP blocks are common). 

Implement a dual-redundant geocoder that queries Zippopotam first (fast, open, no authentication, no VM IP blocks) and falls back to OpenStreetMap (OSM) Nominatim:

```javascript
async function resolveZip(zip, email) {
  // Layer 1: Try zippopotam.us first
  try {
    const url = `https://api.zippopotam.us/us/${zip}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.places && data.places.length > 0) {
        const place = data.places[0];
        const lat = parseFloat(place.latitude);
        const lon = parseFloat(place.longitude);
        const displayName = `${place['place name']}, ${place['state abbreviation']}`;
        return { lat, lon, displayName };
      }
    }
  } catch (err) {
    console.warn(`Zippopotam lookup failed for ZIP ${zip}, trying Nominatim...`, err.message);
  }

  // Layer 2: Fallback to OSM Nominatim
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': `MeshBot/1.1.0 (${email})`
    }
  });
  if (!res.ok) throw new Error(`OSM HTTP error ${res.status}`);
  const data = await res.json();
  if (data && data.length > 0) {
    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);
    const nameParts = data[0].display_name.split(',');
    const city = nameParts[0] || '';
    const state = nameParts[2] ? nameParts[2].trim() : (nameParts[1] ? nameParts[1].trim() : '');
    const displayName = `${city}, ${state}`.replace(/,\s*$/, '');
    return { lat, lon, displayName };
  }

  throw new Error("No geocoding matches found");
}
```
