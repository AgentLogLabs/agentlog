import { expect } from 'chai';
import { commands } from 'vscode';

describe('AgentLog Extension UI Tests', () => {
  it('should register agentlog.openDashboard command', async () => {
    const registeredCommands = await commands.getCommands(true);
    const hasCommand = registeredCommands.some(cmd => cmd === 'agentlog.openDashboard');
    expect(hasCommand).to.be.true;
  });

  it('should register agentlog.startBackend command', async () => {
    const registeredCommands = await commands.getCommands(true);
    const hasCommand = registeredCommands.some(cmd => cmd === 'agentlog.startBackend');
    expect(hasCommand).to.be.true;
  });

  it('should open dashboard command without error', async () => {
    await commands.executeCommand('agentlog.openDashboard');
    expect(true).to.be.true;
  });

  it('should show backend status command', async () => {
    await commands.executeCommand('agentlog.showBackendStatus');
    expect(true).to.be.true;
  });
});
