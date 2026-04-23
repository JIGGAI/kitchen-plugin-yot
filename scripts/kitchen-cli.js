#!/usr/bin/env node

/**
 * Kitchen Plugin CLI Commands
 *
 * Usage:
 *   npx kitchen-plugin-yot add <plugin-name>
 *   npx kitchen-plugin-yot remove <plugin-name>
 *   npx kitchen-plugin-yot list
 *   npx kitchen-plugin-yot status
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findKitchenDir() {
  const possiblePaths = [
    path.join(process.cwd(), 'clawkitchen'),
    path.join(process.cwd()),
    path.join(process.env.HOME, 'clawkitchen'),
    '/home/control/clawkitchen',
  ];

  for (const dir of possiblePaths) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'clawkitchen' || pkg.name === 'kitchen' || pkg.kitchenPlugin === true) {
        return dir;
      }
    }
  }

  return null;
}

function getInstalledPlugins(kitchenDir) {
  try {
    const packageJsonPath = path.join(kitchenDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const plugins = [];
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const [name, version] of Object.entries(deps)) {
      if (name.startsWith('kitchen-plugin-') || name.includes('kitchen-plugin')) {
        plugins.push({ name, version: version.replace(/[\^~]/, '') });
      }
    }

    return plugins;
  } catch {
    return [];
  }
}

async function addPlugin(pluginName) {
  const kitchenDir = findKitchenDir();
  if (!kitchenDir) {
    console.error('❌ ClawKitchen directory not found');
    console.error('Run this command from your ClawKitchen project directory');
    process.exit(1);
  }

  console.log(`📦 Installing plugin: ${pluginName}`);
  console.log(`📁 Kitchen directory: ${kitchenDir}`);

  try {
    process.chdir(kitchenDir);
    execSync(`npm install ${pluginName}`, { stdio: 'inherit' });

    console.log('✅ Plugin installed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Rebuild ClawKitchen: npm run build');
    console.log('2. Restart gateway: openclaw gateway restart');
    console.log('3. Check plugin status: npx kitchen-plugin-yot status');
  } catch (error) {
    console.error('❌ Failed to install plugin:', error.message);
    process.exit(1);
  }
}

async function removePlugin(pluginName) {
  const kitchenDir = findKitchenDir();
  if (!kitchenDir) {
    console.error('❌ ClawKitchen directory not found');
    process.exit(1);
  }

  console.log(`🗑️ Removing plugin: ${pluginName}`);

  try {
    process.chdir(kitchenDir);
    execSync(`npm uninstall ${pluginName}`, { stdio: 'inherit' });

    console.log('✅ Plugin removed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Rebuild ClawKitchen: npm run build');
    console.log('2. Restart gateway: openclaw gateway restart');
  } catch (error) {
    console.error('❌ Failed to remove plugin:', error.message);
    process.exit(1);
  }
}

function listPlugins() {
  const kitchenDir = findKitchenDir();
  if (!kitchenDir) {
    console.error('❌ ClawKitchen directory not found');
    process.exit(1);
  }

  console.log('📋 Installed Kitchen Plugins:');
  console.log('');

  const plugins = getInstalledPlugins(kitchenDir);

  if (plugins.length === 0) {
    console.log('   No kitchen plugins found');
    console.log('');
    console.log('💡 Install a plugin with:');
    console.log('   npx kitchen-plugin-yot add @jiggai/kitchen-plugin-yot');
    return;
  }

  plugins.forEach(plugin => {
    console.log(`   ✓ ${plugin.name} (${plugin.version})`);
  });

  console.log('');
  console.log(`📁 Kitchen directory: ${kitchenDir}`);
}

function showStatus() {
  const kitchenDir = findKitchenDir();
  if (!kitchenDir) {
    console.error('❌ ClawKitchen directory not found');
    process.exit(1);
  }

  console.log('📊 Kitchen Plugin System Status:');
  console.log('');

  const plugins = getInstalledPlugins(kitchenDir);
  console.log(`📦 Plugins installed: ${plugins.length}`);
  console.log(`📁 Kitchen directory: ${kitchenDir}`);

  const buildExists = fs.existsSync(path.join(kitchenDir, '.next'));
  console.log(`🏗️  Kitchen built: ${buildExists ? 'Yes' : 'No'}`);

  try {
    execSync('openclaw health', { stdio: 'pipe' });
    console.log('🟢 Gateway: Running');
  } catch {
    console.log('🔴 Gateway: Not running');
  }

  if (plugins.length > 0) {
    console.log('');
    console.log('Installed plugins:');
    plugins.forEach(plugin => {
      console.log(`   • ${plugin.name}`);
    });
  }
}

function showHelp() {
  console.log('🍳 Kitchen Plugin Manager (YOT)');
  console.log('');
  console.log('Commands:');
  console.log('  add <plugin>     Install a kitchen plugin');
  console.log('  remove <plugin>  Remove a kitchen plugin');
  console.log('  list             List installed plugins');
  console.log('  status           Show system status');
  console.log('  help             Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  npx kitchen-plugin-yot add @jiggai/kitchen-plugin-yot');
  console.log('  npx kitchen-plugin-yot remove @jiggai/kitchen-plugin-yot');
  console.log('  npx kitchen-plugin-yot list');
  console.log('  npx kitchen-plugin-yot status');
}

const [, , command, ...args] = process.argv;

switch (command) {
  case 'add':
    if (!args[0]) {
      console.error('❌ Plugin name required');
      console.error('Usage: npx kitchen-plugin-yot add <plugin-name>');
      process.exit(1);
    }
    addPlugin(args[0]);
    break;

  case 'remove':
    if (!args[0]) {
      console.error('❌ Plugin name required');
      console.error('Usage: npx kitchen-plugin-yot remove <plugin-name>');
      process.exit(1);
    }
    removePlugin(args[0]);
    break;

  case 'list':
    listPlugins();
    break;

  case 'status':
    showStatus();
    break;

  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;

  default:
    console.error('❌ Unknown command:', command);
    showHelp();
    process.exit(1);
}
