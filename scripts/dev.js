#!/usr/bin/env node

console.log('Starting development mode for kitchen-plugin-yot...');
console.log('Watching src/ for changes...');
console.log('Press Ctrl+C to stop');
console.log('');
console.log('Development tips:');
console.log('- Run `npm run build` after making changes');
console.log('- Restart ClawKitchen gateway to pick up plugin changes');
console.log('- Check plugin status with `openclaw plugins list`');
console.log('- View plugin logs in ClawKitchen UI or gateway logs');

process.stdin.resume();
