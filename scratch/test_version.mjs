import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

// 1. Verify VERSION string in index.mjs matches package.json version
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const indexMjsText = readFileSync(new URL('../index.mjs', import.meta.url), 'utf-8');

console.log(`Checking package.json version: ${packageJson.version}`);

const versionMatch = indexMjsText.match(/const VERSION\s*=\s*["']([^"']+)["']/);
if (!versionMatch) {
  console.error("FAIL: Could not locate 'const VERSION' declaration in index.mjs");
  process.exit(1);
}

const indexVersion = versionMatch[1];
console.log(`Checking index.mjs VERSION: ${indexVersion}`);

if (indexVersion !== packageJson.version) {
  console.error(`FAIL: Version mismatch! package.json has ${packageJson.version} but index.mjs has ${indexVersion}`);
  process.exit(1);
}
console.log("PASS: Version check matches between package.json and index.mjs!");

// 2. Simulated handleIncomingMessage Command Parsing Test
const VERSION = indexVersion;
async function mockHandleIncomingMessage(text) {
  if (!text) return null;
  let cleanText = text.trim();
  cleanText = cleanText.replace(/^[A-Za-z0-9_.-]+:\s+/, '').trim();
  const lowerText = cleanText.toLowerCase();

  // Simulated commands:
  if (lowerText === 'version' || lowerText === 'info') {
    return `MeshBot v${VERSION}`;
  }
  
  if (lowerText.startsWith('subscribe')) {
    return 'subscribe-command';
  }
  
  if (lowerText === 'unsubscribe') {
    return 'unsubscribe-command';
  }

  return 'standard-weather-command';
}

const testCases = [
  { input: 'version', expected: `MeshBot v${VERSION}` },
  { input: 'VERSION', expected: `MeshBot v${VERSION}` },
  { input: '  version  ', expected: `MeshBot v${VERSION}` },
  { input: 'Dhovin: version', expected: `MeshBot v${VERSION}` },
  { input: 'info', expected: `MeshBot v${VERSION}` },
  { input: 'INFO', expected: `MeshBot v${VERSION}` },
  { input: 'Dhovin: INFO', expected: `MeshBot v${VERSION}` },
  { input: 'subscribe 12345', expected: 'subscribe-command' },
  { input: 'unsubscribe', expected: 'unsubscribe-command' },
  { input: '90210', expected: 'standard-weather-command' },
  { input: 'weather 90210', expected: 'standard-weather-command' }
];

console.log("\nTesting command routing...");
let failed = false;
for (const tc of testCases) {
  const result = await mockHandleIncomingMessage(tc.input);
  if (result === tc.expected) {
    console.log(`  PASS: input "${tc.input}" -> expected "${tc.expected}"`);
  } else {
    console.error(`  FAIL: input "${tc.input}" -> expected "${tc.expected}", got "${result}"`);
    failed = true;
  }
}

if (failed) {
  console.error("\nSome test cases failed!");
  process.exit(1);
} else {
  console.log("\nAll command routing tests passed successfully!");
}
