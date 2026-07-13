const fs = require('fs');
const version = '1.1.0';
const content = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
const lines = content.split('\n');
let capturing = false;
let notes = [];
for (let line of lines) {
  if (line.startsWith('## [')) {
    if (line.includes('[' + version + ']')) {
      capturing = true;
      continue;
    } else if (capturing) {
      break;
    }
  }
  if (capturing) {
    notes.push(line);
  }
}
console.log(notes.join('\n').trim() || 'NOT FOUND');
