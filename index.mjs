import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { readFileSync } from 'fs';
import * as mqtt from 'mqtt';
import * as utils from './utils.mjs';

// Load config safely without ESM experimental warning
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));

// Auto-detect serial port if the configured one is not available
async function resolveSerialPort(configuredPort) {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();

    if (ports.length === 0) {
      return configuredPort;
    }

    // 1. If configured port exists, use it
    if (ports.some(p => p.path === configuredPort)) {
      return configuredPort;
    }

    console.warn(`Configured port "${configuredPort}" not found. Auto-detecting...`);

    // 2. Filter for USB serial ports (contain vendorId, productId, or serialNumber)
    const usbPorts = ports.filter(p => p.vendorId || p.productId || p.serialNumber);

    if (usbPorts.length > 0) {
      // Prioritize known ESP32 / USB UART VIDs
      const espPort = usbPorts.find(p => {
        const vid = (p.vendorId || '').toLowerCase();
        return vid === '303a' || vid === '239a' || vid === '10c4' || vid === '1a86';
      });

      const selectedPort = espPort ? espPort.path : usbPorts[0].path;
      console.log(`Auto-detected MeshCore USB device on port: "${selectedPort}"`);
      return selectedPort;
    }
  } catch (err) {
    console.warn("Serial port auto-detection failed:", err.message);
  }
  return configuredPort;
}

const configuredPort = process.argv[2] ?? config.port;
const port = await resolveSerialPort(configuredPort);

const channels = {
  alerts: null,
  weather: null
};

const seen = {
  blitz: {},
};

let geoCache = {};
let blitzBuffer = [];
const meteoAlerts = {};
let resolvedLocationName = '';

console.log(`Connecting to ${port}`);
const connection = new NodeJSSerialConnection(port);

connection.on('connected', async () => {
  console.log(`Connected to ${port}`);

  // Resolve ZIP code to GPS coordinates if provided
  if (config.zipCode && config.zipCode.toString().trim() !== "") {
    try {
      const zip = config.zipCode.toString().trim();
      console.log(`Resolving ZIP code "${zip}" to coordinates...`);
      const result = await resolveZip(zip);
      console.log(`Resolved ZIP code ${zip} to coordinates: ${result.lat}, ${result.lon} (${result.displayName})`);
      resolvedLocationName = result.displayName;
      config.myPosition = { lat: result.lat, lon: result.lon };
    } catch (err) {
      console.error(`Failed to geocode ZIP code ${config.zipCode}:`, err.message);
      console.warn('Falling back to manual coordinates from config.');
    }
  }

  // Calculate dynamic blitzArea bounding box if myPosition and blitzRadiusMiles are configured
  if (config.myPosition && config.blitzRadiusMiles) {
    const lat = config.myPosition.lat;
    const lon = config.myPosition.lon;
    const radiusMiles = config.blitzRadiusMiles;
    const latDegreeOffset = radiusMiles / 69;
    const lonDegreeOffset = radiusMiles / (69 * Math.cos(lat * Math.PI / 180));
    
    config.blitzArea = {
      minLat: lat - latDegreeOffset,
      maxLat: lat + latDegreeOffset,
      minLon: lon - lonDegreeOffset,
      maxLon: lon + lonDegreeOffset
    };
    console.log(`Calculated lightning bounding box (${radiusMiles} miles range around ${lat.toFixed(4)}, ${lon.toFixed(4)}):`, config.blitzArea);
  }

  for (const [channelType, channelName] of Object.entries(config.channels)) {
    channels[channelType] = await connection.findChannelByName(channelName);
    if (!channels[channelType]) {
      console.log(`Channel ${channelType}: "${channelName}" not found!`);
      connection.close();
      return;
    }
  }

  // Register Blitzortung lightning listener
  await registerBlitzortungMqtt(blitzHandler, config.blitzArea);

  // Daily weather forecast alarm
  utils.setAlarm(config.weatherAlarm, sendWeather);

  // Lightning check interval
  setInterval(blitzWarning, config.timers.blitzCollection);

  // NWS Active Alerts check interval
  if (config.meteoAlerts.enabled) {
    setInterval(checkMeteoAlerts, config.timers.meteoAlerts);
    checkMeteoAlerts();
  }

  console.log('weatherBot ready.');
});

// Listen for new incoming messages on the MeshCore node
connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    for (const message of waitingMessages) {
      if (message.contactMessage) {
        await onContactMessageReceived(message.contactMessage);
      } else if (message.channelMessage) {
        await onChannelMessageReceived(message.channelMessage);
      }
    }
  } catch (e) {
    console.error('Error handling waiting messages:', e);
  }
});

// Helper for fetching NWS API endpoints
async function fetchNWS(url) {
  const userAgent = config.userAgent || 'MeshCoreWeatherBot/1.0 (contact@example.com)';
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

// Dual-redundant US ZIP Code geocoder (Zippopotam -> OSM Nominatim)
async function resolveZip(zip) {
  // Try zippopotam.us first (unauthenticated, fast, no cloud IP block)
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

  // Fallback to OSM Nominatim
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': config.userAgent || 'MeshCoreWeatherBot/1.0 (contact@example.com)'
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

  throw new Error(`Could not resolve ZIP code ${zip}`);
}

async function checkMeteoAlerts() {
  const timeoutMs = config.meteoAlerts.timeout * 60 * 1000;
  Object.keys(meteoAlerts).forEach(key => {
    if (meteoAlerts[key] < Date.now() - timeoutMs) {
      delete meteoAlerts[key];
    }
  });

  try {
    const url = `https://api.weather.gov/alerts/active?point=${config.myPosition.lat},${config.myPosition.lon}`;
    const data = await fetchNWS(url);

    if (!data.features || data.features.length === 0) {
      return;
    }

    const warnings = [];
    for (const feature of data.features) {
      const props = feature.properties;
      if (!props) continue;

      const id = props.identifier || feature.id;
      
      const endTime = props.expires ? new Date(props.expires) : (props.ends ? new Date(props.ends) : null);
      if (endTime && endTime < Date.now()) {
        continue;
      }

      const severity = (props.severity || 'unknown').toLowerCase();
      const certainty = (props.certainty || 'unknown').toLowerCase();

      if (!config.meteoAlerts.severityFilter.includes(severity) ||
          !config.meteoAlerts.certaintyFilter.includes(certainty)) {
        continue;
      }

      if (meteoAlerts[id]) {
        continue;
      }

      warnings.push({
        id,
        region: props.areaDesc || 'Unknown Area',
        event: props.event,
        start: props.onset,
        end: props.expires || props.ends,
        severity,
        certainty,
        headline: props.headline || '',
        instruction: props.instruction || ''
      });
    }

    if (warnings.length > 0) {
      const sorted = warnings.sort((a, b) => new Date(a.start) - new Date(b.start));
      for (const item of sorted) {
        const message = interpolate(config.meteoAlerts.messageTemplate, {
          region: item.region,
          start: utils.formatDate(item.start),
          end: utils.formatDate(item.end),
          event: item.event,
          severity: config.meteoAlerts.severity[item.severity] || item.severity,
          certainty: config.meteoAlerts.certainty[item.certainty] || item.certainty,
          headline: item.headline,
          instruction: item.instruction
        });

        await sendAlert(message, channels.alerts);
        meteoAlerts[item.id] = Date.now();
        await utils.sleep(30 * 1000);
      }
    }
  } catch (err) {
    console.error('Failed to check meteo alerts:', err);
  }
}

function interpolate(str, data) {
  return str.replace(/\{([^}]+)\}/g, (_, key) => {
    return data[key] ?? "";
  });
}

// Maps weather descriptors to emojis for short, high-density LoRa transmission
function getEmojiForForecast(forecastText) {
  const text = (forecastText || '').toLowerCase();
  if (text.includes('thunder') || text.includes('storm')) return '⛈️';
  if (text.includes('snow') || text.includes('ice') || text.includes('sleet') || text.includes('freeze') || text.includes('flurry')) return '❄️';
  if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return '🌧️';
  if (text.includes('fog') || text.includes('mist') || text.includes('haze')) return '🌫️';
  if (text.includes('wind') || text.includes('breezy') || text.includes('windy')) return '💨';
  if (text.includes('sunny') || text.includes('clear')) return '☀️';
  if (text.includes('cloud') || text.includes('overcast') || text.includes('gloomy')) return '☁️';
  return '⛅'; // Default fallback
}

// Formats NWS forecast periods to a compressed string with emojis
function formatCompressedForecast(zip, displayName, periods, numPeriods = 2) {
  const selectedPeriods = periods.slice(0, numPeriods);
  const locationHeader = displayName ? ` (${displayName})` : '';
  const header = `🌦️ Wx ${zip ? zip : ''}${locationHeader}:\n`;
  const lines = selectedPeriods.map(p => {
    const emoji = getEmojiForForecast(p.shortForecast);
    const wind = p.windSpeed && p.windDirection ? ` Wind ${p.windDirection} ${p.windSpeed}` : '';
    return `${emoji} ${p.name}: ${p.shortForecast}. Temp ${p.temperature}°${p.temperatureUnit}.${wind}`;
  });
  return header + lines.join('\n');
}

async function handleIncomingMessage(text, replyCallback) {
  if (!text) return;
  let cleanText = text.trim();
  
  // Strip MeshCore username prefix (e.g. "Dhovin: 76244" -> "76244")
  cleanText = cleanText.replace(/^[A-Za-z0-9_.-]+:\s+/, '').trim();
  
  let zip = null;
  
  // Pattern 1: just a 5-digit number
  if (/^\d{5}$/.test(cleanText)) {
    zip = cleanText;
  } else {
    // Pattern 2: matches weather/wx commands (e.g. !weather 90210, /wx 10001, weather 30303)
    const match = cleanText.match(/^[!/#]?(weather|wx)\s+(\d{5})$/i);
    if (match) {
      zip = match[2];
    }
  }

  if (!zip) return; // Not a weather request

  console.log(`Processing interactive weather request for ZIP: ${zip}`);
  try {
    // 1. Geocode ZIP code to coordinates using dual-redundant resolver
    const result = await resolveZip(zip);
    const lat = result.lat;
    const lon = result.lon;
    const displayName = result.displayName;

    // 2. Fetch NWS Points Metadata to resolve grid forecast endpoint
    const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
    const pointsRes = await fetch(pointsUrl, {
      headers: {
        'User-Agent': config.userAgent || 'MeshCoreWeatherBot/1.0 (contact@example.com)',
        'Accept': 'application/geo+json'
      }
    });
    if (!pointsRes.ok) throw new Error(`NWS points HTTP error ${pointsRes.status}`);
    const pointsData = await pointsRes.json();
    const forecastUrl = pointsData.properties.forecast;

    // 3. Fetch Forecast Details
    const forecastRes = await fetch(forecastUrl, {
      headers: {
        'User-Agent': config.userAgent || 'MeshCoreWeatherBot/1.0 (contact@example.com)',
        'Accept': 'application/geo+json'
      }
    });
    if (!forecastRes.ok) throw new Error(`NWS forecast HTTP error ${forecastRes.status}`);
    const forecastData = await forecastRes.json();
    const periods = forecastData.properties.periods;

    if (!periods || periods.length === 0) {
      await replyCallback(`Error: No forecast data found for ZIP ${zip}`);
      return;
    }

    // 4. Format first 2 periods (e.g. Today/Tonight) for brief compressed interactive reply
    const forecastText = formatCompressedForecast(zip, displayName, periods, 2);

    // 5. Send back in chunks
    const chunks = utils.splitStringToByteChunks(forecastText, 130);
    for (const chunk of chunks) {
      await replyCallback(chunk);
      await utils.sleep(5000);
    }
  } catch (err) {
    console.error(`Failed to handle weather request for ${zip}:`, err);
    await replyCallback(`Error fetching weather for ZIP ${zip}. Please try again later.`);
  }
}

async function onContactMessageReceived(message) {
  console.log('Received contact message:', message);
  if (!message.text) return;

  const contact = await connection.findContactByPublicKeyPrefix(message.pubKeyPrefix);
  if (!contact) {
    console.log("Did not find contact for received message");
    return;
  }

  await handleIncomingMessage(message.text, async (replyText) => {
    await connection.sendTextMessage(contact.publicKey, replyText, Constants.TxtTypes.Plain);
    console.log(`Sent contact reply: ${replyText}`);
  });
}

async function onChannelMessageReceived(message) {
  console.log('Received channel message:', message);
  if (!message.text) return;

  // Only reply to messages on the #weather channel
  if (message.channelIdx !== channels.weather?.channelIdx) {
    console.log(`Ignored channel message on channel index ${message.channelIdx} (not #weather channel index ${channels.weather?.channelIdx})`);
    return;
  }

  await handleIncomingMessage(message.text, async (replyText) => {
    await connection.sendChannelTextMessage(message.channelIdx, replyText);
    console.log(`Sent channel reply to index ${message.channelIdx}: ${replyText}`);
  });
}

async function sendWeather(date) {
  console.log('Starting scheduled daily weather broadcast...');
  const weatherText = await getWeather();
  const chunks = utils.splitStringToByteChunks(weatherText, 130);
  if (chunks.length === 0) return;

  for (const message of chunks) {
    await sendAlert(message, channels.weather);
  }
}

let cachedForecastUrl = null;

async function getWeather() {
  try {
    if (!cachedForecastUrl) {
      const url = `https://api.weather.gov/points/${config.myPosition.lat},${config.myPosition.lon}`;
      console.log(`Retrieving grid forecast URL for ${config.myPosition.lat}, ${config.myPosition.lon}`);
      const pointsData = await fetchNWS(url);
      cachedForecastUrl = pointsData.properties.forecast;
    }

    const forecastData = await fetchNWS(cachedForecastUrl);
    const periods = forecastData.properties.periods;
    if (!periods || periods.length === 0) {
      return 'No forecast periods available.';
    }

    // Take the top 3 periods and format compressed with emojis
    return formatCompressedForecast(config.zipCode, resolvedLocationName, periods, 3);
  } catch (err) {
    console.error('Failed to get NWS forecast:', err);
    return `Weather Forecast Unavailable: ${err.message}`;
  }
}

async function registerBlitzortungMqtt(blitzCallback, blitzArea) {
  console.log(`Connecting to Blitzortung MQTT broker...`);
  const client = await mqtt.connectAsync('mqtt://blitzortung.ha.sed.pl:1883');
  const decoder = new TextDecoder();

  client.on('message', (_, data) => {
    try {
      const json = decoder.decode(data);
      const blitzData = JSON.parse(json);
      if (blitzData.lat < blitzArea.minLat || blitzData.lon < blitzArea.minLon ||
        blitzData.lat > blitzArea.maxLat || blitzData.lon > blitzArea.maxLon) {
        return;
      }
      blitzCallback(blitzData);
    } catch (err) {
      console.error('Error processing Blitzortung message:', err);
    }
  });

  await client.subscribeAsync('blitzortung/1.1/#');
  console.log('Subscribed to Blitzortung lightning notifications.');
}

function blitzHandler(blitzData) {
  const blitz = utils.calculateHeadingAndDistance(config.myPosition.lat, config.myPosition.lon, blitzData.lat, blitzData.lon);
  blitzBuffer.push({
    key: `${blitz.heading}|${(blitz.distance / 10) | 0}`,
    heading: blitz.heading,
    distance: blitz.distance,
    lat: blitzData.lat,
    lon: blitzData.lon
  });
}

async function sendAlert(message, channel) {
  await connection.sendChannelTextMessage(
    channel.channelIdx,
    utils.shortenToBytes(message, 155)
  );
  console.log(`Sent out [${channel.name}]: ${message}`);
  await utils.sleep(30 * 1000);
}

async function geoCodeCached(key, lat, lon) {
  if (geoCache[key]) return geoCache[key];
  const location = await utils.geoCode(lat, lon);
  if (location) geoCache[key] = location;
  return location;
}

async function blitzWarning() {
  const counter = {};

  for (const blitz of blitzBuffer) {
    counter[blitz.key] = (counter[blitz.key] || 0) + 1;
  }

  for (const key of Object.keys(counter)) {
    if (counter[key] < 10 || seen.blitz[key]) continue;
    const [heading, distance] = key.split('|');
    if (!(heading && distance)) continue;

    const data = blitzBuffer.find(b => b.key === key);
    if (!data) continue;

    const location = await geoCodeCached(key, data.lat, data.lon) || `${data.lat.toFixed(3)}, ${data.lon.toFixed(3)}`;
    await sendAlert(`🌩️ Lightning: ${location} (${parseInt(distance, 10) * 10}km ${config.compasNames[heading]})`, channels.alerts);
    seen.blitz[key] = Date.now();
  }

  blitzBuffer = [];
}

// Connect to the MeshCore serial connection
await connection.connect();
