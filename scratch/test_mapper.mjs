import { existsSync, readFileSync, unlinkSync } from 'fs';
import MapperModule from '../modules/mapper.mjs';

console.log("--------------------------------------------------");
console.log("       Starting Network Mapper Module Tests       ");
console.log("--------------------------------------------------");

async function startTest() {
  let failed = false;
  
  // Clean up any existing test output files first
  if (existsSync('topology.json')) unlinkSync('topology.json');
  if (existsSync('topology_nodes.csv')) unlinkSync('topology_nodes.csv');
  if (existsSync('topology_links.csv')) unlinkSync('topology_links.csv');
  if (existsSync('www/topology_nodes.csv')) unlinkSync('www/topology_nodes.csv');
  if (existsSync('www/topology_links.csv')) unlinkSync('www/topology_links.csv');
  if (existsSync('test_mesh_map.html')) unlinkSync('test_mesh_map.html');

  try {
    // 1. Mock connection getSelfInfo, getContacts, and getNeighbours
    const localPubKey = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const localPubKeyHex = "aabbccdd".padEnd(64, '0');
    const repeaterAPubKey = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const repeaterAPubKeyHex = "11223344".padEnd(64, '0');
    const repeaterBPubKey = new Uint8Array([0xbb, 0xbb, 0xbb, 0xbb]);
    const repeaterBPubKeyHex = "bbbbbbbb".padEnd(64, '0');

    const mockConnection = {
      getSelfInfo: async () => {
        return {
          publicKey: localPubKey,
          name: "Local Bot Node",
          advLat: 389072000, // 38.9072 * 1e7
          advLon: -770369000 // -77.0369 * 1e7
        };
      },
      getContacts: async () => {
        return [
          {
            publicKey: repeaterAPubKey,
            type: 2, // Repeater
            advName: "Repeater-A",
            advLat: 389220000,
            advLon: -770120000
          },
          {
            publicKey: repeaterBPubKey,
            type: 2, // Repeater
            advName: "Repeater-B",
            advLat: 389300000,
            advLon: -770100000
          },
          {
            publicKey: new Uint8Array([0x55, 0x66, 0x77, 0x88]),
            type: 1, // Chat Client
            advName: "Client-X",
            advLat: 389100000,
            advLon: -770200000
          }
        ];
      },
      getNeighbours: async (publicKeyBytes) => {
        const queryPubHex = Buffer.from(publicKeyBytes).toString('hex');
        
        if (queryPubHex.startsWith("aabbccdd")) {
          return {
            totalNeighboursCount: 1,
            neighbours: [
              {
                publicKeyPrefix: new Uint8Array([0x11, 0x22, 0x33, 0x44]), // prefix of Repeater-A
                heardSecondsAgo: 10,
                snr: 6.5
              }
            ]
          };
        } else if (queryPubHex.startsWith("11223344")) {
          // Repeater-A sees local node and Repeater-B prefix
          return {
            totalNeighboursCount: 2,
            neighbours: [
              {
                publicKeyPrefix: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), // prefix of local
                heardSecondsAgo: 20,
                snr: 8.0
              },
              {
                publicKeyPrefix: new Uint8Array([0xbb, 0xbb, 0xbb, 0xbb]), // prefix of Repeater-B
                heardSecondsAgo: 30,
                snr: 4.5
              }
            ]
          };
        } else if (queryPubHex.startsWith("bbbbbbbb")) {
          // Repeater-B sees Repeater-A and an unknown repeater prefix
          return {
            totalNeighboursCount: 2,
            neighbours: [
              {
                publicKeyPrefix: new Uint8Array([0x11, 0x22, 0x33, 0x44]), // prefix of Repeater-A
                heardSecondsAgo: 30,
                snr: 4.5
              },
              {
                publicKeyPrefix: new Uint8Array([0x99, 0x88, 0x77, 0x66]), // unknown node prefix
                heardSecondsAgo: 50,
                snr: -12.5
              }
            ]
          };
        }
        
        throw new Error("Node unreachable");
      }
    };

    const mockHost = {
      connection: mockConnection,
      VERSION: "1.1.0",
      utils: {
        sleep: async (ms) => {}
      }
    };

    const config = {
      localRepeater: "Repeater-A",
      intervalHours: 0.001, // run fast
      maxCycles: 2,
      mapHtmlPath: "test_mesh_map.html"
    };

    // 2. Initialize and run crawler manually
    const mapper = new MapperModule();
    mapper.host = mockHost;
    mapper.config = config;
    mapper.crawling = false;

    console.log("Triggering manual crawl execution...");
    await mapper.runCrawl();

    // 3. Verify topology.json database output
    if (existsSync('topology.json')) {
      console.log("  PASS: topology.json generated successfully.");
      const topologyData = JSON.parse(readFileSync('topology.json', 'utf8'));
      
      // We expect 5 nodes: local bot node, repeater A, repeater B, chat client X, and the unknown node prefix
      if (topologyData.nodes && topologyData.nodes.length === 5) {
        console.log("  PASS: Node database count is correct (5 discovered nodes).");
      } else {
        console.error(`  FAIL: Unexpected node database count. Discovered:`, topologyData.nodes);
        failed = true;
      }

      // We expect links: A -> local, A -> B, B -> A, B -> unknown
      if (topologyData.links && topologyData.links.length === 4) {
        console.log("  PASS: Neighbor links parsed correctly.");
      } else {
        console.error(`  FAIL: Link count is incorrect. Parsed:`, topologyData.links);
        failed = true;
      }

      // Verify CSV files
      if (existsSync('topology_nodes.csv')) {
        console.log("  PASS: topology_nodes.csv generated successfully.");
        const nodesContent = readFileSync('topology_nodes.csv', 'utf8');
        if (nodesContent.startsWith("publicKeyHex,name,type,lat,lon\n")) {
          console.log("  PASS: topology_nodes.csv header is correct.");
        } else {
          console.error("  FAIL: topology_nodes.csv header is incorrect:", nodesContent.slice(0, 50));
          failed = true;
        }
      } else {
        console.error("  FAIL: topology_nodes.csv was not created.");
        failed = true;
      }

      if (existsSync('topology_links.csv')) {
        console.log("  PASS: topology_links.csv generated successfully.");
        const linksContent = readFileSync('topology_links.csv', 'utf8');
        if (linksContent.startsWith("from,to,snr,heardSecondsAgo\n")) {
          console.log("  PASS: topology_links.csv header is correct.");
        } else {
          console.error("  FAIL: topology_links.csv header is incorrect:", linksContent.slice(0, 50));
          failed = true;
        }
      } else {
        console.error("  FAIL: topology_links.csv was not created.");
        failed = true;
      }

      // Verify www folder outputs
      if (existsSync('www/topology_nodes.csv')) {
        console.log("  PASS: www/topology_nodes.csv generated successfully.");
      } else {
        console.error("  FAIL: www/topology_nodes.csv was not created.");
        failed = true;
      }

      if (existsSync('www/topology_links.csv')) {
        console.log("  PASS: www/topology_links.csv generated successfully.");
      } else {
        console.error("  FAIL: www/topology_links.csv was not created.");
        failed = true;
      }
    } else {
      console.error("  FAIL: topology.json was not created.");
      failed = true;
    }

    // 4. Verify test_mesh_map.html map file output
    if (existsSync('test_mesh_map.html')) {
      console.log("  PASS: test_mesh_map.html map generated successfully.");
      const htmlContent = readFileSync('test_mesh_map.html', 'utf8');
      
      if (htmlContent.includes("L.map") && htmlContent.includes("L.tileLayer") && htmlContent.includes("topology = {")) {
        console.log("  PASS: Leaflet scripting and embedded JSON payload verified inside map HTML.");
      } else {
        console.error("  FAIL: Map HTML did not contain Leaflet scripting markers or embedded topology JSON.");
        failed = true;
      }
    } else {
      console.error("  FAIL: test_mesh_map.html map file was not created.");
      failed = true;
    }

  } catch (err) {
    console.error("  FAIL: Encountered crawler error:", err.message);
    failed = true;
  } finally {
    // 5. Clean up files
    console.log("Cleaning up test output files...");
    if (existsSync('topology.json')) unlinkSync('topology.json');
    if (existsSync('topology_nodes.csv')) unlinkSync('topology_nodes.csv');
    if (existsSync('topology_links.csv')) unlinkSync('topology_links.csv');
    if (existsSync('www/topology_nodes.csv')) unlinkSync('www/topology_nodes.csv');
    if (existsSync('www/topology_links.csv')) unlinkSync('www/topology_links.csv');
    if (existsSync('test_mesh_map.html')) unlinkSync('test_mesh_map.html');
    
    console.log("--------------------------------------------------");
    if (failed) {
      console.error("Network Mapper tests FAILED!");
      process.exit(1);
    } else {
      console.log("All Network Mapper tests PASSED successfully!");
      process.exit(0);
    }
  }
}

startTest().catch(err => {
  console.error("Test execution crash:", err);
  process.exit(1);
});
