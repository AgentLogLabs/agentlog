import { runTests } from '@vscode/test-electron';
import { join } from 'path';

async function main() {
  try {
    const extRoot = join(__dirname, '..', '..');
    const extensionDevelopmentPath = extRoot;
    const extensionTestsPath = join(extRoot, 'test', 'dist', 'suite');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-updates',
        '--user-data-dir=/tmp/agentlog-test-user-data'
      ],
      extensionTestsEnv: {
        AGENTLOG_TEST_MODE: 'true'
      }
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
