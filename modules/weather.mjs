import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as mqtt from 'mqtt';

const SUBS_FILE = './subscriptions.json';

export default class WeatherModule {
  static async configure(askQuestion, currentConfig) {
    const config = { ...currentConfig };
    
    const defaultZip = config.zipCode || "20001";
    const zip = await askQuestion(`Enter local US ZIP code [${defaultZip}]: `);
    config.zipCode = zip || defaultZip;

    const defaultAlarm = config.weatherAlarm || "06:00";
    const alarm = await askQuestion(`Enter daily forecast broadcast time (HH:MM) [${defaultAlarm}]: `);
    config.weatherAlarm = alarm || defaultAlarm;

    // Extract email from User-Agent if possible
    let defaultEmail = "contact@example.com";
    if (config.userAgent) {
      const emailMatch = config.userAgent.match(/\(([^)]+)\)/);
      if (emailMatch) defaultEmail = emailMatch[1];
    }
    const email = await askQuestion(`Enter email address (required for NWS API User-Agent) [${defaultEmail}]: `);
    const selectedEmail = email || defaultEmail;
    config.userAgent = `MeshBot/1.1.0 (${selectedEmail})`;

    const defaultAlertsEnabled = config.meteoAlerts && config.meteoAlerts.enabled !== undefined ? (config.meteoAlerts.enabled ? "y" : "n") : "y";
    const alertsInput = await askQuestion(`Enable National Weather Service active alerts broadcast? (y/n) [${defaultAlertsEnabled}]: `);
    const alertsEnabled = (alertsInput ? alertsInput.toLowerCase().startsWith('y') : defaultAlertsEnabled === "y");
    
    if (!config.meteoAlerts) {
      config.meteoAlerts = {
        enabled: true,
        timeout: 180,
        severityFilter: ["severe", "extreme"],
        certaintyFilter: ["observed", "likely"],
        messageTemplate: "{event} Alert for {region}\nEffective: {start} to {end}\nSeverity: {severity}\n{headline}",
        severity: {
          unknown: "Unknown",
          minor: "Minor",
          moderate: "Moderate",
          severe: "Severe",
          extreme: "Extreme"
        },
        certainty: {
          observed: "Observed",
          likely: "Likely",
          possible: "Possible",
          unlikely: "Unlikely",
          unknown: "Unknown"
        }
      };
    }
    config.meteoAlerts.enabled = alertsEnabled;

    return config;
  }

  async init(host, config) {
    this.host = host;
    this.config = config;
    this.utils = host.utils;
    
    this.resolvedLocationName = '';
    this.cachedForecastUrl = null;
    this.blitzBuffer = [];
    this.seen = {
      alerts: {},
      blitz: {}
    };
    this.geoCache = {};
    this.meteoAlerts = {};

    // 1. Resolve ZIP code to GPS coordinates if provided
    if (this.config.zipCode && this.config.zipCode.toString().trim() !== "") {
      try {
        const zip = this.config.zipCode.toString().trim();
        console.log(`[Weather] Resolving ZIP code "${zip}" to coordinates...`);
        const result = await this.resolveZip(zip);
        console.log(`[Weather] Resolved ZIP code ${zip} to coordinates: ${result.lat}, ${result.lon} (${result.displayName})`);
        this.resolvedLocationName = result.displayName;
        this.config.myPosition = { lat: result.lat, lon: result.lon };
      } catch (err) {
        console.error(`[Weather] Failed to geocode ZIP code ${this.config.zipCode}:`, err.message);
        console.warn('[Weather] Falling back to manual coordinates from config.');
      }
    }

    // 2. Calculate dynamic blitzArea bounding box if myPosition and blitzRadiusMiles are configured
    if (this.config.myPosition && this.config.blitzRadiusMiles) {
      const lat = this.config.myPosition.lat;
      const lon = this.config.myPosition.lon;
      const radiusMiles = this.config.blitzRadiusMiles;
      const latDegreeOffset = radiusMiles / 69;
      const lonDegreeOffset = radiusMiles / (69 * Math.cos(lat * Math.PI / 180));
      
      this.config.blitzArea = {
        minLat: lat - latDegreeOffset,
        maxLat: lat + latDegreeOffset,
        minLon: lon - lonDegreeOffset,
        maxLon: lon + lonDegreeOffset
      };
      console.log(`[Weather] Calculated lightning bounding box (${radiusMiles} miles range around ${lat.toFixed(4)}, ${lon.toFixed(4)}):`, this.config.blitzArea);
    }

    // 3. Resolve NWS metadata and timezone
    let timeZone = 'UTC';
    if (this.config.myPosition) {
      try {
        const pointsUrl = `https://api.weather.gov/points/${this.config.myPosition.lat},${this.config.myPosition.lon}`;
        console.log(`[Weather] Resolving NWS metadata and timezone for position...`);
        const pointsData = await this.fetchNWS(pointsUrl);
        this.cachedForecastUrl = pointsData.properties.forecast;
        timeZone = pointsData.properties.timeZone || 'UTC';
        console.log(`[Weather] Resolved local timezone: ${timeZone}`);
      } catch (err) {
        console.error('[Weather] Failed to resolve NWS metadata or timezone at startup:', err.message);
      }
    }

    // 4. Register Blitzortung lightning listener
    if (this.config.blitzArea) {
      await this.registerBlitzortungMqtt((blitzData) => this.blitzHandler(blitzData), this.config.blitzArea);
    }

    // 5. Daily weather forecast alarm
    this.utils.setAlarm(this.config.weatherAlarm, () => this.sendWeather(), timeZone);

    // 6. Lightning check interval
    if (this.config.timers && this.config.timers.blitzCollection) {
      setInterval(() => this.blitzWarning(), this.config.timers.blitzCollection);
    }

    // 7. NWS Active Alerts check interval
    if (this.config.meteoAlerts && this.config.meteoAlerts.enabled) {
      setInterval(() => this.checkMeteoAlerts(), this.config.timers.meteoAlerts);
      this.checkMeteoAlerts();
    }

    console.log('[Weather] Module initialized.');
  }

  // Database helper methods
  readSubscriptions() {
    if (!existsSync(SUBS_FILE)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(SUBS_FILE, 'utf-8'));
    } catch (err) {
      console.error('Error reading subscriptions.json:', err);
      return {};
    }
  }

  writeSubscriptions(subs) {
    try {
      writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error writing subscriptions.json:', err);
    }
  }

  async addSubscription(publicKey, zipCode, displayName, lat, lon, forecastUrl) {
    const subs = this.readSubscriptions();
    const key = Buffer.from(publicKey).toString('hex');
    subs[key] = {
      publicKeyHex: key,
      zipCode,
      displayName,
      lat,
      lon,
      forecastUrl,
      subscribedAt: Date.now()
    };
    this.writeSubscriptions(subs);
  }

  async removeSubscription(publicKey) {
    const subs = this.readSubscriptions();
    const key = Buffer.from(publicKey).toString('hex');
    if (subs[key]) {
      delete subs[key];
      this.writeSubscriptions(subs);
      return true;
    }
    return false;
  }

  // Helper for fetching NWS API endpoints
  async fetchNWS(url) {
    const userAgent = this.config.userAgent || `MeshBot/${this.host.VERSION} (contact@example.com)`;
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
  async resolveZip(zip) {
    // Try zippopotam.us first
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
        'User-Agent': this.config.userAgent || `MeshBot/${this.host.VERSION} (contact@example.com)`
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

  async checkMeteoAlerts() {
    const timeoutMs = this.config.meteoAlerts.timeout * 60 * 1000;
    Object.keys(this.meteoAlerts).forEach(key => {
      const entry = this.meteoAlerts[key];
      const timestamp = typeof entry === 'object' ? entry.timestamp : entry;
      if (timestamp < Date.now() - timeoutMs) {
        delete this.meteoAlerts[key];
      }
    });

    try {
      const url = `https://api.weather.gov/alerts/active?point=${this.config.myPosition.lat},${this.config.myPosition.lon}`;
      const data = await this.fetchNWS(url);

      if (!data.features) {
        return;
      }

      const activeIds = new Set();
      const warnings = [];
      for (const feature of data.features) {
        const props = feature.properties;
        if (!props) continue;

        const id = props.identifier || feature.id;
        if (id) activeIds.add(id);

        const endTime = props.expires ? new Date(props.expires) : (props.ends ? new Date(props.ends) : null);
        if (endTime && endTime < Date.now()) {
          continue;
        }

        const severity = (props.severity || 'unknown').toLowerCase();
        const certainty = (props.certainty || 'unknown').toLowerCase();

        if (!this.config.meteoAlerts.severityFilter.includes(severity) ||
            !this.config.meteoAlerts.certaintyFilter.includes(certainty)) {
          continue;
        }

        if (this.meteoAlerts[id]) {
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
          const message = this.interpolate(this.config.meteoAlerts.messageTemplate, {
            region: item.region,
            start: this.utils.formatDate(item.start),
            end: this.utils.formatDate(item.end),
            event: item.event,
            severity: this.config.meteoAlerts.severity[item.severity] || item.severity,
            certainty: this.config.meteoAlerts.certainty[item.certainty] || item.certainty,
            headline: item.headline,
            instruction: item.instruction
          });

          await this.sendAlert(message, this.host.channels.alerts);
          this.meteoAlerts[item.id] = {
            timestamp: Date.now(),
            event: item.event,
            region: item.region,
            cleared: false
          };
          await this.utils.sleep(30 * 1000);
        }
      }

      // Detect and send cleared warnings
      for (const id of Object.keys(this.meteoAlerts)) {
        const cached = this.meteoAlerts[id];
        if (activeIds.has(id)) continue;

        const isAlreadyCleared = typeof cached === 'object' ? cached.cleared : false;
        if (isAlreadyCleared) continue;

        const event = typeof cached === 'object' ? cached.event : 'Weather Alert';
        const region = typeof cached === 'object' ? cached.region : 'Area';

        const clearMessage = `🟢 CLEAR: ${event} has ended/been cleared for ${region}.`;
        await this.sendAlert(clearMessage, this.host.channels.alerts);

        if (typeof cached === 'object') {
          cached.cleared = true;
          cached.timestamp = Date.now();
        } else {
          this.meteoAlerts[id] = {
            timestamp: Date.now(),
            event,
            region,
            cleared: true
          };
        }
        await this.utils.sleep(30 * 1000);
      }
    } catch (err) {
      console.error('Failed to check meteo alerts:', err);
    }
  }

  interpolate(str, data) {
    return str.replace(/\{([^}]+)\}/g, (_, key) => {
      return data[key] ?? "";
    });
  }

  // Maps weather descriptors to emojis
  getEmojiForForecast(forecastText) {
    const text = (forecastText || '').toLowerCase();
    if (text.includes('thunder') || text.includes('storm')) return '⛈️';
    if (text.includes('snow') || text.includes('ice') || text.includes('sleet') || text.includes('freeze') || text.includes('flurry')) return '❄️';
    if (text.includes('rain') || text.includes('shower') || text.includes('drizzle')) return '🌧️';
    if (text.includes('fog') || text.includes('mist') || text.includes('haze')) return '🌫️';
    if (text.includes('wind') || text.includes('breezy') || text.includes('windy')) return '💨';
    if (text.includes('mostly sunny') || text.includes('partly sunny') || text.includes('mostly clear') || text.includes('partly cloudy')) return '🌤';
    if (text.includes('sunny') || text.includes('clear')) return '☀️';
    if (text.includes('cloud') || text.includes('overcast') || text.includes('gloomy')) return '☁️';
    return '⛅';
  }

  // Formats NWS forecast periods to a compressed string (today + next 2 days)
  formatCompressedForecast(zip, periods) {
    const groups = new Map();
    for (const p of periods) {
      const dateStr = p.startTime.slice(0, 10);
      if (!groups.has(dateStr)) {
        groups.set(dateStr, {
          dateStr,
          daytime: null,
          nighttime: null
        });
      }
      const group = groups.get(dateStr);
      if (p.isDaytime) {
        group.daytime = p;
      } else {
        group.nighttime = p;
      }
    }

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
      const emoji = this.getEmojiForForecast(forecastText);

      const parts = [];
      if (group.daytime) parts.push(`hi: ${group.daytime.temperature}`);
      if (group.nighttime) parts.push(`low: ${group.nighttime.temperature}`);

      return `${label}: ${emoji} ${parts.join(' ')}`;
    });

    return header + lines.join('\n');
  }

  async handleMessage(cleanText, replyCallback, contact = null, info = {}) {
    // If it's a channel message (contact is null), check if it's on the weather channel
    if (!contact) {
      const weatherIdx = this.host.channels.weather?.channelIdx;
      if (weatherIdx === undefined || info.channelIdx !== weatherIdx) {
        console.log(`[Weather] Ignored channel message on index ${info.channelIdx} (weather channel index is ${weatherIdx})`);
        return; // Ignore channel messages not on the weather channel
      }
    }

    const lowerText = cleanText.toLowerCase();

    // 1. Handle Subscription Commands
    if (lowerText.startsWith('subscribe')) {
      if (!contact) {
        await replyCallback('Error: Subscriptions must be requested via direct message.');
        return;
      }
      const match = cleanText.match(/^subscribe\s+(\d{5})$/i);
      if (!match) {
        await replyCallback('Usage: subscribe [5-digit zip code]');
        return;
      }
      const zip = match[1];
      try {
        const result = await this.resolveZip(zip);
        
        const pointsUrl = `https://api.weather.gov/points/${result.lat},${result.lon}`;
        const pointsData = await this.fetchNWS(pointsUrl);
        const forecastUrl = pointsData.properties.forecast;

        await this.addSubscription(contact.publicKey, zip, result.displayName, result.lat, result.lon, forecastUrl);
        await replyCallback(`Subscribed! You will receive daily forecasts for ${result.displayName} (${zip}) every day at ${this.config.weatherAlarm} local time.`);
      } catch (err) {
        console.error(`Subscription failed for ZIP ${zip}:`, err.message);
        await replyCallback(`Error: Could not resolve ZIP code ${zip}. Subscription failed.`);
      }
      return;
    }

    if (lowerText === 'unsubscribe') {
      if (!contact) {
        await replyCallback('Error: Subscriptions must be managed via direct message.');
        return;
      }
      const removed = await this.removeSubscription(contact.publicKey);
      if (removed) {
        await replyCallback('Unsubscribed. You will no longer receive daily forecasts.');
      } else {
        await replyCallback('You do not have an active subscription.');
      }
      return;
    }

    // 2. Handle standard weather/wx zip code queries
    let zip = null;
    if (/^\d{5}$/.test(cleanText)) {
      zip = cleanText;
    } else {
      const match = cleanText.match(/^[!/#]?(weather|wx)\s+(\d{5})$/i);
      if (match) {
        zip = match[2];
      }
    }

    if (!zip) return; // Not a weather request

    console.log(`Processing interactive weather request for ZIP: ${zip}`);
    try {
      const result = await this.resolveZip(zip);
      
      const pointsUrl = `https://api.weather.gov/points/${result.lat},${result.lon}`;
      const pointsData = await this.fetchNWS(pointsUrl);
      const forecastUrl = pointsData.properties.forecast;

      const forecastData = await this.fetchNWS(forecastUrl);
      const periods = forecastData.properties.periods;

      if (!periods || periods.length === 0) {
        await replyCallback(`Error: No forecast data found for ZIP ${zip}`);
        return;
      }

      const forecastText = this.formatCompressedForecast(zip, periods);
      const chunks = this.utils.splitStringToByteChunks(forecastText, 130);
      for (const chunk of chunks) {
        await replyCallback(chunk);
        await this.utils.sleep(5000);
      }
    } catch (err) {
      console.error(`Failed to handle weather request for ${zip}:`, err);
      await replyCallback(`Error fetching weather for ZIP ${zip}. Please try again later.`);
    }
  }

  async sendSubscriberForecast(publicKey, sub) {
    try {
      console.log(`Sending daily forecast to subscriber ${sub.displayName} (${sub.zipCode})...`);
      
      let forecastUrl = sub.forecastUrl;
      if (!forecastUrl) {
        const pointsUrl = `https://api.weather.gov/points/${sub.lat},${sub.lon}`;
        const pointsData = await this.fetchNWS(pointsUrl);
        forecastUrl = pointsData.properties.forecast;
      }

      const forecastData = await this.fetchNWS(forecastUrl);
      const periods = forecastData.properties.periods;
      if (!periods || periods.length === 0) {
        console.warn(`No forecast periods available for subscriber ${sub.zipCode}`);
        return;
      }

      const firstPeriod = periods[0];
      const synopsis = `${firstPeriod.name}: ${firstPeriod.detailedForecast}`;
      const synopsisMsg = this.utils.shortenToBytes(synopsis, 145);

      const forecastText = this.formatCompressedForecast(sub.zipCode, periods);

      await this.host.sendDM(publicKey, synopsisMsg);
      await this.utils.sleep(5000);
      await this.host.sendDM(publicKey, forecastText);
      
      console.log(`Successfully sent subscriber forecast to ${sub.displayName}`);
    } catch (err) {
      console.error(`Failed to send subscriber forecast to ${sub.zipCode}:`, err.message);
    }
  }

  async sendWeather() {
    console.log('Starting scheduled daily weather broadcast...');
    // 1. Send channel forecast
    try {
      const weatherText = await this.getWeather();
      const chunks = this.utils.splitStringToByteChunks(weatherText, 130);
      if (chunks.length > 0) {
        for (const message of chunks) {
          await this.sendAlert(message, this.host.channels.weather);
        }
      }
    } catch (err) {
      console.error('Failed to send main weather broadcast:', err.message);
    }

    // 2. Send subscriber forecasts
    const subs = this.readSubscriptions();
    const subKeys = Object.keys(subs);
    if (subKeys.length > 0) {
      console.log(`Processing ${subKeys.length} subscriber weather forecasts...`);
      for (const key of subKeys) {
        const sub = subs[key];
        const subPublicKey = Buffer.from(sub.publicKeyHex, 'hex');
        await this.sendSubscriberForecast(subPublicKey, sub);
        await this.utils.sleep(10000);
      }
    }
  }

  async getWeather() {
    try {
      if (!this.cachedForecastUrl) {
        const url = `https://api.weather.gov/points/${this.config.myPosition.lat},${this.config.myPosition.lon}`;
        console.log(`Retrieving grid forecast URL for ${this.config.myPosition.lat}, ${this.config.myPosition.lon}`);
        const pointsData = await this.fetchNWS(url);
        this.cachedForecastUrl = pointsData.properties.forecast;
      }

      const forecastData = await this.fetchNWS(this.cachedForecastUrl);
      const periods = forecastData.properties.periods;
      if (!periods || periods.length === 0) {
        return 'No forecast periods available.';
      }

      return this.formatCompressedForecast(this.config.zipCode, periods);
    } catch (err) {
      console.error('Failed to get NWS forecast:', err);
      return `Weather Forecast Unavailable: ${err.message}`;
    }
  }

  async registerBlitzortungMqtt(blitzCallback, blitzArea) {
    console.log(`Connecting to Blitzortung MQTT broker...`);
    const client = await mqtt.connectAsync('mqtt://blitzortung.ha.sed.pl:1883');
    const decoder = new TextDecoder();

    client.on('message', (_, data) => {
      try {
        const json = decoder.decode(data);
        const rawData = JSON.parse(json);
        const lat = parseFloat(rawData.lat);
        const lon = parseFloat(rawData.lon);

        if (isNaN(lat) || isNaN(lon)) return;

        if (lat < blitzArea.minLat || lon < blitzArea.minLon ||
          lat > blitzArea.maxLat || lon > blitzArea.maxLon) {
          return;
        }

        blitzCallback({ ...rawData, lat, lon });
      } catch (err) {
        console.error('Error processing Blitzortung message:', err);
      }
    });

    await client.subscribeAsync('blitzortung/1.1/#');
    console.log('Subscribed to Blitzortung lightning notifications.');
  }

  blitzHandler(blitzData) {
    const blitz = this.utils.calculateHeadingAndDistance(this.config.myPosition.lat, this.config.myPosition.lon, blitzData.lat, blitzData.lon);
    this.blitzBuffer.push({
      key: `${blitz.heading}|${(blitz.distance / 10) | 0}`,
      heading: blitz.heading,
      distance: blitz.distance,
      lat: blitzData.lat,
      lon: blitzData.lon
    });
  }

  async sendAlert(message, channel) {
    await this.host.sendChannelMessage(
      channel.channelIdx,
      this.utils.shortenToBytes(message, 155)
    );
    console.log(`Sent out [${channel.name}]: ${message}`);
    await this.utils.sleep(30 * 1000);
  }

  async geoCodeCached(key, lat, lon) {
    if (this.geoCache[key]) return this.geoCache[key];
    const location = await this.utils.geoCode(lat, lon);
    if (location) this.geoCache[key] = location;
    return location;
  }

  async blitzWarning() {
    const counter = {};

    for (const blitz of this.blitzBuffer) {
      counter[blitz.key] = (counter[blitz.key] || 0) + 1;
    }

    for (const key of Object.keys(counter)) {
      if (counter[key] < 10 || this.seen.blitz[key]) continue;
      const [heading, distance] = key.split('|');
      if (!(heading && distance)) continue;

      const data = this.blitzBuffer.find(b => b.key === key);
      if (!data) continue;

      const location = await this.geoCodeCached(key, data.lat, data.lon) || `${data.lat.toFixed(3)}, ${data.lon.toFixed(3)}`;
      await this.sendAlert(`🌩️ Lightning: ${location} (${parseInt(distance, 10) * 10}km ${this.config.compasNames[heading]})`, this.host.channels.alerts);
      this.seen.blitz[key] = Date.now();
    }

    this.blitzBuffer = [];
  }
}
