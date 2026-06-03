import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const meshbotScript = join(rootDir, 'bin', 'meshbot.mjs');

console.log("--------------------------------------------------");
console.log("      Starting MeshBot CLI Interface Tests        ");
console.log("--------------------------------------------------");

function runCliCmd(args) {
  return new Promise((resolve, reject) => {
    exec(`node "${meshbotScript}" ${args}`, { cwd: rootDir }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

async function startTests() {
  let failed = false;

  // Test 1: Help command
  try {
    console.log("Testing: meshbot help");
    const { stdout } = await runCliCmd("help");
    if (stdout.includes("MeshBot Command-Line Interface") && stdout.includes("start") && stdout.includes("weather")) {
      console.log("  PASS: Help command printed correct usage.");
    } else {
      console.error(`  FAIL: Unexpected help output:\n${stdout}`);
      failed = true;
    }
  } catch (err) {
    console.error("  FAIL: Help command crashed:", err.message);
    failed = true;
  }

  // Test 2: List command
  try {
    console.log("\nTesting: meshbot list");
    const { stdout } = await runCliCmd("list");
    if (stdout.includes("Enabled modules:") && stdout.includes("weather") && stdout.includes("testing")) {
      console.log("  PASS: List command correctly reported enabled modules.");
    } else {
      console.error(`  FAIL: Unexpected list output:\n${stdout}`);
      failed = true;
    }
  } catch (err) {
    console.error("  FAIL: List command crashed:", err.message);
    failed = true;
  }

  // Test 3: Invalid command
  try {
    console.log("\nTesting: meshbot invalid_command_name");
    await runCliCmd("invalid_command_name");
    console.error("  FAIL: Invalid command did not return exit code 1.");
    failed = true;
  } catch (err) {
    if (err.message.includes("Unknown command")) {
      console.log("  PASS: Invalid command returned error code and message correctly.");
    } else {
      console.error("  FAIL: Invalid command returned unexpected error:", err.message);
      failed = true;
    }
  }

  console.log("\n--------------------------------------------------");
  if (failed) {
    console.error("MeshBot CLI verification FAILED!");
    process.exit(1);
  } else {
    console.log("All MeshBot CLI verification tests PASSED successfully!");
    process.exit(0);
  }
}

startTests().catch(err => {
  console.error("CLI test execution failure:", err);
  process.exit(1);
});
