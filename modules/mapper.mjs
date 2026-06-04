import { writeFileSync, existsSync } from 'fs';
import BufferWriter from '../node_modules/@liamcottle/meshcore.js/src/buffer_writer.js';
import BufferReader from '../node_modules/@liamcottle/meshcore.js/src/buffer_reader.js';
import Constants from '../node_modules/@liamcottle/meshcore.js/src/constants.js';
import RandomUtils from '../node_modules/@liamcottle/meshcore.js/src/random_utils.js';

export default class MapperModule {
  static async configure(askQuestion, currentConfig) {
    const config = { ...currentConfig };

    const defaultInterval = config.intervalHours || 2;
    const interval = await askQuestion(`Enter network mapping crawl interval in hours [${defaultInterval}]: `);
    config.intervalHours = parseFloat(interval) || defaultInterval;

    const defaultCycles = config.maxCycles || 5;
    const cycles = await askQuestion(`Enter maximum crawl attempt cycles [${defaultCycles}]: `);
    config.maxCycles = parseInt(cycles, 10) || defaultCycles;

    const defaultHtml = config.mapHtmlPath || "mesh_map.html";
    const htmlPath = await askQuestion(`Enter output Leaflet HTML map file path [${defaultHtml}]: `);
    config.mapHtmlPath = htmlPath || defaultHtml;

    return config;
  }

  async init(host, config) {
    this.host = host;
    this.config = config;
    this.crawling = false;

    console.log("[Mapper] Network Crawler Module initialized.");

    // Start crawling after a short delay (e.g. 15 seconds) so connection is established
    const startupDelay = 15000;
    setTimeout(() => {
      this.runCrawl().catch(err => {
        console.error("[Mapper] Crawler error:", err.message);
      });
    }, startupDelay);

    // Schedule subsequent crawls
    const intervalMs = (this.config.intervalHours || 2) * 60 * 60 * 1000;
    setInterval(() => {
      this.runCrawl().catch(err => {
        console.error("[Mapper] Scheduled crawler error:", err.message);
      });
    }, intervalMs);
  }

  async runCrawl() {
    if (this.crawling) {
      console.warn("[Mapper] Crawl already in progress. Skipping.");
      return;
    }
    this.crawling = true;
    console.log("[Mapper] Starting network topology crawl...");

    try {
      const nodesMap = new Map(); // publicKeyHex -> nodeData
      const links = [];

      // 1. Get local node info
      let localNode = {
        name: "Local Bot Node",
        publicKeyHex: "unknown",
        lat: 0,
        lon: 0,
        type: "local"
      };

      try {
        const selfInfo = await this.host.connection.getSelfInfo(8000);
        if (selfInfo) {
          const pubHex = Buffer.from(selfInfo.publicKey).toString('hex');
          localNode.publicKeyHex = pubHex;
          localNode.name = selfInfo.name || "Local Bot Node";
          if (selfInfo.advLat && selfInfo.advLon) {
            localNode.lat = selfInfo.advLat / 1e7;
            localNode.lon = selfInfo.advLon / 1e7;
          }
          nodesMap.set(pubHex, localNode);
        }
      } catch (err) {
        console.warn("[Mapper] Failed to fetch local node info:", err?.message || err || "unknown error");
      }

      // 2. Fetch all contacts from node to discover repeaters
      console.log("[Mapper] Querying contacts database...");
      let contacts = [];
      try {
        contacts = await this.host.connection.getContacts();
        console.log(`[Mapper] Discovered ${contacts.length} contacts.`);
      } catch (err) {
        console.warn("[Mapper] Failed to query contacts:", err?.message || err || "unknown error");
      }

      for (const contact of contacts) {
        const pubHex = Buffer.from(contact.publicKey).toString('hex');
        
        let typeStr = "client";
        if (contact.type === 2) typeStr = "repeater";
        else if (contact.type === 3) typeStr = "room";

        let latVal = 0;
        let lonVal = 0;
        if (contact.advLat && contact.advLon) {
          latVal = contact.advLat / 1e7;
          lonVal = contact.advLon / 1e7;
        }

        // Add or update node
        nodesMap.set(pubHex, {
          name: contact.advName || `Node-${pubHex.slice(0, 6)}`,
          publicKeyHex: pubHex,
          lat: latVal,
          lon: lonVal,
          type: typeStr
        });
      }

      // 3. For each repeater, fetch neighbor list in spread-out cycles
      const maxCycles = this.config.maxCycles || 5;
      const successNeighbours = {}; // publicKeyHex -> neighbours array
      
      const repeaters = [];
      for (const [pubHex, node] of nodesMap.entries()) {
        if (node.type === "repeater") {
          repeaters.push({ pubHex, node });
        }
      }

      for (let cycle = 1; cycle <= maxCycles; cycle++) {
        const remaining = repeaters.filter(r => !successNeighbours[r.pubHex]);
        if (remaining.length === 0) break;

        if (cycle > 1) {
          console.log(`[Mapper] Waiting 90s before start of attempt cycle ${cycle}/${maxCycles}...`);
          await this.host.utils.sleep(90000);
        }

        console.log(`[Mapper] Starting crawl cycle ${cycle}/${maxCycles} for ${remaining.length} repeaters...`);

        for (let i = 0; i < remaining.length; i++) {
          const { pubHex, node } = remaining[i];

          if (i > 0) {
            console.log(`[Mapper] Waiting 30s before querying ${node.name}...`);
            await this.host.utils.sleep(30000);
          }

          console.log(`[Mapper] Querying neighbor table for ${node.name} (${pubHex.slice(0, 8)})...`);
          try {
            const pKeyBytes = Buffer.from(pubHex, 'hex');
            const res = await this.host.connection.getNeighbours(pKeyBytes);
            if (res && res.neighbours) {
              console.log(`[Mapper] Successfully retrieved ${res.neighbours.length} neighbors for ${node.name}.`);
              successNeighbours[pubHex] = res.neighbours;
            } else {
              console.warn(`[Mapper] Empty neighbor table returned for ${node.name}.`);
            }
          } catch (err) {
            console.warn(`[Mapper] Query failed for ${node.name}: ${err?.message || err || "unknown error"}`);
          }
        }
      }

      // Compile links from successfully fetched neighbor lists
      for (const [pubHex, neighbours] of Object.entries(successNeighbours)) {
        for (const neigh of neighbours) {
          const neighPrefixHex = Buffer.from(neigh.publicKeyPrefix).toString('hex');
          links.push({
            from: pubHex,
            toPrefix: neighPrefixHex,
            snr: neigh.snr,
            heardSecondsAgo: neigh.heardSecondsAgo
          });
        }
      }

      // Log stats of crawl completion
      const failedCount = repeaters.filter(r => !successNeighbours[r.pubHex]).length;
      console.log(`[Mapper] Crawl finished. Discovered ${repeaters.length} repeaters, successfully queried ${Object.keys(successNeighbours).length}, failed ${failedCount}.`);

      // 4. Resolve 8-byte neighbor prefixes to 32-byte full public keys
      const resolvedLinks = [];
      const nodeKeys = Array.from(nodesMap.keys());

      for (const link of links) {
        const matchedKey = nodeKeys.find(k => k.startsWith(link.toPrefix));
        if (matchedKey) {
          resolvedLinks.push({
            from: link.from,
            to: matchedKey,
            snr: link.snr,
            heardSecondsAgo: link.heardSecondsAgo
          });
        } else {
          const dummyKey = link.toPrefix.padEnd(64, '0');
          if (!nodesMap.has(dummyKey)) {
            nodesMap.set(dummyKey, {
              name: `Unknown-${link.toPrefix}`,
              publicKeyHex: dummyKey,
              lat: 0,
              lon: 0,
              type: "unknown"
            });
          }
          resolvedLinks.push({
            from: link.from,
            to: dummyKey,
            snr: link.snr,
            heardSecondsAgo: link.heardSecondsAgo
          });
        }
      }

      const finalNodes = Array.from(nodesMap.values());

      // 5. Output JSON database
      const dbPayload = {
        generatedAt: new Date().toISOString(),
        nodes: finalNodes,
        links: resolvedLinks
      };

      writeFileSync('topology.json', JSON.stringify(dbPayload, null, 2), 'utf8');
      console.log("[Mapper] Saved topology data to topology.json");

      // 6. Generate Leaflet HTML map
      const htmlPath = this.config.mapHtmlPath || "mesh_map.html";
      const htmlContent = generateLeafletHtml(dbPayload);
      writeFileSync(htmlPath, htmlContent, 'utf8');
      console.log(`[Mapper] Generated interactive map: ${htmlPath}`);

    } catch (err) {
      console.error("[Mapper] Fatal crawl exception:", err?.message || err || "unknown error");
    } finally {
      this.crawling = false;
    }
  }
}

function generateLeafletHtml(data) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>MeshCore Network Topology Map</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #121212;
      color: #e0e0e0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    }
    #map {
      height: 100vh;
      width: 100vw;
    }
    .leaflet-popup-content-wrapper, .leaflet-popup-tip {
      background: #1e1e1e !important;
      color: #e0e0e0 !important;
      border: 1px solid #333;
    }
    .node-label {
      font-weight: bold;
      color: #3498db;
    }
    .legend {
      background: rgba(30, 30, 30, 0.9);
      padding: 10px;
      line-height: 1.5;
      border-radius: 5px;
      border: 1px solid #333;
      color: #e0e0e0;
    }
    .legend i {
      width: 18px;
      height: 18px;
      float: left;
      margin-right: 8px;
      opacity: 0.8;
      border-radius: 3px;
    }
    .timestamp {
      position: absolute;
      bottom: 20px;
      left: 20px;
      background: rgba(0, 0, 0, 0.7);
      padding: 8px 12px;
      border-radius: 4px;
      z-index: 1000;
      font-size: 12px;
    }
  </style>
</head>
<body>

  <div id="map"></div>
  <div class="timestamp">Last Crawl: ${data.generatedAt}</div>

  <script>
    const topology = ${JSON.stringify(data)};

    let center = [38.9072, -77.0369];
    const validNodes = topology.nodes.filter(n => n.lat && n.lon);
    
    if (validNodes.length > 0) {
      const sumLat = validNodes.reduce((s, n) => s + n.lat, 0);
      const sumLon = validNodes.reduce((s, n) => s + n.lon, 0);
      center = [sumLat / validNodes.length, sumLon / validNodes.length];
    }

    const map = L.map('map').setView(center, 12);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);

    const markers = {};

    function getNodeColor(type) {
      if (type === 'local') return '#2ecc71';
      if (type === 'repeater') return '#3498db';
      if (type === 'room') return '#9b59b6';
      if (type === 'unknown') return '#95a5a6';
      return '#e67e22';
    }

    topology.nodes.forEach(node => {
      if (node.lat && node.lon) {
        const marker = L.circleMarker([node.lat, node.lon], {
          radius: node.type === 'local' ? 10 : 8,
          fillColor: getNodeColor(node.type),
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.8
        }).addTo(map);

        marker.bindPopup(\`
          <div>
            <div class="node-label">\${node.name}</div>
            <div style="font-size: 11px; color: #888;">ID: \${node.publicKeyHex.slice(0, 16)}...</div>
            <div style="margin-top: 5px;">Type: <b>\${node.type.toUpperCase()}</b></div>
            <div>Pos: \${node.lat.toFixed(5)}, \${node.lon.toFixed(5)}</div>
          </div>
        \`);

        markers[node.publicKeyHex] = marker;
      }
    });

    function getLinkColor(snr) {
      if (snr >= 5) return '#2ecc71';
      if (snr >= 0) return '#3498db';
      if (snr >= -5) return '#f39c12';
      return '#e74c3c';
    }

    topology.links.forEach(link => {
      const fromNode = topology.nodes.find(n => n.publicKeyHex === link.from);
      const toNode = topology.nodes.find(n => n.publicKeyHex === link.to);

      if (fromNode && toNode && fromNode.lat && fromNode.lon && toNode.lat && toNode.lon) {
        const color = getLinkColor(link.snr);
        const polyline = L.polyline([[fromNode.lat, fromNode.lon], [toNode.lat, toNode.lon]], {
          color: color,
          weight: 3,
          opacity: 0.7,
          dashArray: '5, 5'
        }).addTo(map);

        polyline.bindTooltip(\`Link: \${fromNode.name} ➔ \${toNode.name}<br><b>SNR: \${link.snr} dB</b><br>Heard: \${Math.round(link.heardSecondsAgo / 60)} min ago\`, {
          sticky: true
        });
      }
    });

    const legend = L.control({ position: 'topright' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'legend');
      div.innerHTML += '<b>Link Quality (SNR)</b><br>';
      div.innerHTML += '<i style="background: #2ecc71"></i> &ge; 5 dB (Excellent)<br>';
      div.innerHTML += '<i style="background: #3498db"></i> 0 to 5 dB (Good)<br>';
      div.innerHTML += '<i style="background: #f39c12"></i> -5 to 0 dB (Weak)<br>';
      div.innerHTML += '<i style="background: #e74c3c"></i> &lt; -5 dB (Poor)<br>';
      return div;
    };
    legend.addTo(map);

  </script>
</body>
</html>`;
}
