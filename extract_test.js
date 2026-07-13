const fs = require('fs');
const version = '1.1.0';
const content = fs.readFileSync('CHANGELOG.md', 'utf8');
const regex = new RegExp(String.raw^## \[ + version + String.raw\](?: - .*)?\n(?<notes>.*?)(?=\n## \[\s*|$), 'ms');
const match = content.match(regex);
console.log(match ? match.groups.notes.trim() : 'NOT FOUND');
