import { Constants, NodeJSSerialConnection } from "@liamcottle/meshcore.js";
import { readFileSync } from 'fs';
import * as mqtt from 'mqtt';
import * as utils from './utils.mjs';

// Load config safely without ESM experimental warning
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)));

const port = process.argv[2] ?? config.port;

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

console.log(`Connecting to ${port}`);
const connection = new NodeJSSerialConnection(port);

connection.on('connected', async () => {
  console.log(`Connected to ${port}`);

  // Resolve ZIP code to GPS coordinates if provided
  if (config.zipCode && config.zipCode.toString().trim() !== "") {
    try {
      const zip = config.zipCode.toString().trim();
      console.log(`Resolving ZIP code "${zip}" to coordinates...`);
      const searchUrl = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json`;
      const searchRes = await fetch(searchUrl, {
        headers: {
          'User-Agent': config.userAgent || 'MeshCoreWeatherBot/1.0 (contact@example.com)'
        }
      });
      if (!searchRes.ok) throw new Error(`HTTP ${searchRes.status}`);
      const results = await searchRes.json();
      if (results && results.length > 0) {
        const lat = parseFloat(results[0].lat);
        const lon = parseFloat(results[0].lon);
        console.log(`Resolved ZIP code ${zip} to coordinates: ${lat}, ${lon}`);
        config.myPosition = { lat, lon };
      } else {
        console.warn(`Could not resolve coordinates for ZIP code ${zip}. Using manual coordinates from config.`);
      }
    } catch (err) {
      console.error(`Failed to geocode ZIP code ${config.zipCode}:`, err);
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

async function onContactMessageReceived(message) {
  console.log('Received contact message:', message);
}

async function onChannelMessageReceived(message) {
  console.log('Received channel message:', message);
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

    // Take the top 3 periods (e.g., Today, Tonight, Tomorrow)
    const selectedPeriods = periods.slice(0, 3);
    return selectedPeriods.map(p => `${p.name}: ${p.detailedForecast}`).join('\n');
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
